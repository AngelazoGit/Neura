#!/usr/bin/env node
// NEURA BRIDGE — servidor MCP (Streamable HTTP) que expone la IA local de este
// equipo (Ollama, LM Studio, llama.cpp, vLLM o cualquier API compatible con
// OpenAI) a la app Neura u otro cliente MCP. Sin dependencias: Node 18+.
import http from 'node:http';
import os from 'node:os';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, normalize, dirname, sep, resolve, relative, isAbsolute, basename } from 'node:path';
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
// Carpetas que la IA puede leer (solo lectura). Sin carpetas, las herramientas de archivos no existen.
const FOLDERS = (() => {
  let list = cfg.folders || [];
  if (process.env.NEURA_FOLDERS) try { list = JSON.parse(process.env.NEURA_FOLDERS); } catch { console.error('NEURA_FOLDERS no es JSON válido'); }
  const used = new Set();
  return (Array.isArray(list) ? list : []).flatMap((p) => {
    let root;
    try { root = realpathSync(String(p)); if (!statSync(root).isDirectory()) throw new Error(); }
    catch { console.error(`  Carpeta ignorada (no existe): ${p}`); return []; }
    let name = basename(root) || 'raiz', n = 1;
    while (used.has(name)) name = `${basename(root) || 'raiz'}-${++n}`;
    used.add(name);
    return [{ name, root }];
  });
})();
const EMBED_MODEL = cfg.embedModel || process.env.NEURA_EMBED_MODEL || 'nomic-embed-text';
const BACKENDS = cfg.backends?.length ? cfg.backends : [
  { id: 'ollama', type: 'ollama', url: process.env.OLLAMA_URL || 'http://127.0.0.1:11434' },
  { id: 'lmstudio', type: 'openai', url: 'http://127.0.0.1:1234/v1' },
];

// ---------- backends ----------
const trim = (u) => u.replace(/\/+$/, '');
const headers = (b) => ({ 'Content-Type': 'application/json', ...(b.apiKey ? { Authorization: `Bearer ${b.apiKey}` } : {}) });

// Señal que se corta por tiempo o cuando el cliente se desconecta.
function signalFor(ms, extra) {
  const t = AbortSignal.timeout(ms);
  if (!extra) return t;
  if (AbortSignal.any) return AbortSignal.any([t, extra]);
  const c = new AbortController();
  for (const s of [t, extra]) s.addEventListener('abort', () => c.abort(s.reason), { once: true });
  return c.signal;
}

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: signalFor(opts.timeout || TIMEOUT, opts.signal) });
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
// Partes admitidas en formato OpenAI: texto e imágenes (data: URL o https).
const parts = (c) => (Array.isArray(c) ? c : []).flatMap((p) =>
  p?.type === 'text' ? [{ type: 'text', text: String(p.text ?? '') }]
  : p?.type === 'image_url' && typeof p.image_url?.url === 'string' ? [{ type: 'image_url', image_url: { url: p.image_url.url } }] : []);
const b64 = (url) => url.match(/^data:[^;,]+;base64,(.*)$/s)?.[1];

function backendFor(model) {
  if (typeof model !== 'string' || !model.includes('/')) throw new Error('model debe tener formato backend/modelo (usa list_models)');
  const i = model.indexOf('/');
  const b = BACKENDS.find((x) => x.id === model.slice(0, i));
  if (!b) throw new Error(`Backend desconocido: ${model.slice(0, i)}`);
  return [b, model.slice(i + 1)];
}

// Lee un cuerpo en streaming línea a línea (NDJSON de Ollama o SSE de OpenAI).
async function* lines(r) {
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k).trim(); buf = buf.slice(k + 1); if (l) yield l; }
  }
  if (buf.trim()) yield buf.trim();
}

// Una vuelta contra el backend. Devuelve texto, llamadas a herramientas y uso.
async function round(b, name, msgs, { tools, onDelta, signal, temperature, max_tokens }) {
  const stream = !!onDelta;
  const toolCalls = [];
  let text = '', usage = null;
  if (b.type === 'ollama') {
    const options = {};
    if (temperature != null) options.temperature = temperature;
    if (max_tokens != null) options.num_predict = max_tokens;
    const body = JSON.stringify({ model: name, messages: msgs, stream, options, ...(tools ? { tools } : {}) });
    if (!stream) {
      const d = await getJSON(`${trim(b.url)}/api/chat`, { method: 'POST', headers: headers(b), body, signal });
      for (const tc of d.message?.tool_calls || []) toolCalls.push({ name: tc.function?.name, arguments: tc.function?.arguments || {}, raw: tc });
      return { text: d.message?.content ?? '', toolCalls, usage: { prompt_tokens: d.prompt_eval_count ?? null, completion_tokens: d.eval_count ?? null } };
    }
    const r = await fetch(`${trim(b.url)}/api/chat`, { method: 'POST', headers: headers(b), body, signal: signalFor(TIMEOUT, signal) });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    for await (const l of lines(r)) {
      let d; try { d = JSON.parse(l); } catch { continue; }
      if (d.error) throw new Error(String(d.error));
      const c = d.message?.content;
      if (c) { text += c; onDelta(c); }
      for (const tc of d.message?.tool_calls || []) toolCalls.push({ name: tc.function?.name, arguments: tc.function?.arguments || {}, raw: tc });
      if (d.done) usage = { prompt_tokens: d.prompt_eval_count ?? null, completion_tokens: d.eval_count ?? null };
    }
    return { text, toolCalls, usage };
  }
  const req = { model: name, messages: msgs, stream, ...(tools ? { tools } : {}) };
  if (temperature != null) req.temperature = temperature;
  if (max_tokens != null) req.max_tokens = max_tokens;
  if (!stream) {
    const d = await getJSON(`${trim(b.url)}/chat/completions`, { method: 'POST', headers: headers(b), body: JSON.stringify(req), signal });
    const m = d.choices?.[0]?.message || {};
    for (const tc of m.tool_calls || []) toolCalls.push({ id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments || '{}' });
    return { text: asText(m.content), toolCalls, usage: d.usage ?? null };
  }
  const r = await fetch(`${trim(b.url)}/chat/completions`, { method: 'POST', headers: headers(b), body: JSON.stringify(req), signal: signalFor(TIMEOUT, signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  const acc = [];
  for await (const l of lines(r)) {
    if (!l.startsWith('data:')) continue;
    const raw = l.slice(5).trim();
    if (raw === '[DONE]') break;
    let d; try { d = JSON.parse(raw); } catch { continue; }
    if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
    if (d.usage) usage = d.usage;
    const delta = d.choices?.[0]?.delta || {};
    if (delta.content) { text += delta.content; onDelta(delta.content); }
    for (const tc of delta.tool_calls || []) {
      const t = (acc[tc.index ?? 0] ||= { id: '', name: '', arguments: '' });
      if (tc.id) t.id = tc.id;
      if (tc.function?.name) t.name += tc.function.name;
      if (tc.function?.arguments) t.arguments += tc.function.arguments;
    }
  }
  toolCalls.push(...acc.filter(Boolean));
  return { text, toolCalls, usage };
}

const MAX_ROUNDS = 6;
async function chat({ model, messages, system, temperature, max_tokens, tools }, ctx = {}) {
  const [b, name] = backendFor(model);
  if (!Array.isArray(messages) || !messages.length) throw new Error('messages vacío');
  const msgs = [
    ...(system ? [{ role: 'system', content: system }] : []),
    ...messages.map((m) => {
      const role = ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user';
      if (!Array.isArray(m.content)) return { role, content: asText(m.content) };
      const ps = parts(m.content);
      if (b.type !== 'ollama') return { role, content: ps };
      const images = ps.filter((p) => p.type === 'image_url').map((p) => b64(p.image_url.url)).filter(Boolean);
      return { role, content: asText(ps), ...(images.length ? { images } : {}) };
    }),
  ];
  const t0 = Date.now();
  const opts = { signal: ctx.signal, temperature, max_tokens };
  const useTools = tools === true && FOLDERS.length > 0;
  if (!useTools) {
    const r = await round(b, name, msgs, { ...opts, onDelta: ctx.onDelta });
    return { text: r.text, model, ms: Date.now() - t0, usage: r.usage };
  }
  // Bucle de agente: el modelo local puede leer las carpetas compartidas antes de responder.
  const defs = CHAT_TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const tool_log = [];
  let usage = null;
  for (let n = 0; n <= MAX_ROUNDS; n++) {
    const last = n === MAX_ROUNDS; // última vuelta: sin herramientas, para forzar una respuesta
    const r = await round(b, name, msgs, { ...opts, tools: last ? undefined : defs });
    usage = r.usage;
    if (last || !r.toolCalls.length) {
      if (ctx.onDelta && r.text) ctx.onDelta(r.text);
      return { text: r.text, model, ms: Date.now() - t0, usage, tool_log };
    }
    if (b.type === 'ollama') msgs.push({ role: 'assistant', content: r.text, tool_calls: r.toolCalls.map((t) => t.raw) });
    else msgs.push({ role: 'assistant', content: r.text || null, tool_calls: r.toolCalls.map((t, k) => ({ id: t.id || `call_${n}_${k}`, type: 'function', function: { name: t.name, arguments: t.arguments } })) });
    for (const [k, t] of r.toolCalls.entries()) {
      let args = t.arguments, out, ok = true;
      try {
        if (typeof args === 'string') args = args.trim() ? JSON.parse(args) : {};
        const fn = TOOL_IMPL[t.name];
        if (!fn) throw new Error(`Herramienta desconocida: ${t.name}`);
        out = JSON.stringify(await fn(args || {}));
      } catch (e) { ok = false; out = `Error: ${e.message}`; }
      tool_log.push({ name: t.name, arguments: args, ok });
      const content = out.length > 20000 ? out.slice(0, 20000) + '…' : out;
      msgs.push(b.type === 'ollama' ? { role: 'tool', tool_name: t.name, content } : { role: 'tool', tool_call_id: t.id || `call_${n}_${k}`, content });
    }
  }
}

// ---------- carpetas compartidas (solo lectura) ----------
const TEXT_EXT = new Set(('txt md markdown csv tsv json jsonl js mjs cjs ts tsx jsx py html htm css scss xml yml yaml ini toml cfg conf log sql ' +
  'java kt c cpp cc h hpp cs go rs php rb sh bash zsh bat cmd ps1 tex rtf srt vtt env properties gradle swift dart lua r m vue svelte').split(' ').map((e) => '.' + e));
const MAX_READ = 2 * 2 ** 20;
const MAX_WALK = 5000;
const skipName = (n) => n.startsWith('.') || n === 'node_modules';
const inside = (root, p) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const shown = (f, full) => [f.name, ...relative(f.root, full).split(sep).filter(Boolean)].join('/');

// Convierte "carpeta/ruta/archivo" en una ruta real, sin salir nunca de la carpeta compartida.
function resolveShared(p, { allowRoot = true } = {}) {
  if (typeof p !== 'string' || !p.trim()) throw new Error('path vacío');
  const clean = p.replace(/\\/g, '/').trim();
  if (isAbsolute(clean) || /^[a-zA-Z]:/.test(clean) || clean.startsWith('/')) throw new Error('Usa rutas relativas: carpeta/ruta (ver list_dir)');
  const segs = clean.split('/').filter((x) => x && x !== '.');
  if (segs.some((x) => x === '..' || skipName(x))) throw new Error('Ruta no permitida');
  const f = FOLDERS.find((x) => x.name === segs[0]);
  if (!f) throw new Error(`Carpeta desconocida: ${segs[0]} (ver list_dir)`);
  if (segs.length === 1 && !allowRoot) throw new Error('Indica un archivo dentro de la carpeta');
  const full = resolve(f.root, ...segs.slice(1));
  if (!inside(f.root, full)) throw new Error('Ruta no permitida');
  let real;
  try { real = realpathSync(full); } catch { throw new Error(`No existe: ${clean}`); }
  if (!inside(f.root, real)) throw new Error('Ruta no permitida');
  return { f, full: real };
}

function isText(file, size) {
  if (size > MAX_READ) return false;
  if (TEXT_EXT.has(extname(file).toLowerCase())) return true;
  try {
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(Math.min(4096, size));
    const n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
    return n > 0 && !buf.subarray(0, n).includes(0);
  } catch { return false; }
}

// Recorre los archivos de las carpetas compartidas (sin ocultos ni node_modules ni enlaces que salgan fuera).
function* walk(limit = MAX_WALK) {
  let count = 0;
  for (const f of FOLDERS) {
    const stack = [f.root], seen = new Set();
    while (stack.length) {
      const dir = stack.pop();
      if (seen.has(dir)) continue;
      seen.add(dir);
      let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (skipName(e.name)) continue;
        let full = join(dir, e.name), st;
        try {
          if (e.isSymbolicLink()) { full = realpathSync(full); if (!inside(f.root, full)) continue; }
          st = statSync(full);
        } catch { continue; }
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile()) {
          if (++count > limit) return;
          yield { f, full, path: shown(f, full), size: st.size, mtime: st.mtimeMs };
        }
      }
    }
  }
}

function listDir({ path } = {}) {
  if (!path) return { entries: FOLDERS.map((f) => ({ name: f.name, type: 'dir' })) };
  const { f, full } = resolveShared(path);
  if (!statSync(full).isDirectory()) throw new Error('No es una carpeta');
  const entries = [];
  for (const e of readdirSync(full, { withFileTypes: true })) {
    if (skipName(e.name)) continue;
    let p = join(full, e.name), st;
    try { const real = realpathSync(p); if (!inside(f.root, real)) continue; st = statSync(real); } catch { continue; }
    entries.push({ name: e.name, type: st.isDirectory() ? 'dir' : 'file', size: st.isDirectory() ? null : st.size, mtime: new Date(st.mtimeMs).toISOString() });
    if (entries.length >= 500) break;
  }
  return { path: shown(f, full), entries };
}

function searchFiles({ query, max = 20 } = {}) {
  const q = String(query ?? '').toLowerCase().trim();
  if (!q) throw new Error('query vacío');
  max = Math.min(Math.max(1, Number(max) || 20), 200);
  const results = [];
  for (const file of walk()) {
    if (results.length >= max) break;
    if (basename(file.full).toLowerCase().includes(q)) { results.push({ path: file.path, line: 0, snippet: basename(file.full) }); continue; }
    if (!isText(file.full, file.size)) continue;
    let text; try { text = readFileSync(file.full, 'utf8'); } catch { continue; }
    if (!text.toLowerCase().includes(q)) continue;
    const ls = text.split(/\r?\n/);
    let hits = 0;
    for (let k = 0; k < ls.length && hits < 3 && results.length < max; k++) {
      if (ls[k].toLowerCase().includes(q)) { results.push({ path: file.path, line: k + 1, snippet: ls[k].trim().slice(0, 200) }); hits++; }
    }
  }
  return { results };
}

function readFile({ path, offset = 1, limit = 400 } = {}) {
  const { f, full } = resolveShared(path, { allowRoot: false });
  const st = statSync(full);
  if (!st.isFile()) throw new Error('No es un archivo');
  if (st.size > MAX_READ) throw new Error('Archivo demasiado grande (máx. 2 MB)');
  if (!isText(full, st.size)) throw new Error('No es un archivo de texto');
  const ls = readFileSync(full, 'utf8').split(/\r?\n/);
  const from = Math.max(1, Number(offset) || 1), n = Math.max(1, Number(limit) || 400);
  let text = ls.slice(from - 1, from - 1 + n).join('\n');
  let truncated = from - 1 + n < ls.length;
  if (Buffer.byteLength(text) > 100 * 1024) { text = Buffer.from(text).subarray(0, 100 * 1024).toString('utf8'); truncated = true; }
  return { path: shown(f, full), text, total_lines: ls.length, truncated };
}

// ---------- búsqueda semántica (RAG) ----------
const indexFile = join(DATA_DIR, 'indice.json');
const MAX_CHUNKS = 3000, CHUNK = 1200, OVERLAP = 200;
let indexing = null;

function chunksOf(path, text) {
  const out = [];
  for (let k = 0; k < text.length && out.length < 200; k += CHUNK - OVERLAP) {
    const piece = text.slice(k, k + CHUNK).trim();
    if (piece) out.push(`${path}\n${piece}`);
    if (k + CHUNK >= text.length) break;
  }
  return out;
}

async function embed(inputs) {
  const b = BACKENDS.find((x) => x.type === 'ollama');
  if (!b) throw new Error('Sin backend Ollama para embeddings');
  const out = [];
  for (let k = 0; k < inputs.length; k += 32) {
    const d = await getJSON(`${trim(b.url)}/api/embed`, { method: 'POST', headers: headers(b), timeout: 120000,
      body: JSON.stringify({ model: EMBED_MODEL, input: inputs.slice(k, k + 32) }) });
    if (!Array.isArray(d.embeddings) || d.embeddings.length !== Math.min(32, inputs.length - k)) throw new Error('Respuesta de embeddings inválida');
    out.push(...d.embeddings.map((v) => v.map((x) => Math.round(x * 1e5) / 1e5)));
  }
  return out;
}

// Actualiza el índice: solo se vuelven a procesar los archivos que cambiaron.
async function buildIndex() {
  let idx;
  try { idx = JSON.parse(readFileSync(indexFile, 'utf8')); } catch { idx = null; }
  if (!idx || idx.model !== EMBED_MODEL) idx = { model: EMBED_MODEL, files: {} };
  const files = {}, todo = [];
  let total = 0;
  for (const file of walk()) {
    if (total >= MAX_CHUNKS) break;
    if (!isText(file.full, file.size)) continue;
    const old = idx.files[file.path];
    if (old && old.mtime === file.mtime && old.size === file.size && old.chunks.every((c) => c.vec)) {
      files[file.path] = old; total += old.chunks.length; continue;
    }
    let text; try { text = readFileSync(file.full, 'utf8'); } catch { continue; }
    const chunks = chunksOf(file.path, text).slice(0, MAX_CHUNKS - total).map((t) => ({ text: t, vec: null }));
    files[file.path] = { mtime: file.mtime, size: file.size, chunks };
    total += chunks.length;
    todo.push(...chunks);
  }
  idx.files = files;
  let embedError = null;
  if (todo.length) {
    try { const vecs = await embed(todo.map((c) => c.text)); todo.forEach((c, k) => { c.vec = vecs[k]; }); }
    catch (e) { embedError = e; }
  }
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(indexFile + '.tmp', JSON.stringify(idx));
  renameSync(indexFile + '.tmp', indexFile);
  return { idx, embedError };
}

const cosine = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let k = 0; k < a.length; k++) { d += a[k] * b[k]; na += a[k] * a[k]; nb += b[k] * b[k]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};
const terms = (t) => String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2);

async function searchDocs({ query, k = 5 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('query vacío');
  k = Math.min(Math.max(1, Number(k) || 5), 20);
  indexing ||= buildIndex().finally(() => { indexing = null; });
  const { idx, embedError } = await indexing;
  const all = Object.entries(idx.files).flatMap(([path, f]) => f.chunks.map((c) => ({ path, ...c })));
  if (!embedError && all.length && all.every((c) => c.vec)) {
    try {
      const [qv] = await embed([q]);
      const results = all.map((c) => ({ path: c.path, score: +cosine(qv, c.vec).toFixed(4), text: c.text }))
        .sort((a, b) => b.score - a.score).slice(0, k);
      return { mode: 'semantic', results };
    } catch { /* sin embeddings: búsqueda por palabras */ }
  }
  const qt = terms(q);
  const results = all.map((c) => {
    const words = terms(c.text);
    const score = words.length ? qt.reduce((s, t) => s + words.filter((w) => w === t || w.startsWith(t)).length, 0) / Math.sqrt(words.length) : 0;
    return { path: c.path, score: +score.toFixed(4), text: c.text };
  }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  return { mode: 'keyword', hint: `Instala el modelo de embeddings: ollama pull ${EMBED_MODEL}`, results };
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
  store.rev ||= 0; store.threads ||= {}; store.collections ||= {};
  return store;
}
function saveStore() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = storeFile + '.tmp';
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, storeFile); // escritura atómica: un corte de luz no deja el archivo a medias
}
const strip = ({ rev, ...t }) => t;

// Otras colecciones (habilidades, proyectos): objetos con id y updatedAt; gana el más reciente, también los borrados.
const COLLECTIONS = new Set(['skills', 'projects']);
async function threadsSync({ threads = [], collections = {}, since = 0 }) {
  if (!Array.isArray(threads)) throw new Error('threads debe ser una lista');
  const st = loadStore();
  let changed = false;
  for (const [name, items] of Object.entries(collections || {})) {
    if (!COLLECTIONS.has(name) || !Array.isArray(items)) continue;
    const col = (st.collections[name] ||= {});
    for (const it of items) {
      if (typeof it?.id !== 'string' || !it.id) continue;
      const cur = col[it.id];
      if (cur && (cur.updatedAt || 0) >= (it.updatedAt || 0)) continue;
      col[it.id] = { ...it, rev: ++st.rev };
      changed = true;
    }
  }
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
  const newer = (list) => Object.values(list).filter((t) => t.rev > (Number(since) || 0)).map(strip);
  const cols = Object.fromEntries(Object.entries(st.collections).map(([k, v]) => [k, newer(v)]));
  return { rev: st.rev, threads: newer(st.threads), collections: cols };
}

// ---------- MCP ----------
const FILE_TOOLS = FOLDERS.length ? [
  { name: 'list_dir', title: 'Listar carpeta',
    description: 'Lista las carpetas compartidas (sin path) o el contenido de una carpeta. Las rutas son carpeta/ruta/relativa.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'carpeta/subcarpeta; vacío = carpetas compartidas' } } } },
  { name: 'search_files', title: 'Buscar archivos',
    description: 'Busca texto en los nombres y el contenido de los archivos de las carpetas compartidas.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, max: { type: 'integer' } } } },
  { name: 'read_file', title: 'Leer archivo',
    description: 'Lee un archivo de texto de una carpeta compartida (por líneas).',
    inputSchema: { type: 'object', required: ['path'], properties: {
      path: { type: 'string', description: 'carpeta/ruta/archivo.txt' }, offset: { type: 'integer', description: 'línea inicial (1)' }, limit: { type: 'integer', description: 'número de líneas (400)' } } } },
  { name: 'search_docs', title: 'Buscar en tus documentos',
    description: 'Búsqueda por significado en los documentos de las carpetas compartidas. Devuelve los fragmentos más relevantes.',
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, k: { type: 'integer' } } } },
] : [];
const content = { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'object', properties: {
  type: { type: 'string', enum: ['text', 'image_url'] }, text: { type: 'string' },
  image_url: { type: 'object', properties: { url: { type: 'string' } } } } } }] };
const TOOLS = [
  { name: 'list_models', title: 'Listar modelos locales',
    description: 'Lista los modelos de IA disponibles en este equipo. Los ids tienen formato backend/modelo.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'chat', title: 'Conversar con un modelo local',
    description: 'Envía una conversación a un modelo local y devuelve la respuesta en texto.',
    inputSchema: { type: 'object', required: ['model', 'messages'], properties: {
      model: { type: 'string', description: 'id backend/modelo devuelto por list_models' },
      messages: { type: 'array', items: { type: 'object', required: ['role', 'content'], properties: {
        role: { type: 'string', enum: ['system', 'user', 'assistant'] }, content } } },
      system: { type: 'string' }, temperature: { type: 'number' }, max_tokens: { type: 'integer' },
      ...(FOLDERS.length ? { tools: { type: 'boolean', description: 'Deja que el modelo use las carpetas compartidas antes de responder' } } : {}) } } },
  { name: 'system_info', title: 'Estado del equipo',
    description: 'CPU, memoria, carga y estado de los backends de IA de este equipo.',
    inputSchema: { type: 'object', properties: {} } },
  ...(SYNC ? [{ name: 'threads_sync', title: 'Sincronizar hilos',
    description: 'Guarda en este equipo los hilos de chat (y las colecciones skills y projects) y devuelve lo que cambió desde la revisión since.',
    inputSchema: { type: 'object', properties: {
      threads: { type: 'array', items: { type: 'object' } },
      collections: { type: 'object', description: '{ skills: [...], projects: [...] }; cada elemento con id y updatedAt' },
      since: { type: 'integer' } } } }] : []),
  ...FILE_TOOLS,
];
const TOOL_IMPL = { list_dir: listDir, search_files: searchFiles, read_file: readFile, search_docs: searchDocs, system_info: systemInfo };
const CHAT_TOOLS = [...FILE_TOOLS, TOOLS.find((t) => t.name === 'system_info')];
const IMPL = { list_models: listModels, chat, system_info: systemInfo, ...(SYNC ? { threads_sync: threadsSync } : {}),
  ...(FOLDERS.length ? { list_dir: listDir, search_files: searchFiles, read_file: readFile, search_docs: searchDocs } : {}) };

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

// chat en streaming (Streamable HTTP): notificaciones de progreso con cada trozo de texto
// en params.message y, al final, la respuesta JSON-RPC normal.
const wantsStream = (req, p) => !Array.isArray(p) && p?.jsonrpc === '2.0' && p.id !== undefined && p.method === 'tools/call'
  && p.params?.name === 'chat' && p.params?._meta?.progressToken != null && /text\/event-stream/.test(String(req.headers.accept || ''));

async function streamChat(res, { id, params }) {
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); }); // el cliente cortó: se para el modelo
  const event = (obj) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  let n = 0;
  const onDelta = (message) => { if (message) event({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: params._meta.progressToken, progress: ++n, message } }); };
  let result;
  try {
    const data = await chat(params.arguments || {}, { onDelta, signal: ctl.signal });
    result = { content: [{ type: 'text', text: data.text }], structuredContent: data };
  } catch (e) {
    result = { content: [{ type: 'text', text: `Error: ${e.cause?.code || e.message}` }], isError: true };
  }
  event({ jsonrpc: '2.0', id, result });
  res.end();
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
    if (wantsStream(req, payload)) return streamChat(res, payload);
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
  for (const f of FOLDERS) console.log(`  Carpeta compartida (solo lectura): ${f.name} → ${f.root}`);
  console.log(`  Backends: ${BACKENDS.map((b) => `${b.id}→${b.url}`).join(', ')}`);
  if (TOKEN_GENERATED) console.log(`  TOKEN: ${TOKEN}\n         (generado al azar; fija uno propio con NEURA_TOKEN para que no cambie)`);
  console.log('');
});
