#!/usr/bin/env node
// NEURA BRIDGE — servidor MCP (Streamable HTTP) que expone la IA local de este
// equipo (Ollama, LM Studio, llama.cpp, vLLM o cualquier API compatible con
// OpenAI) a la app Neura u otro cliente MCP. Sin dependencias: Node 18+.
import http from 'node:http';
import os from 'node:os';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync, realpathSync, openSync, readSync, closeSync } from 'node:fs';
import { join, extname, normalize, dirname, sep, resolve, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const cfgPath = process.env.NEURA_CONFIG || join(HERE, 'config.json');
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) : {};

const VERSION = '1.0.0';
const PORT = Number(process.env.PORT || cfg.port || 8787);
const HOST = process.env.HOST || cfg.host || '0.0.0.0';
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
// Seguro por defecto: si escucha en la red sin token, se genera uno aleatorio en cada arranque.
// Siempre con token, también en 127.0.0.1: el puente responde a cualquier web (CORS) y sin token
// cualquier página abierta en este PC podría leer los hilos y las carpetas compartidas.
const TOKEN = process.env.NEURA_TOKEN || cfg.token || randomBytes(18).toString('base64url');
const TOKEN_GENERATED = !process.env.NEURA_TOKEN && !cfg.token && !!TOKEN;
// Token propio del Gateway: solo vale para /v1/* (modelos e inferencia). No da acceso a hilos, archivos ni configuración.
const GW_TOKEN = process.env.NEURA_GATEWAY_TOKEN || cfg.gatewayToken || randomBytes(18).toString('base64url');
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

// Generadores de imágenes en este equipo: AUTOMATIC1111 / Forge / SD.Next (API /sdapi) y ComfyUI.
// Se detectan en sus puertos habituales; en config.json, "images": [{ "id", "type": "a1111"|"comfyui", "url", "workflow"? }].
const IMAGES = (() => {
  let list = cfg.images;
  if (process.env.NEURA_IMAGES) try { list = JSON.parse(process.env.NEURA_IMAGES); } catch { console.error('NEURA_IMAGES no es JSON válido'); }
  return Array.isArray(list) ? list : [
    { id: 'forge', type: 'a1111', url: 'http://127.0.0.1:7860' },
    { id: 'comfyui', type: 'comfyui', url: 'http://127.0.0.1:8188' },
  ];
})();

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

// Backend local = corre en este equipo o en tu red privada (LAN, Tailscale). Se puede forzar con "local": true/false en config.
function isLocalBackend(b) {
  if (typeof b.local === 'boolean') return b.local;
  let h;
  try { h = new URL(b.url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  if (h === 'localhost' || h === '::1' || /\.(local|lan|home\.arpa|ts\.net)$/i.test(h)) return true;
  const ip = h.split('.').map(Number);
  if (ip.length !== 4 || ip.some((n) => !(n >= 0 && n <= 255))) return false;
  return ip[0] === 127 || ip[0] === 10 || (ip[0] === 192 && ip[1] === 168) || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127);
}
// Este mismo equipo (no otro ordenador de la red): lo que exige «solo modelos de este equipo».
function isThisMachine(b) {
  let h;
  try { h = new URL(b.url).hostname.replace(/^\[|\]$/g, ''); } catch { return false; }
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}
// ---------- imágenes ----------
async function imageStatus() {
  return Promise.all(IMAGES.map(async (g) => {
    try {
      if (g.type === 'comfyui') await getJSON(`${trim(g.url)}/system_stats`, { timeout: 3000 });
      else await getJSON(`${trim(g.url)}/sdapi/v1/sd-models`, { timeout: 3000 });
      return { id: g.id, type: g.type, online: true };
    } catch { return { id: g.id, type: g.type, online: false }; }
  }));
}
// Rellena %PROMPT%, %NEGATIVE%, %SEED%, %WIDTH%, %HEIGHT%, %STEPS% en un flujo de ComfyUI (formato API) propio.
function fillWorkflow(node, vars) {
  if (typeof node === 'string') {
    const m = node.match(/^%([A-Z]+)%$/);
    if (m && m[1] in vars) return vars[m[1]];
    return node.replace(/%([A-Z]+)%/g, (x, k) => (k in vars ? String(vars[k]) : x));
  }
  if (Array.isArray(node)) return node.map((x) => fillWorkflow(x, vars));
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fillWorkflow(v, vars)]));
  return node;
}
async function comfyGenerate(g, a, signal) {
  const base = trim(g.url);
  let wf;
  if (g.workflow) wf = fillWorkflow(JSON.parse(readFileSync(g.workflow, 'utf8')), { PROMPT: a.prompt, NEGATIVE: a.negative, SEED: a.seed, WIDTH: a.width, HEIGHT: a.height, STEPS: a.steps });
  else {
    // Flujo básico de texto a imagen con el primer modelo (checkpoint) instalado, o el de config.
    const info = await getJSON(`${base}/object_info/CheckpointLoaderSimple`, { timeout: 10000, signal });
    const ckpt = g.checkpoint || info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]?.[0];
    if (!ckpt) throw new Error('ComfyUI no tiene ningún modelo (checkpoint) instalado en models/checkpoints');
    wf = {
      3: { class_type: 'KSampler', inputs: { seed: a.seed, steps: a.steps, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] } },
      4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
      5: { class_type: 'EmptyLatentImage', inputs: { width: a.width, height: a.height, batch_size: 1 } },
      6: { class_type: 'CLIPTextEncode', inputs: { text: a.prompt, clip: ['4', 1] } },
      7: { class_type: 'CLIPTextEncode', inputs: { text: a.negative, clip: ['4', 1] } },
      8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      9: { class_type: 'SaveImage', inputs: { filename_prefix: 'neura', images: ['8', 0] } },
    };
    g = { ...g, model: ckpt };
  }
  const { prompt_id: id } = await getJSON(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'neura' }), timeout: 30000, signal });
  if (!id) throw new Error('ComfyUI no aceptó el flujo');
  const end = Date.now() + TIMEOUT;
  while (Date.now() < end) {
    if (signal?.aborted) throw new Error('Cancelado');
    const h = (await getJSON(`${base}/history/${encodeURIComponent(id)}`, { timeout: 10000, signal }))[id];
    if (h?.status?.status_str === 'error') throw new Error('ComfyUI falló al generar la imagen');
    const img = Object.values(h?.outputs || {}).flatMap((o) => o.images || [])[0];
    if (img) {
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
      const r = await fetch(`${base}/view?${q}`, { signal: signalFor(30000, signal) });
      if (!r.ok) throw new Error(`ComfyUI: HTTP ${r.status} al descargar la imagen`);
      return { data: Buffer.from(await r.arrayBuffer()).toString('base64'), mime: r.headers.get('content-type') || 'image/png', model: g.model || 'flujo propio' };
    }
    await new Promise((res) => setTimeout(res, 700));
  }
  throw new Error('ComfyUI tardó demasiado');
}
async function a1111Generate(g, a, signal) {
  const d = await getJSON(`${trim(g.url)}/sdapi/v1/txt2img`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ prompt: a.prompt, negative_prompt: a.negative, width: a.width, height: a.height, steps: a.steps, seed: a.seed }) });
  if (!d.images?.[0]) throw new Error('El generador no devolvió ninguna imagen');
  let model = '';
  try { model = JSON.parse(d.info || '{}').sd_model_name || ''; } catch {}
  return { data: d.images[0].replace(/^data:[^,]+,/, ''), mime: 'image/png', model };
}
const clampInt = (v, lo, hi, def) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : def);
let imageBusy = false; // una imagen a la vez: cancelar en la app no para el generador, así no se acumulan trabajos
async function imageGenerate(args, { signal } = {}) {
  const prompt = String(args.prompt || '').trim().slice(0, 4000);
  if (!prompt) throw new Error('Falta el prompt');
  if (imageBusy) throw new Error('El generador del PC aún está terminando la imagen anterior. Espera a que acabe y vuelve a intentarlo.');
  imageBusy = true;
  try { return await imageGenerateNow(prompt, args, signal); } finally { imageBusy = false; }
}
async function imageGenerateNow(prompt, args, signal) {
  const a = { prompt, negative: String(args.negative || '').slice(0, 2000), steps: clampInt(args.steps, 1, 80, 25),
    width: clampInt(args.width, 256, 2048, 1024) & ~7, height: clampInt(args.height, 256, 2048, 1024) & ~7, seed: clampInt(args.seed, 0, 2 ** 31, Math.floor(Math.random() * 2 ** 31)) };
  const online = (await imageStatus()).filter((x) => x.online).map((x) => IMAGES.find((g) => g.id === x.id));
  const g = online.find((x) => x.id === args.backend) || online[0];
  if (!g) throw new Error('No hay ningún generador de imágenes encendido en este equipo. Instala y abre ComfyUI (puerto 8188) o Forge / AUTOMATIC1111 con la opción --api (puerto 7860).');
  const t0 = Date.now();
  const out = await (g.type === 'comfyui' ? comfyGenerate : a1111Generate)(g, a, signal);
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  return { image: out, text: `Imagen generada en ${seconds} s con ${g.id}${out.model ? ` · ${out.model}` : ''} · semilla ${a.seed}`, backend: g.id, model: out.model, seconds, seed: a.seed };
}

async function listModels() {
  const backends = await Promise.all(BACKENDS.map(async (b) => {
    try {
      const names = await backendModels(b);
      return { id: b.id, type: b.type, url: b.url, local: isLocalBackend(b), online: true, models: names };
    } catch (e) {
      return { id: b.id, type: b.type, url: b.url, local: isLocalBackend(b), online: false, error: e.cause?.code || e.message, models: [] };
    }
  }));
  const models = backends.flatMap((b) => b.models.map((name) => ({ id: `${b.id}/${name}`, backend: b.id, name })));
  return { models, backends: backends.map(({ models: m, ...rest }) => ({ ...rest, count: m.length })), images: await imageStatus() };
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
async function chat({ model, messages, system, temperature, max_tokens, tools, local_only }, ctx = {}) {
  const [b, name] = backendFor(model);
  // Hilo privado: el puente también se niega a reenviar a un backend externo.
  if (local_only && !isLocalBackend(b)) throw new Error(`El backend ${b.id} no es local y este hilo es privado`);
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
      local_only: { type: 'boolean', description: 'Rechazar si el backend no es local (hilos privados)' },
      ...(FOLDERS.length ? { tools: { type: 'boolean', description: 'Deja que el modelo use las carpetas compartidas antes de responder' } } : {}) } } },
  { name: 'system_info', title: 'Estado del equipo',
    description: 'CPU, memoria, carga y estado de los backends de IA de este equipo.',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'image_generate', title: 'Generar una imagen en este equipo',
    description: 'Genera una imagen con el generador local (ComfyUI o Forge/AUTOMATIC1111). Gratis y privado: no sale del equipo.',
    inputSchema: { type: 'object', required: ['prompt'], properties: {
      prompt: { type: 'string' }, negative: { type: 'string', description: 'lo que no debe aparecer' },
      width: { type: 'integer' }, height: { type: 'integer' }, steps: { type: 'integer' }, seed: { type: 'integer' }, backend: { type: 'string' } } } },
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
const IMPL = { list_models: listModels, chat, system_info: systemInfo, image_generate: imageGenerate, ...(SYNC ? { threads_sync: threadsSync } : {}),
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
        if (data.image) {
          // Imagen como contenido MCP de tipo image (base64); el resto, como datos estructurados.
          const { image, ...rest } = data;
          return ok({ content: [{ type: 'image', data: image.data, mimeType: image.mime }, { type: 'text', text: data.text }], structuredContent: rest });
        }
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
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Accept, x-api-key, anthropic-version, anthropic-beta',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
function authorized(req) {
  if (!TOKEN) return true;
  return same(req.headers.authorization || '', `Bearer ${TOKEN}`);
}
// Gateway: su token como «Authorization: Bearer» (clientes OpenAI) o «x-api-key» (clientes Anthropic).
const authorizedGw = (req) => same(req.headers.authorization || '', `Bearer ${GW_TOKEN}`) || same(req.headers['x-api-key'] || '', GW_TOKEN);

// ---------- Neura Gateway: API compatible con OpenAI y Anthropic ----------
// Otras herramientas (Continue, Cline, Aider, Open WebUI…) usan Neura como proveedor: por detrás van los
// backends de este puente y las IAs que la app de PC le pasa con las claves del propio usuario (solo en memoria).
// Con el modelo «auto» (o uno desconocido) se aplica AUTO-SALTO: si una IA falla o agota su cuota, se prueba la siguiente.
const gateway = { enabled: false, localOnly: false, freeOnly: false, unknownAsAuto: false, cache: false, budget: {}, appSpent: {}, providers: [], order: [] };

// Consumo del Gateway por día y destino (se guarda en disco, 62 días). Tokens: los que dé el proveedor o una estimación.
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const gwUsageFile = join(DATA_DIR, 'gateway-uso.json');
const gwUsage = (() => { try { return JSON.parse(readFileSync(gwUsageFile, 'utf8')) || {}; } catch { return {}; } })();
let gwSaveT;
function gwRecord(t, inTok, outTok, failed) {
  const u = ((gwUsage[dayKey()] ||= {})[t.id] ||= { n: 0, err: 0, in: 0, out: 0, eur: 0 });
  if (failed) u.err++;
  else { u.n++; u.in += inTok; u.out += outTok; u.eur += t.price ? ((+t.price.in || 0) * inTok + (+t.price.out || 0) * outTok) / 1e6 : 0; }
  const days = Object.keys(gwUsage).sort();
  while (days.length > 62) delete gwUsage[days.shift()];
  clearTimeout(gwSaveT);
  gwSaveT = setTimeout(() => {
    try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(gwUsageFile + '.tmp', JSON.stringify(gwUsage)); renameSync(gwUsageFile + '.tmp', gwUsageFile); } catch {}
  }, 1000);
}
function gwSpent() {
  const day = dayKey();
  let d = 0, m = 0;
  for (const [k, v] of Object.entries(gwUsage)) for (const u of Object.values(v)) { if (k === day) d += u.eur; if (k.slice(0, 7) === day.slice(0, 7)) m += u.eur; }
  return { day: d, month: m };
}
// Tope de gasto: lo del Gateway más lo que la app de este PC ha gastado por su cuenta.
function gwOver() {
  const b = gateway.budget || {}, s = gwSpent(), a = gateway.appSpent || {}, day = dayKey();
  const ad = a.date === day ? +a.day || 0 : 0, am = String(a.date || '').slice(0, 7) === day.slice(0, 7) ? +a.month || 0 : 0;
  return (b.day > 0 && s.day + ad >= b.day) || (b.month > 0 && s.month + am >= b.month);
}
// Caché opcional: la misma petición exacta en 10 minutos se responde sin llamar a ninguna IA.
const gwCache = new Map();
let gwCacheHits = 0;
const GW_CACHE_TTL = 10 * 60e3;
const gwCacheKey = (model, body) => createHash('sha256').update(JSON.stringify([model || 'auto', body])).digest('hex');
function gwCacheGet(k) {
  const v = gwCache.get(k);
  if (v && Date.now() - v.at <= GW_CACHE_TTL) return v;
  gwCache.delete(k);
  return null;
}
function gwCachePut(k, v) {
  gwCache.delete(k); gwCache.set(k, { ...v, at: Date.now() });
  while (gwCache.size > 200) gwCache.delete(gwCache.keys().next().value);
}
// Se lee una copia de la respuesta mientras llega al cliente: cuenta tokens y, si terminó bien, la guarda en caché.
function gwTap(r, t, body, key) {
  const [a, b] = r.body.tee();
  const ct = r.headers.get('content-type') || '';
  (async () => {
    const chunks = [];
    let complete = true;
    try { for await (const c of b) chunks.push(Buffer.from(c)); } catch { complete = false; }
    const buf = Buffer.concat(chunks), txt = buf.toString('utf8');
    let inTok = Math.ceil(JSON.stringify(body.messages || []).length / 4), outTok = 0;
    if (/event-stream/.test(ct)) {
      let chars = 0, done = false;
      for (const l of txt.split('\n')) {
        const d = l.startsWith('data:') ? l.slice(5).trim() : '';
        if (!d) continue;
        if (d === '[DONE]') { done = true; continue; }
        try {
          const j = JSON.parse(d), ch = j.choices?.[0];
          if (j.usage) { inTok = j.usage.prompt_tokens || inTok; outTok = j.usage.completion_tokens || outTok; }
          if (ch?.finish_reason) done = true;
          chars += (ch?.delta?.content || '').length + (ch?.delta?.tool_calls || []).reduce((n, x) => n + (x.function?.arguments || '').length, 0);
        } catch {}
      }
      if (!outTok) outTok = Math.ceil(chars / 4);
      complete &&= done;
    } else {
      try { const j = JSON.parse(txt); inTok = j.usage?.prompt_tokens || inTok; outTok = j.usage?.completion_tokens || Math.ceil(JSON.stringify(j.choices?.[0]?.message || '').length / 4); }
      catch { complete = false; }
    }
    gwRecord(t, inTok, outTok, false);
    if (key && complete) gwCachePut(key, { ct, buf, t });
  })();
  return new Response(a, { status: r.status, headers: r.headers });
}
const gwCool = new Map(); // id → hasta cuándo no se usa
const backendCache = { at: 0, list: [] };
async function gwTargets() {
  if (Date.now() - backendCache.at > 30000) {
    const out = [];
    for (const b of BACKENDS) {
      try {
        for (const name of await backendModels(b)) {
          // Ollama ofrece también una API compatible con OpenAI en /v1.
          out.push({ id: `${b.id}/${name}`, url: b.type === 'ollama' ? `${trim(b.url)}/v1` : trim(b.url), apiKey: b.apiKey, model: name, local: isLocalBackend(b), here: isThisMachine(b) });
        }
      } catch {}
    }
    Object.assign(backendCache, { at: Date.now(), list: out });
  }
  // Con el tope de gasto alcanzado, solo IAs gratuitas (como SOLO GRATIS).
  const over = gwOver();
  // Con un tope activo, una de pago sin precio tampoco: su gasto no se podría contar.
  const capped = gateway.budget?.day > 0 || gateway.budget?.month > 0;
  const cloud = gateway.localOnly ? [] : gateway.providers.filter((p) => p.free || (!over && !(capped && !p.price))).map((p) => ({ ...p, local: false }));
  // Con SOLO LOCAL o SOLO GRATIS, de los backends del puente solo cuentan los locales (uno externo puede ser de pago).
  const all = [...backendCache.list.filter((t) => (gateway.localOnly ? t.here : t.local || !(gateway.freeOnly || over))), ...cloud];
  const rank = (t) => { const i = gateway.order.indexOf(t.id); return i < 0 ? 1e6 : i; };
  return all.sort((a, b) => rank(a) - rank(b));
}
async function gwPlan(model) {
  const all = await gwTargets();
  const exact = all.find((t) => t.id === model);
  if (exact) return [exact];
  if (model && model !== 'auto' && !gateway.unknownAsAuto) {
    throw Object.assign(new Error(`El modelo «${model}» no está en Neura Gateway. Usa «auto» o uno de los que lista GET /v1/models (o activa en Neura «usar auto para nombres desconocidos»).`), { status: 404, code: 'model_not_found' });
  }
  const ready = all.filter((t) => (gwCool.get(t.id) || 0) <= Date.now());
  return ready.length ? ready : all;
}
// Clave inválida: se pausa todo el proveedor (misma URL y clave). Modelo inexistente: solo ese modelo.
// Cuota: lo que diga Retry-After (o 60 s). Caída o red: 60 s.
function gwFail(t, status, headers) {
  const until = (s) => Date.now() + s * 1000;
  if (status === 401 || status === 403) {
    for (const x of [...backendCache.list, ...gateway.providers]) if (x.url === t.url && (x.apiKey || '') === (t.apiKey || '')) gwCool.set(x.id, until(3600));
    return;
  }
  const ra = Number(headers?.get?.('retry-after'));
  gwCool.set(t.id, until(status === 429 ? (ra > 0 ? ra : 60) : status === 404 ? 3600 : 60));
}
// Llama al primer destino que responda bien; devuelve la respuesta todavía sin leer (para poder reenviar el streaming).
async function gwCall(model, body, signal) {
  const key = gateway.cache ? gwCacheKey(model, body) : null;
  const hit = key && gwCacheGet(key);
  if (hit) { gwCacheHits++; return { r: new Response(hit.buf, { status: 200, headers: { 'content-type': hit.ct } }), t: hit.t, cached: true }; }
  const plan = await gwPlan(model);
  if (!plan.length) throw Object.assign(new Error('No hay modelos disponibles en Neura Gateway'), { status: 503 });
  let last;
  const pausedBefore = new Map(gwCool);
  for (const t of plan.slice(0, 6)) {
    // Saltar lo que un fallo de esta misma petición acaba de pausar (p. ej. misma clave inválida);
    // si todo estaba ya en pausa al empezar, se prueba igualmente como último recurso.
    if (plan.length > 1 && gwCool.get(t.id) !== pausedBefore.get(t.id)) continue;
    try {
      const r = await fetch(`${t.url}/chat/completions`, {
        method: 'POST', signal: signalFor(TIMEOUT, signal),
        headers: { 'Content-Type': 'application/json', ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) },
        body: JSON.stringify({ ...body, model: t.model }),
      });
      if (r.ok) { gwCool.delete(t.id); return { r: gwTap(r, t, body, key), t }; }
      gwFail(t, r.status, r.headers);
      if (r.status !== 429) gwRecord(t, 0, 0, true);
      last = Object.assign(new Error(`${t.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`), { status: r.status });
      if (r.status === 400) break; // petición mal formada: otra IA no lo arreglará
    } catch (e) {
      if (signal?.aborted) throw e;
      gwFail(t, 0); gwRecord(t, 0, 0, true); last = e;
    }
  }
  throw last || new Error('Sin respuesta');
}
const gwError = (res, e, anthropic) => send(res, e.status && e.status < 500 ? e.status : 502, anthropic
  ? { type: 'error', error: { type: e.code === 'model_not_found' ? 'not_found_error' : 'api_error', message: e.message } }
  : { error: { message: e.message, type: 'neura_gateway_error', ...(e.code ? { code: e.code } : {}) } });

async function gwModels(res) {
  const all = await gwTargets();
  send(res, 200, { object: 'list', data: [{ id: 'auto', object: 'model', owned_by: 'neura' }, ...all.map((t) => ({ id: t.id, object: 'model', owned_by: t.local ? 'local' : 'neura' }))] });
}

async function gwOpenAI(req, res, body) {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  let r, t, cached;
  try { ({ r, t, cached } = await gwCall(body.model, body, ctl.signal)); } catch (e) { return gwError(res, e); }
  if (cached) res.setHeader('x-neura-cache', 'hit');
  if (!body.stream) {
    const d = await r.json();
    return send(res, 200, { ...d, model: body.model || t.id });
  }
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  // Si el proveedor se corta antes de terminar, se avisa con un error en lugar de dar la respuesta por buena.
  const dec = new TextDecoder();
  let tail = '', ended = false;
  try {
    for await (const chunk of r.body) {
      res.write(chunk);
      tail = (tail + dec.decode(chunk, { stream: true })).slice(-600);
      if (/data:\s*\[DONE\]|"finish_reason":\s*"[a-z_]+"/.test(tail)) ended = true;
    }
  } catch {}
  if (!ended && !res.destroyed) res.write(`data: ${JSON.stringify({ error: { message: 'La respuesta del proveedor se interrumpió antes de terminar.', type: 'upstream_interrupted' } })}\n\n`);
  res.end();
}

// Anthropic Messages → OpenAI chat
const blockText = (c) => (typeof c === 'string' ? c : (c || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
function anthropicToOpenAI(body) {
  const messages = [];
  const sys = blockText(body.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of body.messages || []) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    if (m.role === 'assistant') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Los resultados de herramientas van primero, como mensajes «tool», justo después de la llamada.
    for (const b of blocks.filter((x) => x.type === 'tool_result')) {
      messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'Error: ' : '') + blockText(b.content) });
    }
    const parts = blocks.flatMap((b) => (b.type === 'text' ? [{ type: 'text', text: b.text }]
      : b.type === 'image' && b.source?.type === 'base64' ? [{ type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }]
      : b.type === 'image' && b.source?.type === 'url' ? [{ type: 'image_url', image_url: { url: b.source.url } }] : []));
    if (parts.length) messages.push({ role: 'user', content: parts.every((x) => x.type === 'text') ? parts.map((x) => x.text).join('\n') : parts });
  }
  const out = { messages, stream: !!body.stream };
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.stop_sequences?.length) out.stop = body.stop_sequences;
  if (body.tools?.length) {
    out.tools = body.tools.filter((x) => x.input_schema).map((x) => ({ type: 'function', function: { name: x.name, description: x.description || '', parameters: x.input_schema } }));
    const tc = body.tool_choice;
    if (tc?.type === 'any') out.tool_choice = 'required';
    else if (tc?.type === 'tool') out.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc?.type === 'none') out.tool_choice = 'none';
  }
  return out;
}
const stopReason = (f) => (f === 'tool_calls' ? 'tool_use' : f === 'length' ? 'max_tokens' : 'end_turn');
const parseArgs = (a) => { try { return typeof a === 'string' ? JSON.parse(a || '{}') : a || {}; } catch { return {}; } };
const msgId = () => 'msg_' + randomBytes(12).toString('hex');

async function gwAnthropic(req, res, body) {
  const ctl = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  let r, cached;
  try { ({ r, cached } = await gwCall(body.model, anthropicToOpenAI(body), ctl.signal)); } catch (e) { return gwError(res, e, true); }
  if (cached) res.setHeader('x-neura-cache', 'hit');
  if (!body.stream) {
    const d = await r.json();
    const m = d.choices?.[0]?.message || {};
    const content = [
      ...(asText(m.content) ? [{ type: 'text', text: asText(m.content) }] : []),
      ...(m.tool_calls || []).map((c) => ({ type: 'tool_use', id: c.id || 'toolu_' + randomBytes(8).toString('hex'), name: c.function?.name, input: parseArgs(c.function?.arguments) })),
    ];
    return send(res, 200, { id: msgId(), type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason(d.choices?.[0]?.finish_reason), stop_sequence: null,
      usage: { input_tokens: d.usage?.prompt_tokens ?? 0, output_tokens: d.usage?.completion_tokens ?? 0 } });
  }
  // Streaming: los trozos de OpenAI se convierten en los eventos de Anthropic.
  res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: msgId(), type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  let idx = -1, open = null, finish = null, outTok = 0, sawDone = false, broken = false;
  const tools = new Map(); // índice OpenAI → índice de bloque
  const close = () => { if (open) { ev('content_block_stop', { index: idx }); open = null; } };
  try {
    for await (const l of lines(r)) {
      if (!l.startsWith('data:')) continue;
      const raw = l.slice(5).trim();
      if (raw === '[DONE]') { sawDone = true; break; }
      let d; try { d = JSON.parse(raw); } catch { continue; }
      if (d.usage?.completion_tokens) outTok = d.usage.completion_tokens;
      const ch = d.choices?.[0]; if (!ch) continue;
      const delta = ch.delta || {};
      if (delta.content) {
        if (open !== 'text') { close(); idx++; open = 'text'; ev('content_block_start', { index: idx, content_block: { type: 'text', text: '' } }); }
        ev('content_block_delta', { index: idx, delta: { type: 'text_delta', text: delta.content } });
      }
      for (const tc of delta.tool_calls || []) {
        const k = tc.index ?? 0;
        if (!tools.has(k)) {
          close(); idx++; open = 'tool'; tools.set(k, idx);
          ev('content_block_start', { index: idx, content_block: { type: 'tool_use', id: tc.id || 'toolu_' + randomBytes(8).toString('hex'), name: tc.function?.name || '', input: {} } });
        }
        if (tc.function?.arguments) ev('content_block_delta', { index: tools.get(k), delta: { type: 'input_json_delta', partial_json: tc.function.arguments } });
      }
      if (ch.finish_reason) finish = ch.finish_reason;
    }
  } catch { broken = true; }
  if (broken || (!finish && !sawDone)) {
    // Corte a mitad: evento de error de Anthropic, sin message_stop (no es una respuesta completa).
    if (!res.destroyed) ev('error', { error: { type: 'api_error', message: 'La respuesta del proveedor se interrumpió antes de terminar.' } });
    return res.end();
  }
  close();
  ev('message_delta', { delta: { stop_reason: stopReason(finish), stop_sequence: null }, usage: { output_tokens: outTok } });
  ev('message_stop', {});
  res.end();
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

  // Configuración del Gateway: solo la app de este mismo equipo (con token) puede pasarle las IAs y claves.
  if (path === '/neura/gateway' && (req.method === 'POST' || req.method === 'GET')) {
    const ip = req.socket.remoteAddress || '';
    if (!authorized(req) || !/^(127\.|::1$|::ffff:127\.)/.test(ip)) return send(res, 403, { error: 'solo desde este equipo' });
    if (req.method === 'GET') {
      // Consumo del Gateway para el panel de la app: hoy por destino, el mes acumulado, gasto y caché.
      const day = dayKey(), month = {};
      for (const [k, v] of Object.entries(gwUsage)) if (k.slice(0, 7) === day.slice(0, 7)) for (const [id, u] of Object.entries(v)) { const m = (month[id] ||= { n: 0, eur: 0 }); m.n += u.n; m.eur += u.eur; }
      return send(res, 200, { date: day, today: gwUsage[day] || {}, month, spent: gwSpent(), over: gwOver(), cache: { enabled: !!gateway.cache, hits: gwCacheHits, entries: gwCache.size } });
    }
    let c; try { c = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'JSON inválido' }); }
    const num = (x) => Math.max(0, +x || 0);
    const clean = (p) => ({ id: String(p.id), url: trim(String(p.url)), apiKey: p.apiKey ? String(p.apiKey) : '', model: String(p.model), free: !!p.free,
      price: p.price ? { in: num(p.price.in), out: num(p.price.out) } : null });
    // Si cambió la configuración de un destino (p. ej. la clave), se puede reintentar ya: se quita su pausa.
    const sig = (p) => `${p.url} ${p.apiKey} ${p.model}`;
    const before = new Map(gateway.providers.map((p) => [p.id, sig(p)]));
    // Si cambia algo más que el gasto de la app, la caché se vacía (p. ej. al activar «solo modelos de este equipo»).
    const confSig = JSON.stringify({ ...c, appSpent: null });
    if (confSig !== gateway.confSig) gwCache.clear();
    Object.assign(gateway, { confSig, enabled: !!c.enabled, localOnly: !!c.localOnly, freeOnly: !!c.freeOnly, unknownAsAuto: !!c.unknownAsAuto, cache: !!c.cache,
      budget: { day: num(c.budget?.day), month: num(c.budget?.month) }, appSpent: c.appSpent && typeof c.appSpent === 'object' ? { date: String(c.appSpent.date || ''), day: num(c.appSpent.day), month: num(c.appSpent.month) } : {},
      providers: Array.isArray(c.providers) ? c.providers.filter((p) => p?.id && /^https?:\/\//.test(p.url) && p.model).map(clean) : [],
      order: Array.isArray(c.order) ? c.order.map(String) : [] });
    for (const p of gateway.providers) if (before.get(p.id) !== sig(p)) gwCool.delete(p.id);
    backendCache.at = 0;
    return send(res, 200, { ok: true, enabled: gateway.enabled, providers: gateway.providers.length });
  }
  if (path.startsWith('/v1/')) {
    const anthropic = path.startsWith('/v1/messages');
    if (!authorizedGw(req)) return send(res, 401, anthropic ? { type: 'error', error: { type: 'authentication_error', message: 'Token inválido' } } : { error: { message: 'Token inválido', type: 'invalid_api_key' } });
    if (!gateway.enabled) return send(res, 404, { error: { message: 'Neura Gateway está desactivado: actívalo en Neura → ⬡ → ESTE PC.' } });
    if (path === '/v1/models' && req.method === 'GET') return gwModels(res);
    if (req.method !== 'POST') return send(res, 405, null, { Allow: 'POST, OPTIONS' });
    let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: { message: 'JSON inválido' } }); }
    if (path === '/v1/chat/completions') return gwOpenAI(req, res, body);
    if (path === '/v1/messages') return gwAnthropic(req, res, body);
    if (path === '/v1/messages/count_tokens') return send(res, 200, { input_tokens: Math.ceil(JSON.stringify(body.messages || []).length / 4) });
    return send(res, 404, { error: { message: 'Ruta no disponible en Neura Gateway' } });
  }
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
  if (!process.env.NEURA_GATEWAY_TOKEN && !cfg.gatewayToken) console.log(`  TOKEN GATEWAY: ${GW_TOKEN}  (solo para /v1/*; fíjalo con NEURA_GATEWAY_TOKEN)`);
  console.log('');
});
