#!/usr/bin/env node
// NEURA BRIDGE — servidor MCP (Streamable HTTP) que expone la IA local de este
// equipo (Ollama, LM Studio, llama.cpp, vLLM o cualquier API compatible con
// OpenAI) a la app Neura u otro cliente MCP. Sin dependencias: Node 18+.
import http from 'node:http';
import os from 'node:os';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, extname, normalize, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.NEURA_CONFIG || join(HERE, 'config.json');
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || cfg.port || 8787);
const HOST = process.env.HOST || cfg.host || '0.0.0.0';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
// Seguro por defecto: si escucha en la red sin token, se genera uno aleatorio en cada arranque.
const TOKEN = process.env.NEURA_TOKEN || cfg.token || (LOOPBACK ? '' : randomBytes(18).toString('base64url'));
const TOKEN_GENERATED = !process.env.NEURA_TOKEN && !cfg.token && !!TOKEN;
const TIMEOUT = Number(cfg.timeoutMs || 300000);
const APP_DIR = cfg.appDir || join(HERE, '..', 'app');
const SERVE_APP = cfg.serveApp !== false && existsSync(join(APP_DIR, 'index.html'));
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// Hilos sincronizados entre la app del PC, el móvil y la web (ver threads_sync).
const DATA_DIR = process.env.NEURA_DATA || cfg.dataDir || join(os.homedir(), '.neura-bridge');
const SYNC = cfg.sync !== false;
const BACKENDS = cfg.backends?.length ? cfg.backends : [
  { id: 'ollama', type: 'ollama', url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434' },
  { id: 'lmstudio', type: 'openai', url: 'http://127.0.0.1:1234/v1' },
];

// ---------- backends ----------
const trim = (u) => u.replace(/\/+$/, '');
const headers = (b) => ({ 'Content-Type': 'application/json', ...(b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {}) });

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout || TIMEOUT) });
  const t = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${t.slice(0, 300)}`);
  return t ? JSON.parse(t) : {};
}

async function backendModels(b) {
  if (Array.isArray(b.models)) return b.models;
  if (b.type === 'ollama') {
    const d = await getJSON(`${trim(b.url)}/api/tags`, { timeout: 5000 });
    return (d.models || []).map((m) => m.name);
  }
  const d = await getJSON(`${trim(b.url)}/models`, { headers: headers(b), timeout: 5000 });
  return (d.data || []).map((m) => m.id);
}

async function listModels() {
  const backends = await Promise.all(BACKENDS.map(async (b) => {
    try {
      const names = await backendModels(b);
      return { id: b.id, type: b.type, url: b.url, online: true, models: names };
    } catch (e) {
      return { id: b.id, type: b.type, url: b.url, online: false, error: e.cause?.code || e.message, models: [] };
    }
  }));
  const models = backends.flatMap((b) => b.models.map((name) => ({ id: `${b.id}/${name}`, backend: b.id, name })));
  return { models, backends: backends.map(({ models: m, ...rest }) => ({ ...rest, count: m.length })) };
}

const asText = (c) => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => p?.text ?? '').join('') : String(c ?? '');

async function chat({ model, messages, system, temperature, max_tokens }) {
  if (typeof model !== 'string' || !model.includes('/')) throw new Error('model debe tener formato backend/modelo (usa list_models)');
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages vacío');
  const i = model.indexOf('/');
  const b = BACKENDS.find((x) => x.id === model.slice(0, i));
  if (!b) throw new Error(`Backend desconocido: ${model.slice(0, i)}`);
  const name = model.slice(i + 1);
  const msgs = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages.map((m) => ({ role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user', content: asText(m.content) })),
  ];
  const t0 = Date.now();
  if (b.type === 'ollama') {
    const options = {};
    if (temperature != null) options.temperature = temperature;
    if (max_tokens != null) options.num_predict = max_tokens;
    const d = await getJSON(`${trim(b.url)}/api/chat`, {
      method: 'POST', headers: headers(b),
      body: JSON.stringify({ model: name, messages: msgs, stream: false, options }),
    });
    return { text: d.message?.content ?? '', model, ms: Date.now() - t0,
      usage: { prompt_tokens: d.prompt_eval_count ?? null, completion_tokens: d.eval_count ?? null } };
  }
  const body = { model: name, messages: msgs, stream: false };
  if (temperature != null) body.temperature = temperature;
  if (max_tokens != null) body.max_tokens = max_tokens;
  const d = await getJSON(`${trim(b.url)}/chat/completions`, { method: 'POST', headers: headers(b), body: JSON.stringify(body) });
  return { text: asText(d.choices?.[0]?.message?.content), model, ms: Date.now() - t0, usage: d.usage ?? null };
}

async function systemInfo() {
  const cpus = os.cpus();
  return {
    hostname: os.hostname(), platform: `${os.platform()} ${os.release()}`, arch: os.arch(),
    cpu: `${cpus.length}× ${cpus[0]?.model ?? '?'}`,
    memory_gb: { total: +(os.totalmem() / 2 ** 30).toFixed(1), free: +(os.freemem() / 2 ** 30).toFixed(1) },
    load: os.loadavg().map((n) => +n.toFixed(2)), uptime_h: +(os.uptime() / 3600).toFixed(1),
    backends: (await listModels()).backends,
  };
}

// ---------- hilos ----------
// Fusión sin conflictos: los mensajes se unen por id y el resto de campos los gana
// la versión con ts (última actividad) más reciente. Mantener igual que mergeThread() en app/app.js.
function mergeThread(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [old, neu] = (b.ts || 0) > (a.ts || 0) ? [a, b] : [b, a];
  const byId = new Map();
  for (const m of [...(old.messages || []), ...(neu.messages || [])]) if (m?.id) byId.set(m.id, m);
  const messages = neu.deleted ? [] : [...byId.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
  return { ...old, ...neu, messages, ts: Math.max(a.ts || 0, b.ts || 0) };
}

const storeFile = join(DATA_DIR, 'hilos.json');
let store = null;
function loadStore() {
  if (store) return store;
  try { store = JSON.parse(readFileSync(storeFile, 'utf8')); } catch { store = {}; }
  store.rev ||= 0; store.threads ||= {};
  return store;
}
function saveStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = storeFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, storeFile); // escritura atómica: un corte de luz no deja el archivo a medias
}
const strip = ({ rev, ...t }) => t;

async function threadsSync({ threads = [], since = 0 }) {
  if (!Array.isArray(threads)) throw new Error('threads debe ser una lista');
  const st = loadStore();
  let changed = false;
  for (const t of threads) {
    if (typeof t?.id !== 'string' || !t.id) continue;
    const cur = st.threads[t.id];
    const merged = mergeThread(cur && strip(cur), t);
    if (!cur || JSON.stringify(merged) !== JSON.stringify(strip(cur))) {
      st.threads[t.id] = { ...merged, rev: ++st.rev };
      changed = true;
    }
  }
  if (changed) saveStore();
  const out = Object.values(st.threads).filter((t) => t.rev > (Number(since) || 0)).map(strip);
  return { rev: st.rev, threads: out };
}

// ---------- MCP ----------
const TOOLS = [
  { name: 'list_models', title: 'Listar modelos locales',
    description: 'Lista los modelos de IA disponibles en este equipo. Los ids tienen formato backend/modelo.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'chat', title: 'Conversar con un modelo local',
    description: 'Envía una conversación a un modelo local y devuelve la respuesta en texto.',
    inputSchema: { type: 'object', required: ['model', 'messages'], properties: {
      model: { type: 'string', description: 'id backend/modelo devuelto por list_models' },
      messages: { type: 'array', items: { type: 'object', required: ['role', 'content'], properties: {
        role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content: { type: 'string' } } } },
      system: { type: 'string' }, temperature: { type: 'number' }, max_tokens: { type: 'integer' } } } },
  { name: 'system_info', title: 'Estado del equipo',
    description: 'CPU, memoria, carga y estado de los backends de IA de este equipo.',
    inputSchema: { type: 'object', properties: {} } },
  ...(SYNC ? [{ name: 'threads_sync', title: 'Sincronizar hilos',
    description: 'Guarda en este equipo los hilos de chat enviados y devuelve los que cambiaron desde la revisión since.',
    inputSchema: { type: 'object', properties: {
      threads: { type: 'array', items: { type: 'object' } }, since: { type: 'integer' } } } }] : []),
];
const IMPL = { list_models: listModels, chat, system_info: systemInfo, ...(SYNC ? { threads_sync: threadsSync } : {}) };

async function rpc(msg, session) {
  const { id, method, params } = msg ?? {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (msg?.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'Invalid Request');
  if (id === undefined) return null; // notificación
  switch (method) {
    case 'initialize': {
      session.id = randomUUID();
      const v = PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0];
      return ok({ protocolVersion: v, capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'neura-bridge', title: `Neura Bridge @ ${os.hostname()}`, version: VERSION },
        instructions: 'Usa list_models para ver los modelos locales y chat para hablar con ellos.' });
    }
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      const fn = IMPL[params?.name];
      if (!fn) return err(-32602, `Herramienta desconocida: ${params?.name}`);
      try {
        const data = await fn(params.arguments || {});
        const text = typeof data.text === 'string' ? data.text : params.name === 'threads_sync'
          ? `rev ${data.rev} · ${data.threads.length} hilos` : JSON.stringify(data, null, 2);
        return ok({ content: [{ type: 'text', text }], structuredContent: data });
      } catch (e) {
        return ok({ content: [{ type: 'text', text: `Error: ${e.cause?.code || e.message}` }], isError: true });
      }
    }
    default: return err(-32601, `Método no encontrado: ${method}`);
  }
}

// ---------- HTTP ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function authorized(req) {
  if (!TOKEN) return true;
  const got = Buffer.from(String(req.headers.authorization || ''));
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

function readBody(req, limit = 25 * 2 ** 20) {
  return new Promise((res, rej) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { rej(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...CORS, ...(body != null ? { 'Content-Type': 'application/json' } : {}), ...extra });
  res.end(body != null ? JSON.stringify(body) : undefined);
}

function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = normalize(join(APP_DIR, path === '/' ? 'index.html' : path));
  if (!file.startsWith(normalize(APP_DIR) + sep) || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
}

const server = http.createServer((req, res) => handle(req, res).catch((e) => {
  // Una petición malformada nunca debe tumbar el servidor.
  if (!res.headersSent) send(res, e.message === 'too large' ? 413 : 400, { error: 'bad request' }); else res.destroy();
}));

async function handle(req, res) {
  if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
  const path = new URL(req.url, 'http://x').pathname;
  if (req.method === 'OPTIONS') return send(res, 204, null);
  if (path === '/health') return send(res, 200, { ok: true });

  if (path === '/mcp') {
    if (!authorized(req)) return send(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Token inválido' } });
    if (req.method === 'DELETE') return send(res, 200, null);
    if (req.method !== 'POST') return send(res, 405, null, { Allow: 'POST, DELETE, OPTIONS' });
    let payload;
    try { payload = JSON.parse(await readBody(req)); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const session = {};
    const batch = Array.isArray(payload);
    const out = (await Promise.all((batch ? payload : [payload]).map((m) => rpc(m, session)))).filter(Boolean);
    const extra = session.id ? { 'Mcp-Session-Id': session.id } : {};
    if (!out.length) return send(res, 202, null, extra);
    return send(res, 200, batch ? out : out[0], extra);
  }

  if (SERVE_APP && req.method === 'GET') return serveStatic(req, res);
  send(res, 404, { error: 'not found' });
}

server.listen(PORT, HOST, () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log(`\n  ⬡ NEURA BRIDGE v${VERSION} — ${os.hostname()}`);
  console.log(`  MCP:   http://localhost:${PORT}/mcp`);
  for (const ip of ips) console.log(`         http://${ip}:${PORT}/mcp`);
  if (SERVE_APP) console.log(`  APP:   http://${ips[0] || 'localhost'}:${PORT}/  (ábrela en el móvil)`);
  if (SYNC) console.log(`  Hilos: ${storeFile}`);
  console.log(`  Backends: ${BACKENDS.map((b) => `${b.id}→${b.url}`).join(', ')}`);
  if (TOKEN_GENERATED) console.log(`  TOKEN: ${TOKEN}\n         (generado al azar; fija uno propio con NEURA_TOKEN para que no cambie)`);
  console.log('');
});
