'use strict';
// NEURA — todas las IAs públicas en un solo chat + puente MCP a IA local.
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const md = (s) => window.NeuraMD.render(s);
const LS = 'neura.v1';
// Neura Desktop (Electron) expone window.neuraDesktop: guarda en disco y hace las peticiones desde el PC.
const DESK = window.neuraDesktop || null;
const CAP = !!window.Capacitor?.isNativePlatform?.();
// En la app nativa (Capacitor) y en el PC las peticiones no pasan por el navegador: sin CORS ni bloqueo http.
const NATIVE = CAP || !!DESK;
// CapacitorHttp entrega la respuesta completa de una vez: allí no hay streaming real.
const STREAM = !CAP;
const xfetch = DESK ? deskFetch : (...a) => fetch(...a);
const MAX_ATTEMPTS = 6;

// La petición la hace el proceso principal del PC y llega por trozos: aquí se convierte en un Response normal.
function deskFetch(url, { method = 'GET', headers = {}, body, signal } = {}) {
  const id = uid() + uid();
  let ctrl;
  const stream = new ReadableStream({ start(c) { ctrl = c; }, cancel() { DESK.abort(id); } });
  const onAbort = () => DESK.abort(id);
  signal?.addEventListener('abort', onAbort);
  const done = () => signal?.removeEventListener('abort', onAbort);
  return new Promise((resolve, reject) => {
    let head = false;
    DESK.request(id, { url: String(url), method, headers, body }, (type, data) => {
      if (type === 'head') {
        head = true;
        resolve(new Response([204, 205, 304].includes(data.status) ? null : stream, { status: data.status, headers: data.headers }));
      } else if (type === 'chunk') ctrl.enqueue(data);
      else if (type === 'end') { done(); try { ctrl.close(); } catch {} }
      else if (type === 'error') {
        done();
        const err = data.aborted || signal?.aborted ? new DOMException('Cancelado', 'AbortError') : new TypeError('Failed to fetch: ' + data.message);
        if (head) { try { ctrl.error(err); } catch {} } else reject(err);
      }
    });
  });
}

// IAs públicas con API. Los nombres de modelo cambian: usa ESCANEAR para actualizarlos.
// stt: modelo de dictado por voz (API /audio/transcriptions compatible con OpenAI).
const PRESETS = {
  gemini:     { name: 'Google Gemini', kind: 'openai', tier: 'free', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-flash-latest', 'gemini-flash-lite-latest'], keyUrl: 'https://aistudio.google.com/apikey' },
  groq:       { name: 'Groq', kind: 'openai', tier: 'free', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'], keyUrl: 'https://console.groq.com/keys', stt: 'whisper-large-v3-turbo' },
  openrouter: { name: 'OpenRouter', kind: 'openai', tier: 'free', baseUrl: 'https://openrouter.ai/api/v1', models: [], freeOnly: true, keyUrl: 'https://openrouter.ai/keys' },
  cerebras:   { name: 'Cerebras', kind: 'openai', tier: 'free', baseUrl: 'https://api.cerebras.ai/v1', models: ['llama-3.3-70b', 'gpt-oss-120b'], keyUrl: 'https://cloud.cerebras.ai' },
  mistral:    { name: 'Mistral', kind: 'openai', tier: 'free', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-small-latest', 'open-mistral-nemo'], keyUrl: 'https://console.mistral.ai/api-keys' },
  github:     { name: 'GitHub Models', kind: 'openai', tier: 'free', baseUrl: 'https://models.github.ai/inference', models: ['openai/gpt-4.1-mini', 'meta/Llama-3.3-70B-Instruct'], keyUrl: 'https://github.com/settings/tokens' },
  hf:         { name: 'Hugging Face', kind: 'openai', tier: 'free', baseUrl: 'https://router.huggingface.co/v1', models: ['meta-llama/Llama-3.3-70B-Instruct'], keyUrl: 'https://huggingface.co/settings/tokens' },
  // NVIDIA no permite peticiones desde el navegador (CORS): solo en la app de móvil y de PC.
  nvidia:     { name: 'NVIDIA (Nemotron)', kind: 'openai', tier: 'free', baseUrl: 'https://integrate.api.nvidia.com/v1', models: ['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3.5-lightning-30b-a3b'], keyUrl: 'https://build.nvidia.com/settings/api-keys', nativeOnly: true },
  cohere:     { name: 'Cohere', kind: 'openai', tier: 'free', baseUrl: 'https://api.cohere.ai/compatibility/v1', models: ['command-a-03-2025'], keyUrl: 'https://dashboard.cohere.com/api-keys' },
  anthropic:  { name: 'Anthropic Claude', kind: 'anthropic', tier: 'paid', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai:     { name: 'OpenAI', kind: 'openai', tier: 'paid', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini'], keyUrl: 'https://platform.openai.com/api-keys', stt: 'gpt-4o-mini-transcribe' },
  deepseek:   { name: 'DeepSeek', kind: 'openai', tier: 'paid', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  custom:     { name: 'Otra (compatible OpenAI)', kind: 'openai', tier: 'other', baseUrl: '', models: [] },
};

const DEFAULT_INSTRUCTIONS = 'Responde siempre en español y solo en español: nunca repitas ni traduzcas la respuesta a otro idioma. Sé claro y conciso; da más detalle solo si te lo pido.';
// ---------- estado ----------
const S = Object.assign({
  providers: [], mcp: [], threads: [], active: null, target: null, autoSkip: true,
  health: {}, ctxTokens: 6000, instructions: DEFAULT_INSTRUCTIONS, council: false, councilKeys: [], useTools: false, vault: null, skills: [], projects: [], project: null, gateway: { enabled: false, localOnly: false },
}, load());
// Migración: el chat único de versiones anteriores pasa a ser el primer hilo.
if (S.messages) { if (S.messages.length) S.threads.unshift({ id: S.active = uid(), title: S.messages.find((m) => m.role === 'user')?.content.slice(0, 48) || 'HILO', messages: S.messages, ts: Date.now() }); delete S.messages; }
// Nivel de uso: los usuarios existentes siguen en profesional; los nuevos eligen al empezar.
if (S.level == null && (S.providers.length || S.threads.some((t) => t.messages.length))) S.level = 'pro';
// Gemini retiró los 2.5: se pasa a los alias que siempre apuntan al modelo vigente.
const GEMINI_OLD = { 'gemini-2.5-flash': 'gemini-flash-latest', 'gemini-2.5-flash-lite': 'gemini-flash-lite-latest' };
S.providers.filter((p) => p.preset === 'gemini').forEach((p) => { p.models = [...new Set(p.models.map((m) => GEMINI_OLD[m] || m))]; });
if (!S.v111) {
  for (const p of S.providers.filter((x) => x.preset === 'gemini')) p.models.sort((a, b) => modelRank(a) - modelRank(b));
  const [pid, model] = String(S.target || '').split('::');
  const gp = S.providers.find((x) => x.id === pid && x.preset === 'gemini');
  if (gp && modelRank(model) >= 4) S.target = `${gp.id}::${gp.models[0]}`;
  S.v111 = true;
}
// Los mensajes necesitan id para fusionar hilos entre dispositivos sin duplicarlos.
S.threads.forEach((t) => t.messages.forEach((m) => { m.id ||= uid() + uid(); }));
function thread() {
  let t = S.threads.find((x) => x.id === S.active && !x.deleted);
  if (!t) { t = { id: uid(), title: 'NUEVO HILO', messages: [], ts: Date.now() }; S.threads.unshift(t); S.active = t.id; }
  return t;
}
function load() { try { return JSON.parse(DESK ? DESK.load() : localStorage.getItem(LS)) || {}; } catch { return {}; } }
function save() {
  const st = { ...S, mcp: S.mcp.map(({ sessionId, status, syncing, ...m }) => m) };
  if (S.vault) {
    // Con PIN, las claves solo se guardan cifradas dentro de S.vault.
    st.providers = st.providers.map(({ apiKey, ...p }) => p);
    st.mcp = st.mcp.map((m) => (m.local ? m : (({ token, ...x }) => x)(m)));
    if (vault.key) sealSoon();
  }
  // Los adjuntos ya guardados en IndexedDB se quedan fuera: el hilo solo conserva su referencia.
  const data = JSON.stringify(st, (k, v) => (v && v.ref && (v.kind === 'image' || v.kind === 'text') ? { ...v, data: undefined, text: undefined } : v));
  try { if (DESK) { DESK.save(data); pushGatewaySoon(); } else localStorage.setItem(LS, data); storageWarn(null); }
  catch (e) { storageWarn(e); }
}
// ---------- Neura Gateway (PC): otras herramientas usan Neura como proveedor ----------
// Orden como AUTO-SALTO: la IA elegida y después por calidad. Respeta SOLO GRATIS. Solo IAs compatibles con OpenAI.
function gatewayPayload() {
  const g = S.gateway || {};
  const name = (t) => `${slug(S.providers.find((p) => p.id === t.pid).name)}/${t.model}`;
  const cloud = targets().filter((t) => t.pid && t.kind === 'openai' && (!S.freeOnly || isFree(t)));
  const mine = targets().filter((t) => t.kind === 'mcp' && S.mcp.find((s) => s.id === t.sid)?.local);
  const first = findT(S.target);
  // Por clave: targets() crea objetos nuevos en cada llamada.
  const usable = new Set([...cloud, ...mine].map((t) => t.key));
  const ordered = [first, ...[...cloud, ...mine].sort((a, b) => score(b) - score(a))]
    .filter((t, i, a) => t && usable.has(t.key) && a.findIndex((x) => x?.key === t.key) === i);
  return {
    enabled: !!g.enabled, localOnly: !!g.localOnly, freeOnly: !!S.freeOnly, unknownAsAuto: !!g.unknownAsAuto, cache: !!g.cache,
    budget: { day: +S.budget?.day || 0, month: +S.budget?.month || 0 }, appSpent: { date: today(), ...spent().app },
    providers: cloud.map((t) => { const p = S.providers.find((x) => x.id === t.pid); return { id: name(t), url: p.baseUrl, apiKey: p.apiKey || '', model: t.model, free: isFree(t), price: priced(p) ? { in: +p.price.in || 0, out: +p.price.out || 0 } : null }; }),
    order: ordered.map((t) => (t.pid ? name(t) : t.model)),
  };
}
let gwSent = '', gwTimer;
function pushGatewaySoon() {
  if (!DESK?.gateway) return;
  clearTimeout(gwTimer);
  gwTimer = setTimeout(() => { const c = JSON.stringify(gatewayPayload()); if (c !== gwSent) { gwSent = c; DESK.gateway(JSON.parse(c)); } }, 300);
}
// Aviso fijo (no un mensaje que desaparece) mientras lo último no esté guardado.
function storageWarn(e) {
  const el = document.getElementById('saveWarn');
  if (!el) return;
  el.hidden = !e;
  if (e) el.innerHTML = `⚠️ No se ha podido guardar (${esc(/quota/i.test(e.name + e.message) ? 'almacenamiento lleno' : e.message)}). Lo último sigue en pantalla: <button type="button" class="btn sm" id="saveWarnExport">EXPORTAR COPIA</button>`;
}

// ---------- adjuntos en IndexedDB ----------
// Imágenes (binario) y textos de PDF fuera del estado: el almacenamiento del navegador (~5 MB) no da para ellos.
// Orden seguro: primero se guarda el archivo y después la referencia; si algo se corta, el hilo conserva el contenido.
const blobs = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('neura-adjuntos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const run = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('files', mode), q = fn(t.objectStore('files'));
      t.oncomplete = () => res(q.result); t.onerror = t.onabort = () => rej(t.error || new Error('IndexedDB'));
    });
  };
  return { put: (id, v) => run('readwrite', (st) => st.put(v, id)), get: (id) => run('readonly', (st) => st.get(id)),
    del: (id) => run('readwrite', (st) => st.delete(id)), keys: () => run('readonly', (st) => st.getAllKeys()) };
})();
const field = (f) => (f.kind === 'image' ? 'data' : 'text');
const allFiles = () => S.threads.flatMap((t) => t.messages.flatMap((m) => m.files || []));
function toBlob(dataUrl) {
  const [, type, b64] = dataUrl.match(/^data:([^;]+);base64,(.*)$/) || [];
  if (!b64) return dataUrl;
  return new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type });
}
const toDataUrl = (b) => (typeof b === 'string' ? Promise.resolve(b) : new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); }));
async function storeFile(f) {
  const id = uid() + uid();
  await blobs.put(id, f.kind === 'image' ? toBlob(f.data) : f.text);
  f.ref = id; // la referencia solo existe cuando el archivo ya está guardado
}
// Guarda en IndexedDB los adjuntos que aún van dentro del estado (versiones antiguas, sincronizados o importados).
let persisting = null;
function persistFiles() {
  return (persisting ||= (async () => {
    let n = 0;
    for (const f of allFiles()) {
      if (f.ref || f[field(f)] == null) continue;
      try { await storeFile(f); n++; } catch (e) { storageWarn(e); break; }
    }
    if (n) save();
  })().finally(() => { persisting = null; }));
}
// Al abrir: recupera el contenido de cada referencia y borra los archivos que ya no usa ningún hilo.
async function hydrateFiles() {
  const used = new Set();
  for (const f of allFiles()) {
    if (!f.ref) continue;
    used.add(f.ref);
    if (f[field(f)] != null) continue;
    try { const v = await blobs.get(f.ref); if (v == null) f.missing = true; else f[field(f)] = f.kind === 'image' ? await toDataUrl(v) : v; }
    catch { f.missing = true; }
  }
  try { for (const k of await blobs.keys()) if (!used.has(k)) await blobs.del(k); } catch {}
}
// Las referencias son de este dispositivo: al exportar o sincronizar viaja el contenido original.
const portable = (list) => JSON.parse(JSON.stringify(list, (k, v) => (k === 'ref' || k === 'missing' ? undefined : v)));
// Fusión de un hilo de dos dispositivos: mensajes unidos por id, el resto lo gana el ts más reciente.
// Mantener igual que mergeThread() en bridge/server.mjs.
function mergeThread(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [old, neu] = (b.ts || 0) > (a.ts || 0) ? [a, b] : [b, a];
  const byId = new Map();
  for (const m of [...(old.messages || []), ...(neu.messages || [])]) if (m?.id) byId.set(m.id, m);
  const messages = neu.deleted ? [] : [...byId.values()].sort((x, y) => (x.ts || 0) - (y.ts || 0));
  return { ...old, ...neu, messages, ts: Math.max(a.ts || 0, b.ts || 0) };
}
let busy = false, abortCtl = null, rpcId = 0, attach = [];

function targets() {
  const t = [];
  for (const p of S.providers) if (p.enabled !== false) for (const m of p.models) t.push({ key: `${p.id}::${m}`, pid: p.id, model: m, label: `${p.name} / ${m}`, kind: p.kind });
  for (const s of S.mcp) for (const m of s.models || []) t.push({ key: `mcp:${s.id}::${m}`, sid: s.id, model: m, label: `⬡ ${s.name} / ${m}`, kind: 'mcp' });
  return t;
}
const findT = (k) => targets().find((t) => t.key === k);
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ---------- AUTO-SALTO inteligente: salud de cada IA ----------
// Recuerda qué IA agotó su cuota y hasta cuándo, su velocidad y su tasa de éxito.
const H = (k) => (S.health[k] ||= { ok: 0, fail: 0, ms: 0 });
const cooling = (k) => (S.health[k]?.coolUntil || 0) > Date.now();
function parseWait(text) {
  const m = String(text).match(/(?:try again|retry|retrydelay|wait|reintenta|espera)[^0-9]{0,20}((?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\w*\s*)+)/i);
  if (!m) return 0;
  let s = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) s += n * { ms: 0.001, h: 3600, m: 60, s: 1 }[u.toLowerCase()];
  return Math.ceil(s);
}
const untilMidnightUTC = () => { const d = new Date(); d.setUTCHours(24, 0, 30, 0); return Math.ceil((d - Date.now()) / 1000); };
// Modelo retirado o inexistente: no volverá, hay que pedir la lista actual al proveedor.
const isGone = (e) => !isNoVision(e) && (e.status === 404 || /not found|no longer available|not supported for|does not exist|decommissioned|has been deprecated|model_not_found/i.test(e.message || ''));
// Gemini y otras devuelven 400 (no 401) con una clave inválida.
const isKeyErr = (e) => e.status === 401 || e.status === 403 || (e.status === 400 && /api.?key|unauthori[sz]ed|invalid.{0,12}(key|token|credential)/i.test(e.message || ''));
function noteOk(t, ms) { if (!(H(t.key).reason === 'LÍMITE' && cooling(t.key))) Object.assign(H(t.key), { coolUntil: 0, reason: null, streak: 0 }); const h = H(t.key); h.ok++; h.ms = h.ms ? Math.round(h.ms * 0.7 + ms * 0.3) : ms; }
// El modelo rechazó la imagen: sirve para texto, pero no hay que mandarle fotos.
const isNoVision = (e) => e.status === 400 && /image|vision|multimodal|modalit/i.test(e.message || '');
const capable = (t, needs = {}) => !(needs.vision && S.health[t.key]?.noVision);
function noteFail(t, e) {
  if (e.name === 'AbortError') return;
  const h = H(t.key), msg = e.message || '';
  h.fail++; h.streak = (h.streak || 0) + 1;
  if (isNoVision(e)) { Object.assign(h, { noVision: true, streak: 0 }); return; }
  if (e.status === 429 || /quota|rate.?limit|resource.?exhausted|too many requests/i.test(msg)) {
    let wait = e.retryAfter || parseWait(msg) || 60;
    if (!e.retryAfter && /per.?day|daily|\bRPD\b|\bTPD\b|por día|diari/i.test(msg)) wait = untilMidnightUTC();
    Object.assign(h, { coolUntil: Date.now() + wait * 1000, reason: 'CUOTA' });
  } else if (isGone(e) && t.pid) {
    Object.assign(h, { coolUntil: Date.now() + 365 * 864e5, reason: 'RETIRADO' });
    refreshModels(S.providers.find((p) => p.id === t.pid));
  } else if (isKeyErr(e) && t.pid) {
    // Una clave rechazada afecta a todos los modelos del proveedor hasta que la cambies.
    for (const x of targets()) if (x.pid === t.pid) Object.assign(H(x.key), { coolUntil: Date.now() + 365 * 864e5, reason: 'CLAVE' });
  } else if (e.status === 402) Object.assign(h, { coolUntil: Date.now() + 3600e3, reason: 'SALDO' });
  // Un modelo caído o saturado se pausa desde el primer fallo, para no hacer esperar en cada mensaje.
  else Object.assign(h, { coolUntil: Date.now() + 60e3 * Math.min(h.streak, 10), reason: 'FALLA' });
}
function score(t) {
  const h = S.health[t.key] || {};
  const rate = ((h.ok || 0) + 1) / ((h.ok || 0) + (h.fail || 0) + 2);
  return rate - 0.3 * (h.ms ? Math.min(h.ms, 60000) / 60000 : 0.3);
}
// ---------- consumo: peticiones, tokens y gasto (solo en este dispositivo) ----------
// Los tokens se estiman por caracteres (≈3,5 por token) y el gasto con el precio que pongas a cada IA: es orientativo.
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthOf = (day) => day.slice(0, 7);
const provOf = (t) => (t.pid ? S.providers.find((p) => p.id === t.pid) : null);
const priced = (p) => !!p?.price && (+p.price.in > 0 || +p.price.out > 0);
const costOf = (p, inT, outT) => (priced(p) ? ((+p.price.in || 0) * inT + (+p.price.out || 0) * outT) / 1e6 : 0);
const localMidnight = () => { const d = new Date(); d.setHours(24, 0, 0, 0); return +d; };
// Peticiones de hoy a un proveedor (las rechazadas por cuota no cuentan: el proveedor no las atendió).
const provToday = (p) => Object.entries(S.usage?.[today()] || {}).reduce((n, [k, v]) => n + (k.startsWith(p.id + '::') ? v.n + (v.err || 0) : 0), 0);
let usageRev = 0;
function recordUse(t, messages, out, e) {
  if (e && (e.name === 'AbortError' || e.status === 429)) return;
  const day = ((S.usage ||= {})[today()] ||= {});
  const u = (day[t.key] ||= { n: 0, in: 0, out: 0, eur: 0, err: 0 });
  if (e) u.err++;
  else {
    const i = tokens(messages), o = Math.ceil(String(out || '').length / 3.5);
    u.n++; u.in += i; u.out += o; u.eur += costOf(provOf(t), i, o);
  }
  usageRev++;
  const days = Object.keys(S.usage).sort();
  while (days.length > 62) delete S.usage[days.shift()];
  // Límite diario que pones tú: al 80 % avisa; al llegar, se deja de usar hasta medianoche (salvo que no quede otra).
  const p = provOf(t), lim = +p?.dailyLimit;
  if (!lim) return;
  const used = provToday(p);
  if (used >= lim) {
    for (const x of targets()) if (x.pid === p.id) Object.assign(H(x.key), { coolUntil: localMidnight(), reason: 'LÍMITE' });
  } else if (used >= lim * 0.8) {
    if (S.warned?.date !== today()) S.warned = { date: today(), ids: [] };
    if (!S.warned.ids.includes(p.id)) { S.warned.ids.push(p.id); toast(`📊 ${p.name}: ${used} de ${lim} peticiones de hoy (80 %)`); }
  }
}
// Gasto de hoy y del mes: el de esta app más el del Gateway de este PC (si lo hay).
let spentMemo = { rev: -1 };
function spent() {
  const day = today(), rev = `${usageRev}|${day}|${JSON.stringify(S.gwSpent || null)}`;
  if (spentMemo.rev === rev) return spentMemo.v;
  let d = 0, m = 0;
  for (const [k, v] of Object.entries(S.usage || {})) for (const x of Object.values(v)) { if (k === day) d += x.eur; if (monthOf(k) === monthOf(day)) m += x.eur; }
  const g = S.gwSpent && monthOf(S.gwSpent.date) === monthOf(day) ? S.gwSpent : null;
  const v = { day: d + (g?.date === day ? g.day : 0), month: m + (g ? g.month : 0), app: { day: d, month: m } };
  spentMemo = { rev, v };
  return v;
}
const overBudget = () => { const b = S.budget || {}, x = spent(); return (+b.day > 0 && x.day >= +b.day) || (+b.month > 0 && x.month >= +b.month); };
const eur = (x) => (x > 0 && x < 0.01 ? '< 0,01 €' : x.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' }));

// ---------- política de destinos: gasto y privacidad ----------
// "Gratis" solo si es comprobable: proveedor del nivel gratuito (en OpenRouter, variantes :free) o un equipo tuyo.
// Backend del puente que atiende un modelo MCP; el puente indica si es local (tu equipo o tu red privada).
const mcpBackend = (t) => S.mcp.find((s) => s.id === t.sid)?.backends?.find((b) => t.model.startsWith(b.id + '/'));
const localBackend = (t) => mcpBackend(t)?.local === true;
// Un puente puede reenviar a una API externa de pago: solo cuenta como gratis si su backend es local.
function isFree(t) {
  if (t.kind === 'mcp') return localBackend(t);
  const p = S.providers.find((x) => x.id === t.pid);
  return p?.tier === 'free' && (!p.freeOnly || /:free$/.test(t.model));
}
// "Privado": un equipo tuyo (puente de este PC o marcado como tuyo) y además con backend local.
const isMine = (t) => t.kind === 'mcp' && localBackend(t) && S.mcp.some((s) => s.id === t.sid && (s.local || s.mine));
const allowed = (t) => ((!S.freeOnly && !overBudget()) || isFree(t)) && (!thread().private || isMine(t));
const notAllowedWhy = (t) => (thread().private && !isMine(t) ? 'no es un equipo tuyo y este hilo es 🔒 PRIVADO' : S.freeOnly ? 'es de pago o de coste desconocido y tienes SOLO GRATIS activado' : 'has llegado a tu tope de gasto: hasta que se renueve solo se usan IAs gratuitas');
// Orden de intento: la elegida, luego las disponibles por calidad (otros proveedores primero) y al final las agotadas.
// Nunca incluye destinos que la política de gasto o privacidad no permite.
// needs.vision: el mensaje lleva imágenes; se evitan los modelos que ya las rechazaron.
function plan(first, needs = {}) {
  if (!first) return [];
  const own = allowed(first) && capable(first, needs) ? [first] : [];
  if (!S.autoSkip) return own;
  const rest = targets().filter((t) => t.key !== first.key && allowed(t) && capable(t, needs));
  const adj = (t) => score(t) - (t.pid && t.pid === first.pid ? 0.5 : 0) - (S.useTools && S.health[t.key]?.noTools ? 0.4 : 0);
  const ready = rest.filter((t) => !cooling(t.key)).sort((a, b) => adj(b) - adj(a));
  const cold = rest.filter((t) => cooling(t.key)).sort((a, b) => S.health[a.key].coolUntil - S.health[b.key].coolUntil);
  return [...own, ...ready, ...cold];
}
function coolText(k) {
  const h = S.health[k];
  if (h.reason === 'CLAVE') return 'CLAVE RECHAZADA';
  if (h.reason === 'RETIRADO') return 'YA NO DISPONIBLE';
  if (h.reason === 'LÍMITE') return 'LÍMITE DIARIO · hasta mañana';
  const until = new Date(h.coolUntil);
  return `${h.reason} · hasta ${until.toDateString() === new Date().toDateString() ? hhmm(h.coolUntil) : until.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
}

// ---------- llamadas a IAs ----------
function httpErr(status, body, headers) {
  let m = body;
  try { const j = JSON.parse(body); m = j.error?.message || j.message || j.error || body; } catch {}
  const e = new Error(String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 300));
  e.status = status;
  const ra = headers?.get?.('retry-after');
  if (ra) e.retryAfter = /^\d+(\.\d+)?$/.test(ra) ? Math.ceil(+ra) : Math.max(0, Math.ceil((Date.parse(ra) - Date.now()) / 1000)) || 0;
  if (!e.retryAfter && status === 429) e.retryAfter = parseWait('retry ' + (headers?.get?.('x-ratelimit-reset-requests') || '')) || 0;
  return e;
}
function netHint(e) {
  if (e.name === 'AbortError') return 'Cancelado';
  if (e instanceof TypeError && /fetch|network|load/i.test(e.message)) return 'Sin conexión: servidor apagado, CORS bloqueado o contenido mixto (http desde https).';
  return e.message;
}
const isCtxErr = (e) => e.status === 413 || /context.{0,20}(length|window|limit)|too (long|large)|maximum.{0,30}tokens|token.{0,10}limit|reduce the length|prompt is too long/i.test(e.message || '');
const textOf = (c) => (typeof c === 'string' ? c : (c || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'));

// Herramientas MCP disponibles para las IAs (todas menos las internas de Neura).
const INTERNAL = new Set(['chat', 'list_models', 'threads_sync', 'image_generate']);
function toolbox() {
  const list = [], used = new Set();
  for (const s of S.mcp) if (s.status === 'on') for (const t of s.tools || []) {
    // system_info revela nombre del PC e IPs internas: solo la usa la IA local (dentro del puente).
    if (INTERNAL.has(t.name) || t.name === 'system_info') continue;
    const base = t.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 56);
    let name = base, n = 2;
    while (used.has(name)) name = `${base}_${n++}`;
    used.add(name);
    list.push({ name, s, tool: t });
  }
  return list;
}
// Solo se confía en el puente de este PC o en servidores que autorizaste tú (el nombre que declara un servidor no cuenta).
const trusted = (s) => s.local || s.trustTools;
async function runTool(tb, name, rawArgs, signal, onTool) {
  const x = tb.find((y) => y.name === name);
  let args = rawArgs;
  if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = {}; } }
  if (!x) return `Herramienta desconocida: ${name}`;
  if (!trusted(x.s) && !confirm(`La IA quiere usar «${x.tool.name}» de ${x.s.name} con:\n${JSON.stringify(args).slice(0, 400)}\n\n¿Permitir?`)) {
    onTool?.({ name: x.tool.name, args, ok: false, server: x.s.name });
    return 'El usuario no permitió usar esta herramienta.';
  }
  try {
    const r = await mcpRpc(x.s, 'tools/call', { name: x.tool.name, arguments: args || {} }, { signal });
    let out = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (!out && r.structuredContent) out = JSON.stringify(r.structuredContent);
    onTool?.({ name: x.tool.name, args, ok: !r.isError, server: x.s.name });
    return out.slice(0, 20000) || '(sin resultado)';
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    onTool?.({ name: x.tool.name, args, ok: false, server: x.s.name });
    return 'Error: ' + netHint(e);
  }
}

async function readOpenAI(r, onText) {
  if (!(r.headers.get('content-type') || '').includes('event-stream')) {
    const j = await r.json();
    const msg = j.choices?.[0]?.message || {};
    const text = textOf(msg.content ?? '');
    onText(text);
    return { text, calls: msg.tool_calls || [] };
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', text = '';
  const calls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      if (j.error) throw httpErr(j.error.code || 0, JSON.stringify(j));
      const delta = j.choices?.[0]?.delta || {};
      if (delta.content) { text += delta.content; onText(text); }
      for (const tc of delta.tool_calls || []) {
        const c = (calls[tc.index ?? calls.length] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.function.name += tc.function.name;
        if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
      }
    }
  }
  return { text, calls: calls.filter(Boolean).map((c, k) => ({ ...c, id: c.id || `call_${k}` })) };
}

async function callOpenAI(p, model, messages, onDelta, signal, opt = {}) {
  const tb = opt.tools ? toolbox() : [];
  let tools = tb.map((x) => ({ type: 'function', function: { name: x.name, description: `[${x.s.name}] ${x.tool.description || ''}`.slice(0, 1000), parameters: x.tool.inputSchema || { type: 'object', properties: {} } } }));
  const headers = { 'Content-Type': 'application/json' };
  if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey;
  if (p.baseUrl.includes('openrouter.ai')) { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Neura'; }
  const post = (body) => xfetch(p.baseUrl.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers, signal, body: JSON.stringify(body) });
  const msgs = [...messages];
  let prefix = '';
  for (let round = 0; ; round++) {
    const body = { model, messages: msgs, stream: STREAM };
    if (tools.length && round < 6) body.tools = tools;
    let r = await post(body);
    if (!r.ok && body.tools && r.status === 400) {
      const t = await r.text();
      if (!/tool|function/i.test(t)) throw httpErr(400, t, r.headers);
      tools = []; delete body.tools; // el modelo no admite herramientas: se responde sin ellas y se recuerda
      H(`${p.id}::${model}`).noTools = true;
      r = await post(body);
    }
    if (!r.ok) throw httpErr(r.status, await r.text(), r.headers);
    const { text, calls } = await readOpenAI(r, (x) => onDelta(prefix + x));
    if (!calls.length || !body.tools) return prefix + text;
    if (text) prefix += text + '\n\n';
    msgs.push({ role: 'assistant', content: text || null, tool_calls: calls });
    for (const c of calls) msgs.push({ role: 'tool', tool_call_id: c.id, content: await runTool(tb, c.function.name, c.function.arguments, signal, opt.onTool) });
  }
}

// Anthropic: el sistema va aparte, las imágenes en su formato y las herramientas como tool_use/tool_result.
function toAnthropic(messages) {
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n\n');
  const msgs = messages.filter((m) => m.role !== 'system').map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((c) => {
      if (c.type !== 'image_url') return { type: 'text', text: c.text };
      const [, type, data] = c.image_url.url.match(/^data:([^;]+);base64,(.*)$/) || [];
      return { type: 'image', source: { type: 'base64', media_type: type, data } };
    }),
  }));
  return { system, msgs };
}
async function callAnthropic(p, model, messages, onDelta, signal, opt = {}) {
  const tb = opt.tools ? toolbox() : [];
  const tools = tb.map((x) => ({ name: x.name, description: `[${x.s.name}] ${x.tool.description || ''}`.slice(0, 1000), input_schema: x.tool.inputSchema || { type: 'object', properties: {} } }));
  const { system, msgs } = toAnthropic(messages);
  let prefix = '';
  for (let round = 0; ; round++) {
    const body = { model, max_tokens: 4096, messages: msgs };
    if (system) body.system = system;
    if (tools.length && round < 6) body.tools = tools;
    const r = await xfetch(p.baseUrl.replace(/\/+$/, '') + '/messages', {
      method: 'POST', signal, body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    if (!r.ok) throw httpErr(r.status, await r.text(), r.headers);
    const j = await r.json();
    const txt = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const uses = (j.content || []).filter((b) => b.type === 'tool_use');
    onDelta(prefix + txt);
    if (!uses.length || !body.tools) return prefix + txt;
    if (txt) prefix += txt + '\n\n';
    msgs.push({ role: 'assistant', content: j.content });
    const results = [];
    for (const u of uses) results.push({ type: 'tool_result', tool_use_id: u.id, content: await runTool(tb, u.name, u.input, signal, opt.onTool) });
    msgs.push({ role: 'user', content: results });
  }
}

async function callTarget(t, messages, onDelta, signal, opt = {}) {
  try { const out = await callTargetRaw(t, messages, onDelta, signal, opt); recordUse(t, messages, out); return out; }
  catch (e) { recordUse(t, messages, null, e); throw e; }
}
async function callTargetRaw(t, messages, onDelta, signal, opt = {}) {
  if (t.kind === 'mcp') {
    const s = S.mcp.find((x) => x.id === t.sid);
    if (!s) throw new Error('Servidor MCP eliminado');
    if (!s.sessionId) await mcpConnect(s, true);
    const args = { model: t.model, messages };
    // Con herramientas, el puente deja que el modelo local use los archivos compartidos del PC.
    if (opt.tools && (s.tools || []).some((x) => x.name === 'read_file')) args.tools = true;
    if (thread().private) args.local_only = true; // el puente también lo comprueba
    let acc = '';
    const r = await mcpRpc(s, 'tools/call', { name: 'chat', arguments: args }, { signal, onProgress: (d) => { acc += d; onDelta(acc); } });
    const txt = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(txt || 'Error MCP');
    for (const x of r.structuredContent?.tool_log || []) opt.onTool?.({ name: x.name, args: x.arguments, ok: x.ok, server: s.name });
    const text = r.structuredContent?.text ?? txt;
    onDelta(text); return text;
  }
  const p = S.providers.find((x) => x.id === t.pid);
  if (!p) throw new Error('IA eliminada');
  return (p.kind === 'anthropic' ? callAnthropic : callOpenAI)(p, t.model, messages, onDelta, signal, opt);
}

async function fetchModels(p) {
  const headers = p.kind === 'anthropic'
    ? { 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : (p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {});
  const r = await xfetch(p.baseUrl.replace(/\/+$/, '') + '/models', { headers });
  if (!r.ok) throw httpErr(r.status, await r.text(), r.headers);
  const j = await r.json();
  let list = j.data || j.models || [];
  if (p.freeOnly) list = list.filter((m) => String(m.id).endsWith(':free') || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0));
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name).replace(/^models\//, ''))
    .filter((id) => id && !/embed|imagen|veo|tts|whisper|transcri|dall-e|moderation|rerank|guard|safety|reward|parse|audio|live|image-generation|robotics|computer-use|aqa/i.test(id));
}
// Orden recomendado: Flash vigente primero (cuota gratuita amplia), Pro después (poca cuota gratis)
// y al final los experimentales o de vista previa, que fallan a menudo.
function modelRank(m) {
  return /preview|-exp(-|$)|experimental|alpha|beta|hydrogen/i.test(m) ? 5 : /\bpro\b/i.test(m) ? 4
    : /flash(-lite)?-latest$/.test(m) ? (/lite/.test(m) ? 1 : 0) : /-latest$/.test(m) ? 2 : 3;
}
// Una vez por sesión y proveedor: si un modelo ya no existe, se trae la lista vigente.
const refreshed = new Set();
async function refreshModels(p, quiet = false) {
  if (!p?.apiKey || refreshed.has(p.id)) return;
  refreshed.add(p.id);
  try {
    const list = await fetchModels(p);
    if (!list.length) return;
    p.models = list.sort((a, b) => modelRank(a) - modelRank(b));
    save(); renderTargets();
    if ($('#sheetAis').classList.contains('open')) renderProviders();
    if (!quiet) toast(`${p.name}: lista de modelos actualizada (${list.length})`);
  } catch {}
}

// ---------- cliente MCP (Streamable HTTP) ----------
// o.onProgress recibe los trozos de texto que el puente envía mientras el modelo escribe.
async function mcpRpc(s, method, params, o = {}) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!o.notify) body.id = ++rpcId;
  const token = o.onProgress ? 'neura-' + body.id : null;
  if (token) body.params = { ...body.params, _meta: { progressToken: token } };
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  if (s.sessionId) headers['Mcp-Session-Id'] = s.sessionId;
  if (s.protocolVersion) headers['MCP-Protocol-Version'] = s.protocolVersion;
  const r = await xfetch(s.url, { method: 'POST', headers, body: JSON.stringify(body), signal: o.signal });
  const sid = r.headers.get('Mcp-Session-Id'); if (sid) s.sessionId = sid;
  if (r.status === 404 && s.sessionId && !o.retried && method !== 'initialize') {
    await mcpConnect(s, true); return mcpRpc(s, method, params, { ...o, retried: true });
  }
  if (o.notify) return;
  if (!r.ok) throw httpErr(r.status, await r.text(), r.headers);
  let msg;
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    const handle = (line) => {
      if (!line.startsWith('data:')) return;
      let j; try { j = JSON.parse(line.slice(5)); } catch { return; }
      if (j.method === 'notifications/progress' && token && j.params?.progressToken === token) { if (typeof j.params.message === 'string') o.onProgress(j.params.message); }
      else if (j.id === body.id) msg = j;
    };
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    }
    handle(buf.trim());
  } else msg = await r.json();
  if (!msg) throw new Error('Respuesta MCP vacía');
  if (msg.error) throw new Error(msg.error.message || 'Error MCP');
  return msg.result;
}

async function mcpConnect(s, quiet) {
  s.status = 'wait'; s.sessionId = null; s.protocolVersion = null; renderMcp();
  try {
    const init = await mcpRpc(s, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'neura-app', version: '2.0.0' } });
    s.protocolVersion = init.protocolVersion; s.serverInfo = init.serverInfo;
    await mcpRpc(s, 'notifications/initialized', undefined, { notify: true });
    const tl = await mcpRpc(s, 'tools/list', {});
    s.tools = (tl.tools || []).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    s.models = []; s.backends = [];
    if (s.tools.some((t) => t.name === 'list_models') && s.tools.some((t) => t.name === 'chat')) {
      const r = await mcpRpc(s, 'tools/call', { name: 'list_models', arguments: {} });
      let data = r.structuredContent;
      if (!data) try { data = JSON.parse(r.content?.[0]?.text || '{}'); } catch { data = {}; }
      s.models = (data.models || []).map((m) => (typeof m === 'string' ? m : m.id));
      s.backends = data.backends || [];
      s.images = data.images || [];
    }
    s.status = 'on'; s.error = null;
    if (!quiet) toast(`${s.name}: CONECTADO · ${s.models.length} modelos`);
    syncWith(s);
  } catch (e) {
    s.status = 'err'; s.error = netHint(e);
    if (!quiet) toast(`${s.name}: ${s.error}`, true);
    if (quiet) { save(); renderMcp(); renderTargets(); throw e; }
  }
  save(); renderMcp(); renderTargets();
}

// ---------- sincronización de hilos ----------
const canSync = (s) => s.status === 'on' && s.sync !== false && (s.tools || []).some((t) => t.name === 'threads_sync');
async function syncWith(s) {
  if (!canSync(s) || s.syncing) return;
  s.syncing = true;
  const startedAt = Date.now();
  try {
    // Solo se envía lo cambiado desde la última vez; los mensajes a medias no salen del dispositivo.
    // Los hilos privados solo se copian a tus equipos.
    const out = S.threads.filter((t) => t.ts > (s.pushedAt || 0) && (t.deleted || t.messages.length) && (!t.private || s.local || s.mine))
      .map((t) => portable({ ...t, messages: t.messages.filter((m) => !m.pending) }));
    const newer = (list) => list.filter((x) => (x.updatedAt || 0) > (s.pushedAt || 0));
    const collections = { skills: newer(S.skills), projects: newer(S.projects) };
    const r = await mcpRpc(s, 'tools/call', { name: 'threads_sync', arguments: { since: s.syncRev || 0, threads: out, collections } });
    if (r.isError) throw new Error(r.content?.[0]?.text || 'Error al sincronizar');
    const data = r.structuredContent || JSON.parse(r.content?.[0]?.text || '{}');
    let changed = false;
    for (const t of data.threads || []) {
      const i = S.threads.findIndex((x) => x.id === t.id);
      const local = S.threads[i];
      if (local?.messages.some((m) => m.pending)) continue; // respuesta en curso: se fusiona en la próxima
      const merged = mergeThread(local, t);
      if (JSON.stringify(merged) === JSON.stringify(local)) continue;
      if (i >= 0) S.threads[i] = merged; else S.threads.push(merged);
      changed = true;
    }
    // Habilidades y proyectos: gana la versión más reciente (también los borrados).
    for (const [name, items] of Object.entries(data.collections || {})) {
      const list = S[name];
      if (!['skills', 'projects'].includes(name) || !Array.isArray(items)) continue;
      for (const it of items) {
        const i = list.findIndex((x) => x.id === it.id);
        if (i < 0) list.push(it); else if ((it.updatedAt || 0) > (list[i].updatedAt || 0)) list[i] = it; else continue;
        changed = true;
      }
    }
    if (changed) persistFiles();
    s.syncRev = data.rev; s.pushedAt = startedAt; s.syncedAt = Date.now(); s.syncError = null;
    save();
    if (changed && !busy) {
      renderLog();
      if ($('#sheetThreads').classList.contains('open')) renderThreads();
      if ($('#sheetSkills').classList.contains('open') && !skDraft) renderSkills();
    }
  } catch (e) { s.syncError = netHint(e); }
  finally { s.syncing = false; if ($('#sheetMcp').classList.contains('open')) renderMcp(); }
}
const syncAll = () => S.mcp.forEach((s) => syncWith(s));

// ---------- contexto: historial, resúmenes y recorte ----------
// Las imágenes solo se reenvían en los últimos mensajes; antes quedan como una nota de texto.
function userContent(m, withImg) {
  let text = m.content || '';
  for (const f of m.files || []) if (f.kind === 'text') text += `\n\n[Archivo adjunto: ${f.name}${f.pdf ? ' — al usar su contenido, cita la página así: (pág. N)' : ''}]\n\`\`\`\n${f.text}\n\`\`\``;
  const imgs = (m.files || []).filter((f) => f.kind === 'image' && f.data);
  if (!imgs.length) return text;
  if (!withImg) return text + imgs.map((f) => `\n[Imagen adjunta: ${f.name}]`).join('');
  return [{ type: 'text', text: text || 'Describe la imagen.' }, ...imgs.map((f) => ({ type: 'image_url', image_url: { url: f.data } }))];
}
// De un CONSEJO solo pasa al historial la síntesis (o la primera respuesta válida).
function groupBest(msgs, g) {
  const ok = msgs.filter((m) => m.group === g && !m.error && !m.pending && m.content);
  return ok.find((m) => m.synth) || ok[0];
}
function buildHistory(th) {
  const msgs = th.messages, h = [], seen = new Set();
  let start = 0;
  if (th.summary?.upto) {
    const k = msgs.findIndex((m) => m.id === th.summary.upto);
    if (k >= 0) { start = k + 1; h.push({ role: 'system', content: 'Resumen de la conversación anterior (úsalo como contexto):\n' + th.summary.text }); }
  }
  for (let i = start; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'user') h.push({ role: 'user', content: userContent(m, i >= msgs.length - 6) });
    else if (m.group) { if (seen.has(m.group)) continue; seen.add(m.group); const b = groupBest(msgs, m.group); if (b) h.push({ role: 'assistant', content: b.content }); }
    else if (m.content && !m.error && !m.pending) h.push({ role: 'assistant', content: m.content });
  }
  return h;
}
const tok = (m) => Math.ceil((typeof m.content === 'string' ? m.content.length : m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 3000), 0)) / 3.5) + 4;
const tokens = (h) => h.reduce((n, m) => n + tok(m), 0);
function trimTo(h, budget) {
  const out = [...h];
  while (out.length > 2 && tokens(out) > budget) out.splice(out[0].role === 'system' ? 1 : 0, 1);
  return out;
}
// Petición auxiliar (resúmenes, crear habilidades…) a la primera IA disponible y permitida; con preferMine, antes tus equipos.
async function ask(messages, signal, preferMine = false) {
  const all = targets().filter((t) => !cooling(t.key));
  const mine = preferMine ? [...all.filter(isMine), ...all.filter((t) => t.kind === 'mcp')] : [];
  const order = [...mine, ...plan(findT(S.target))]
    .filter((t, i, a) => t && !cooling(t.key) && allowed(t) && a.findIndex((x) => x?.key === t.key) === i);
  let last;
  for (const t of order.slice(0, 3)) {
    try { const r = noThink(await callTarget(t, messages, () => {}, signal)); if (r.trim()) return { text: r.trim(), t }; }
    catch (e) { if (e.name === 'AbortError') throw e; noteFail(t, e); last = e; }
  }
  throw last || new Error('No hay ninguna IA disponible');
}
// Para resumir se prefiere la IA local (gratis y sin límites), luego la elegida y luego las demás disponibles.
const summarize = async (messages, signal) => (await ask(messages, signal, true)).text;
// Si el historial no cabe, lo antiguo se resume (y se guarda en el hilo) y se envía resumen + lo reciente.
async function fitContext(th, hist, budget, signal) {
  if (tokens(hist) <= budget) return hist;
  const done = th.messages.filter((m) => !m.pending);
  const cut = done.length - 4;
  const from = th.summary?.upto ? done.findIndex((m) => m.id === th.summary.upto) + 1 : 0;
  const chunk = cut > from ? done.slice(from, cut) : [];
  if (!chunk.length) return trimTo(hist, budget);
  const transcript = chunk.map((m) => (m.role === 'user' ? `USUARIO: ${textOf(userContent(m, false))}` : m.content && !m.error ? `IA: ${m.content}` : ''))
    .filter(Boolean).join('\n\n').slice(-Math.max(12000, budget * 3));
  const prompt = [
    { role: 'system', content: 'Resumes conversaciones para que otra IA pueda continuarlas. Escribe en el idioma de la conversación, en viñetas, máximo 300 palabras. Conserva datos concretos, nombres, cifras, código importante, decisiones, preferencias del usuario y tareas pendientes.' },
    { role: 'user', content: (th.summary?.text ? `Resumen previo:\n${th.summary.text}\n\n` : '') + `Conversación a resumir:\n${transcript}` },
  ];
  try {
    const text = await summarize(prompt, signal);
    th.summary = { text, upto: chunk[chunk.length - 1].id, ts: Date.now() };
    th.ts = Date.now(); save();
    return trimTo(buildHistory(th), budget);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    return trimTo(hist, budget);
  }
}

// ---------- envío ----------
// Errores que merecen probar otra IA: cuota agotada, sobrecarga, sin conexión, clave inválida.
const skippable = (e) => e.name !== 'AbortError' && (!e.status || e.status === 429 || e.status >= 500 || e.status === 402 || isKeyErr(e) || isGone(e) || isNoVision(e));
function friendly(e) {
  if (e.name === 'AbortError') return 'Cancelado';
  if (isGone(e)) return 'Este modelo ya no está disponible. Neura ha actualizado la lista de modelos.';
  if (isNoVision(e)) return 'Este modelo no admite imágenes.';
  if (e.status === 429 || /quota|rate.?limit|exhausted/i.test(e.message || '')) return 'Cuota gratuita agotada por ahora.';
  if (isKeyErr(e)) return 'La clave API no es válida. Revísala en ⚙.';
  if (e.status === 402) return 'Sin saldo en esta cuenta.';
  if (e.status >= 500) return 'El servicio falló o está saturado.';
  if (isCtxErr(e)) return 'La conversación es demasiado larga para este modelo.';
  if (!e.status) return netHint(e);
  return 'La IA devolvió un error.';
}
function failMsg(msg, e, t) {
  msg.pending = false; msg.content = '';
  msg.error = friendly(e);
  msg.detail = (e.status ? `[${e.status}] ` : '') + netHint(e);
  noteFail(t, e);
}
// Algunos modelos escriben su razonamiento interno (a menudo en inglés) entre <think>…</think>.
const noThink = (s) => String(s || '').replace(/<(think|thinking|thought)>[\s\S]*?(<\/\1>|$)/gi, '').trimStart();
const liveSkills = () => S.skills.filter((k) => !k.deleted);
const activeSkill = () => { const id = thread().skill; return id ? liveSkills().find((k) => k.id === id) : null; };
const activeProject = () => { const id = thread().project; return id ? S.projects.find((p) => p.id === id && !p.deleted) : null; };
// Se reconstruye en cada petición desde la versión guardada: no depende de que el resumen del historial la recuerde.
function withInstructions(hist, skill = activeSkill()) {
  const sys = [];
  if (S.instructions?.trim()) sys.push(S.instructions.trim());
  const pr = activeProject();
  if (pr?.memory?.trim()) sys.push(`Proyecto «${pr.name}». Información y preferencias que debes tener en cuenta:\n${pr.memory.trim()}`);
  if (skill) sys.push(`Habilidad activa: «${skill.name}» (v${skill.version}). Sigue este procedimiento:\n\n${skill.instructions}`);
  return sys.length ? [{ role: 'system', content: sys.join('\n\n---\n\n') }, ...hist] : hist;
}
// skill: la versión fijada al enviar; una sincronización durante los reintentos no la cambia.
async function runTarget(t, hist, msg, signal, tools, sk = null) {
  const t0 = performance.now();
  msg.tools = [];
  if (sk) msg.skill = { id: sk.id, v: sk.version, name: sk.name };
  // A un modelo sin visión, las imágenes de mensajes anteriores le llegan como una nota de texto.
  if (S.health[t.key]?.noVision) hist = hist.map((m) => (Array.isArray(m.content) ? { ...m, content: `${textOf(m.content)}\n[imagen adjunta, no visible para este modelo]` } : m));
  const out = await callTarget(t, withInstructions(hist, sk), (x) => { msg.content = noThink(x); schedule(msg); }, signal, {
    tools, onTool: (rec) => { msg.tools.push(rec); schedule(msg); },
  });
  msg.content = noThink(out) || msg.content || '(respuesta vacía)';
  msg.ms = Math.round(performance.now() - t0);
  msg.pending = false;
  noteOk(t, msg.ms);
}

async function send(text, files = []) {
  const th = thread(), msgs = th.messages;
  if (!msgs.length) th.title = (text || files[0]?.name || 'HILO').slice(0, 48);
  th.ts = Date.now();
  msgs.push({ id: uid(), role: 'user', content: text, ...(files.length ? { files } : {}), ts: Date.now() });
  save();
  setBusy(true);
  const signal = abortCtl.signal;
  if (DESK && (+S.budget?.day || +S.budget?.month)) await refreshGwUsage();
  try {
    const skill = activeSkill() && JSON.parse(JSON.stringify(activeSkill()));
    // El presupuesto cuenta toda la petición (instrucciones, memoria del proyecto y habilidad) y deja sitio para la respuesta.
    const RESERVE = 800;
    const budget = Math.max(800, S.ctxTokens - tokens(withInstructions([], skill)) - RESERVE);
    let hist = await fitContext(th, buildHistory(th), budget, signal);
    renderLog();
    const task = taskOf(text), routed = routeFor(task);
    const userMsg = [...msgs].reverse().find((m) => m.role === 'user');
    userMsg.task = task;
    if (routed && routed.key !== S.target) userMsg.routed = routed.label;
    const first = routed || findT(S.target);
    // Solo cuenta si el mensaje actual lleva imágenes; las de mensajes anteriores se adaptan por modelo.
    const needs = { vision: Array.isArray(hist[hist.length - 1]?.content) };
    const queue = plan(first, needs);
    if (first && allowed(first) && !capable(first, needs)) msgs.push({ id: uid(), role: 'assistant', label: first.label, error: '📷 no admite imágenes', skipped: true, ts: Date.now() });
    if (first && !allowed(first)) msgs.push({ id: uid(), role: 'assistant', label: first.label, error: `⛔ ${notAllowedWhy(first)}`, skipped: true, ts: Date.now() });
    if (!first) msgs.push({ id: uid(), role: 'assistant', error: 'No hay IAs conectadas. Añade una en ⚙ o conecta un servidor en ⬡.', ts: Date.now() });
    else if (!queue.length) msgs.push({ id: uid(), role: 'assistant', error: th.private ? 'Este hilo es 🔒 PRIVADO y no hay ninguno de tus equipos conectado (⬡).' : S.freeOnly ? 'Con SOLO GRATIS activado no hay ninguna IA gratuita disponible ahora.' : 'Has llegado a tu tope de gasto (⚙ → CONSUMO) y no hay ninguna IA gratuita disponible ahora.', ts: Date.now() });
    else if (S.council) await sendCouncil(th, hist, first, signal, needs, skill);
    else {
      let attempts = 0, ctxRetried = false;
      for (let qi = 0; qi < queue.length && attempts < MAX_ATTEMPTS; qi++) {
        const t = queue[qi];
        // La elegida está agotada: se avisa y se pasa a la siguiente sin gastar una petición.
        if (S.autoSkip && cooling(t.key) && queue.slice(qi + 1).some((x) => !cooling(x.key))) {
          if (qi === 0) msgs.push({ id: uid(), role: 'assistant', label: t.label, error: `⏳ ${coolText(t.key)}`, skipped: true, ts: Date.now() });
          continue;
        }
        attempts++;
        const msg = { id: uid(), role: 'assistant', label: t.label, key: t.key, content: '', pending: true, ts: Date.now() };
        msgs.push(msg); renderLog();
        try { await runTarget(t, hist, msg, signal, S.useTools, skill); break; }
        catch (e) {
          if (isCtxErr(e) && !ctxRetried) {
            // No cabía en el contexto de este modelo: se comprime a la mitad y se reintenta con la misma IA.
            ctxRetried = true;
            hist = await fitContext(th, hist, Math.floor(tokens(hist) / 2), signal);
            msgs.splice(msgs.indexOf(msg), 1);
            qi--; attempts--;
            continue;
          }
          failMsg(msg, e, t);
          msg.skipped = S.autoSkip && skippable(e) && qi < queue.length - 1 && attempts < MAX_ATTEMPTS;
          if (!msg.skipped) break;
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') msgs.push({ id: uid(), role: 'assistant', error: netHint(e), ts: Date.now() });
  }
  msgs.forEach((m) => { if (m.pending) { m.pending = false; m.error ||= 'Cancelado'; } });
  th.ts = Date.now(); setBusy(false); learnProgress(); save(); renderLog(); renderTargets(); syncAll();
}

// ---------- enrutado por tipo de tarea y votos ----------
// Neura reconoce el tipo de petición por sus palabras y usa la IA que hayas asignado a ese tipo
// (o la que más has votado como mejor en el CONSEJO). Si no está disponible, sigue la elegida arriba.
// Palabras completas también con tildes (\b de JavaScript no reconoce «é» como letra). Sin «lookbehind»: iOS antiguos no lo admiten.
const W = (words) => new RegExp(`(^|[^\\p{L}\\p{N}])(${words})(?![\\p{L}\\p{N}])`, 'iu');
const TASKS = [
  { id: 'codigo', name: '💻 Código', re: /```/, words: W('código|codigo|programa|script|funci[oó]n|bug|compila\\w*|python|javascript|typescript|java|sql|html|css|regex|json|depura\\w*|refactori[zc]a\\w*|stack ?trace') },
  { id: 'resumen', name: '📝 Resumir', words: W('resume|resúmeme|resumen|resumir|sintetiza|tl;?dr|puntos clave|en pocas palabras') },
  { id: 'razonar', name: '🧠 Razonar', words: W('por qué|razona|analiza|demuestra|calcula|problema|lógica|matemátic\\w*|ecuaci[oó]n|ventajas y desventajas|estrategia|decide|qué es mejor') },
  { id: 'redactar', name: '✍️ Redactar', words: W('redacta|escríbeme|escribe un\\w*|correo|email|carta|artículo|publicación|historia|poema|traduce|reescribe|corrige (el|este|mi) texto') },
];
const taskOf = (text) => (TASKS.find((t) => t.re?.test(text || '') || t.words.test(text || '')) || { id: 'general' }).id;
const taskName = (id) => TASKS.find((t) => t.id === id)?.name || '💬 General';
function mostVoted(cat) {
  const v = S.votes?.[cat] || {};
  return Object.entries(v).filter(([k, n]) => n > 0 && findT(k)).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
// Devuelve la IA para este tipo de tarea, o null si no hay regla o no está disponible ahora.
function routeFor(cat) {
  if (!S.routing?.on) return null;
  const rule = S.routing.rules?.[cat] ?? 'votes';
  const k = rule === 'votes' ? mostVoted(cat) : rule;
  const t = k && findT(k);
  return t && allowed(t) && !cooling(t.key) ? t : null;
}
function vote(id) {
  const th = thread(), m = th.messages.find((x) => x.id === id);
  if (!m?.group || !m.key) return;
  const i = th.messages.indexOf(m);
  const q = th.messages.slice(0, i).reverse().find((x) => x.role === 'user');
  const cat = q?.task || taskOf(q?.content);
  const V = ((S.votes ||= {})[cat] ||= {});
  // Un voto por consejo: si ya habías elegido otra respuesta, se cambia.
  for (const x of th.messages) if (x.group === m.group && x.voted) { x.voted = false; V[x.key] = Math.max(0, (V[x.key] || 0) - 1); }
  m.voted = true; V[m.key] = (V[m.key] || 0) + 1;
  save(); renderLog();
  toast(`👍 Anotado: para ${taskName(cat)} prefieres ${m.label} (${V[m.key]} ${V[m.key] === 1 ? 'voto' : 'votos'})${S.routing?.on ? '' : ' · actívalo en ⚙ → ENRUTADO POR TAREA'}`);
}
function routingHTML() {
  const all = targets(), rt = S.routing || {};
  const opts = (cat) => {
    const cur = rt.rules?.[cat] ?? 'votes', mv = mostVoted(cat);
    return `<option value="" ${cur === '' ? 'selected' : ''}>— la elegida arriba —</option><option value="votes" ${cur === 'votes' ? 'selected' : ''}>👍 la más votada${mv ? ` (${esc(findT(mv)?.label)})` : ' (aún sin votos)'}</option>`
      + all.map((t) => `<option value="${esc(t.key)}" ${cur === t.key ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  };
  return `<h3>🧭 ENRUTADO POR TAREA</h3>
    <label class="auto"><input type="checkbox" id="routeOn" ${rt.on ? 'checked' : ''}> ELEGIR LA IA SEGÚN EL TIPO DE PETICIÓN</label>
    <p class="hint">Neura reconoce si pides código, un resumen, razonar o redactar, y usa la IA que pongas para ese tipo. Con «la más votada» usa la que más veces elegiste con 👍 MEJOR en el CONSEJO. Si no está disponible, responde la elegida arriba y sigue AUTO-SALTO.</p>
    ${rt.on ? `<div class="routes">${[...TASKS, { id: 'general' }].map((t) => `<label class="field">${taskName(t.id)}<select data-route="${t.id}">${opts(t.id)}</select></label>`).join('')}</div>` : ''}`;
}

// ---------- imágenes en tu equipo: /imagen <prompt> ----------
// Las genera el puente de tu PC con ComfyUI o Forge/AUTOMATIC1111: gratis, sin cuentas y sin salir de tu equipo.
const imageServers = (th) => S.mcp.filter((s) => s.status === 'on' && (s.tools || []).some((t) => t.name === 'image_generate') && (!th.private || s.local || s.mine))
  .sort((a, b) => (b.images || []).some((i) => i.online) - (a.images || []).some((i) => i.online));
async function sendImage(raw) {
  const th = thread(), msgs = th.messages;
  if (!msgs.length) th.title = raw.slice(0, 48);
  th.ts = Date.now();
  msgs.push({ id: uid(), role: 'user', content: raw, ts: Date.now() });
  // «Evitar:» en una línea aparte = prompt negativo (como lo escribe la habilidad «Prompt para imagen»).
  const [prompt, negative = ''] = raw.replace(/^\/imagen\s*/i, '').split(/\n\s*Evitar:\s*/i);
  const srv = imageServers(th)[0];
  const fail = (error) => msgs.push({ id: uid(), role: 'assistant', label: '🖼 IMAGEN', error, ts: Date.now() });
  if (!prompt.trim()) fail('Escribe qué imagen quieres después de /imagen. Ejemplo: /imagen un faro al atardecer, acuarela');
  else if (!srv) fail(th.private ? 'Este hilo es 🔒 PRIVADO y no hay ninguno de tus equipos con imágenes conectado (⬡).' : 'Para crear imágenes gratis hace falta Neura para PC (o el puente) con ComfyUI o Forge en ese equipo. Mira ⬡ → 🖼 IMÁGENES EN ESTE PC.');
  else {
    setBusy(true);
    const msg = { id: uid(), role: 'assistant', label: `🖼 ${srv.name}`, content: '', pending: true, ts: Date.now() };
    msgs.push(msg); save(); renderLog();
    try {
      const t0 = performance.now();
      const r = await mcpRpc(srv, 'tools/call', { name: 'image_generate', arguments: { prompt: prompt.trim(), negative: negative.trim() } }, { signal: abortCtl.signal });
      const txt = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      if (r.isError) throw new Error(txt.replace(/^Error:\s*/, ''));
      const img = (r.content || []).find((c) => c.type === 'image');
      if (!img?.data) throw new Error('El equipo no devolvió ninguna imagen');
      Object.assign(msg, { pending: false, content: txt, ms: Math.round(performance.now() - t0), label: `🖼 ${srv.name} / ${r.structuredContent?.backend || 'imagen'}`,
        files: [{ kind: 'image', name: `${safeName(prompt)}.png`, data: `data:${img.mimeType || 'image/png'};base64,${img.data}` }] });
      await persistFiles();
    } catch (e) { Object.assign(msg, { pending: false, error: e.name === 'AbortError' ? 'Cancelado' : e.message }); }
    setBusy(false);
  }
  th.ts = Date.now(); save(); renderLog(); syncAll();
}
async function saveImage(id) {
  const f = thread().messages.find((m) => m.id === id)?.files?.find((x) => x.kind === 'image' && x.data);
  if (!f) return;
  if (DESK) { const p = await DESK.saveFile(f.name, f.data.split(',')[1], 'base64'); if (p) toast('GUARDADO: ' + p); return; }
  const blob = toBlob(f.data), file = new File([blob], f.name, { type: blob.type });
  if (CAP && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: f.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = f.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------- CONSEJO: varias IAs a la vez y una síntesis final ----------
function councilMembers(first, needs = {}) {
  const chosen = S.councilKeys.map(findT).filter((t) => t && !cooling(t.key) && allowed(t) && capable(t, needs));
  if (chosen.length >= 2) return chosen.slice(0, 5);
  const seen = new Set(), out = [];
  for (const t of plan(first, needs)) {
    if (cooling(t.key)) continue;
    const prov = t.pid || t.sid;
    if (seen.has(prov)) continue;
    seen.add(prov); out.push(t);
    if (out.length === 3) break;
  }
  return out;
}
async function sendCouncil(th, hist, first, signal, needs = {}, skill = null) {
  const group = uid();
  const members = councilMembers(first, needs);
  const runs = members.map((t) => {
    const msg = { id: uid(), role: 'assistant', label: t.label, key: t.key, content: '', pending: true, group, ts: Date.now() };
    th.messages.push(msg);
    return { t, msg };
  });
  renderLog();
  await Promise.all(runs.map(async ({ t, msg }) => {
    try { await runTarget(t, hist, msg, signal, S.useTools, skill); }
    catch (e) { failMsg(msg, e, t); }
    schedule(msg);
  }));
  const good = runs.filter((r) => !r.msg.error);
  if (good.length < 2 || signal.aborted) { renderLog(); return; }
  const question = textOf(hist[hist.length - 1]?.content);
  const prompt = [{ role: 'user', content: `Pregunta del usuario:\n${question}\n\nRespuestas de varias IAs:\n\n${good.map((r, i) => `### Respuesta ${i + 1} (${r.t.label})\n${r.msg.content}`).join('\n\n')}\n\nEscribe la mejor respuesta final para el usuario: combina lo correcto de cada una y corrige errores. No hables de "las respuestas" ni de que eres un moderador; responde directamente. Termina SIEMPRE con un apartado titulado "⚠️ Desacuerdos y puntos a comprobar" que liste en viñetas dónde discrepan las IAs o qué afirmaciones conviene verificar; si no hay ninguno, escribe "Sin desacuerdos relevantes".` }];
  const syn = { id: uid(), role: 'assistant', label: '⚖ SÍNTESIS', group, synth: true, content: '', pending: true, ts: Date.now() };
  th.messages.push(syn); renderLog();
  const judges = [first, ...good.map((r) => r.t)].filter((t, i, a) => !cooling(t.key) && allowed(t) && a.findIndex((x) => x.key === t.key) === i);
  for (const t of judges.slice(0, 3)) {
    syn.label = `⚖ SÍNTESIS · ${t.label}`; syn.error = null; syn.pending = true;
    try { await runTarget(t, prompt, syn, signal, false); break; }
    catch (e) { failMsg(syn, e, t); if (e.name === 'AbortError') break; }
  }
}

function setBusy(b) {
  busy = b;
  abortCtl = b ? new AbortController() : null;
  const btn = $('#send');
  btn.classList.toggle('abort', b);
  btn.firstElementChild.textContent = b ? 'PARAR' : 'ENVIAR';
}

// ---------- render ----------
const CAN_SPEAK = 'speechSynthesis' in window;
function filesHTML(m) {
  return (m.files || []).map((f) => (f.missing || f[field(f)] == null ? `<span class="chip off">⚠️ ${esc(f.name)} (no disponible)</span>`
    : f.kind === 'image' ? `<img class="thumb" src="${esc(f.data)}" alt="${esc(f.name)}">`
    : `<span class="chip">📄 ${esc(f.name)}</span>`)).join('');
}
function replyHTML(m) {
  if (m.error) {
    const detail = m.detail ? `<details><summary>detalle técnico</summary>${esc(m.detail)}</details>` : '';
    if (m.skipped) return `<div class="reply err skip"><div class="txt">✕ ${esc(m.label || 'NEURA')}: ${esc(m.error)} → probando otra IA${detail}</div></div>`;
    return `<div class="reply err"><div class="tag"><span>✕ ${esc(m.label || 'NEURA')}</span></div><div class="txt">${esc(m.error)}${detail}</div></div>`;
  }
  const voteBtn = m.group && !m.synth && !m.pending && m.key ? (m.voted ? '<span class="chip voted">👍 ELEGIDA</span>' : `<button data-vote="${m.id}" title="Marca la mejor respuesta: Neura aprende qué IA prefieres para este tipo de tarea">👍 MEJOR</button>`) : '';
  const tools = (m.tools || []).length ? `<div class="chips">${m.tools.map((x) => `<span class="chip tool ${x.ok ? '' : 'off'}" title="${esc(JSON.stringify(x.args ?? {}))}">ƒ ${esc(x.name)}</span>`).join('')}</div>` : '';
  const acts = m.pending ? '<span class="processing">PROCESANDO</span>'
    : `${voteBtn}${m.ms ? `<small class="ms">${(m.ms / 1000).toFixed(1)} s</small>` : ''}${CAN_SPEAK ? `<button data-speak="${m.id}">LEER</button>` : ''}${m.files?.some((f) => f.kind === 'image' && f.data) ? `<button data-saveimg="${m.id}">GUARDAR</button>` : ''}<button data-copy="${m.id}">COPIAR</button><button data-skillify="${m.id}" title="Crear una habilidad reutilizable a partir de esta respuesta">✦ HABILIDAD</button><button data-branch="${m.id}" title="Nuevo hilo con la conversación hasta aquí">⑂ RAMA</button>`;
  const skill = m.skill ? `<span class="chip skill">✦ ${esc(m.skill.name)} · v${m.skill.v}</span>` : '';
  const files = m.files?.length ? `<div class="files gen">${filesHTML(m)}</div>` : '';
  return `<div class="reply ${m.pending ? 'pending' : ''} ${m.synth ? 'synth' : ''}" data-id="${m.id}"><div class="tag"><span>${esc(m.label)} ${skill}</span><span class="acts">${acts}</span></div>${tools}${files}<div class="txt">${md(m.content)}</div></div>`;
}
function msgHTML(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="tag">▶ TÚ // ${hhmm(m.ts)}${m.routed ? ` <span class="chip route" title="ENRUTADO POR TAREA">🧭 ${esc(taskName(m.task))} → ${esc(m.routed)}</span>` : ''}<span class="acts"><button data-edit="${m.id}" title="Editar y reenviar en una rama (el original se conserva)">✎ EDITAR</button><button data-branch="${m.id}" title="Nuevo hilo con la conversación hasta aquí">⑂ RAMA</button></span></div><div class="body">${esc(m.content)}${m.files?.length ? `<div class="files">${filesHTML(m)}</div>` : ''}</div></div>`;
  return `<div class="msg">${replyHTML(m)}</div>`;
}
function logHTML(th) {
  const msgs = th.messages, out = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.group) {
      const g = [];
      while (i < msgs.length && msgs[i].group === m.group) g.push(msgs[i++]);
      i--;
      const answers = g.filter((x) => !x.synth), synth = g.find((x) => x.synth);
      out.push(`<div class="msg council"><div class="tag">⚖ CONSEJO · ${answers.length} IAs</div><div class="cgrid">${answers.map(replyHTML).join('')}</div>${synth ? replyHTML(synth) : ''}</div>`);
    } else out.push(msgHTML(m));
    if (th.summary?.upto === m.id && i < msgs.length - 1) {
      out.push(`<details class="note"><summary>🗜 Lo anterior se resumió para ahorrar tokens · VER RESUMEN</summary><div class="txt">${md(th.summary.text)}</div></details>`);
    }
  }
  return out.join('');
}

function renderLog() {
  const log = $('#log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const th = thread();
  $('#private').checked = !!th.private;
  const sk = activeSkill();
  $('#btnSkills').textContent = sk ? `✦ ${sk.name.toUpperCase()} · v${sk.version}` : '✦ HABILIDADES';
  $('#btnSkills').classList.toggle('on', !!sk);
  const pr = activeProject();
  $('#btnThreads').textContent = pr ? '📁' : '≡';
  $('#btnThreads').title = pr ? `Hilos · proyecto ${pr.name}` : 'Hilos guardados';
  if (!th.messages.length) {
    const n = targets().length;
    log.innerHTML = `<div class="empty">
      <svg viewBox="0 0 40 46" class="biglogo" aria-hidden="true">${$('.logo').innerHTML}</svg>
      <div class="big">NEURA</div><div class="sub">ESPERANDO ENTRADA</div>
      ${S.providers.length || S.wizardDone ? '' : wizardHTML()}
      ${S.level === 'basic' ? `<div class="tips"><b>💡 CÓMO USAR BIEN LAS IAs</b><ul>${TIPS.map((t) => `<li>${t}</li>`).join('')}</ul></div>${targets().length ? learnHTML(true) : ''}` : ''}
      <ol><li>${n ? `<b>${n} modelos</b> conectados.` : 'Pulsa <b>⚙</b> y añade IAs públicas con su clave gratuita (Gemini, Groq, OpenRouter…).'}</li>
      <li>Pulsa <b>⬡</b> para conectar tu IA local mediante un servidor MCP.</li>
      <li><b>AUTO-SALTO</b>: si una IA agota sus tokens gratis, contesta otra.</li>
      <li><b>⚖ CONSEJO</b>: pregunta a varias IAs a la vez y recibe la mejor respuesta combinada.</li></ol></div>`;
    renderLocalAI();
    return;
  }
  log.innerHTML = logHTML(th);
  if (stick) log.scrollTop = log.scrollHeight;
}

const pend = new Set();
function schedule(m) {
  if (pend.has(m)) return;
  pend.add(m);
  requestAnimationFrame(() => {
    pend.delete(m);
    const el = document.querySelector(`.reply[data-id="${m.id}"]`);
    if (!el) return renderLog();
    const log = $('#log'); const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    el.outerHTML = replyHTML(m);
    if (stick) log.scrollTop = log.scrollHeight;
  });
}

// ---------- configuración guiada: la primera IA en un minuto ----------
const WIZ = ['gemini', 'groq', 'openrouter', 'mistral', 'cerebras', 'nvidia'].filter((k) => NATIVE || !PRESETS[k].nativeOnly);
// Qué pide cada proveedor gratuito para crear la clave. Los límites gratuitos los fija cada uno y cambian.
const GUIDE = {
  gemini: { need: 'Una cuenta de Google.', steps: ['Inicia sesión con tu cuenta de Google.', 'Pulsa «Create API key».', 'Copia la clave y pégala abajo.'],
    note: 'En el nivel gratuito, Google puede usar lo que escribes para mejorar sus productos: no pegues datos personales ni de clientes.' },
  groq: { need: 'Un correo, o tu cuenta de Google o GitHub.', steps: ['Crea tu cuenta o inicia sesión.', 'Pulsa «Create API Key», ponle un nombre y créala.', 'Cópiala (solo se muestra una vez) y pégala abajo.'] },
  openrouter: { need: 'Un correo, o tu cuenta de Google o GitHub.', steps: ['Inicia sesión.', 'Pulsa «Create Key», ponle un nombre y créala.', 'Cópiala y pégala abajo.'], note: 'Neura solo usará sus modelos gratuitos (:free).' },
  mistral: { need: 'Un correo; puede pedirte verificar tu teléfono.', steps: ['Crea tu cuenta en su consola.', 'Entra en «API Keys» y crea una clave.', 'Cópiala y pégala abajo.'] },
  nvidia: { need: 'Un correo; puede pedirte verificar tu teléfono.', steps: ['Crea tu cuenta de desarrollador NVIDIA o inicia sesión.', 'Pulsa «Generate API Key» y créala.', 'Cópiala (empieza por nvapi-) y pégala abajo.'],
    note: 'Es un acceso gratuito para pruebas y desarrollo, con un límite de peticiones por minuto. No lo uses para un servicio comercial y no pegues datos sensibles.' },
  cerebras: { need: 'Un correo electrónico.', steps: ['Crea tu cuenta o inicia sesión.', 'Entra en «API Keys» y crea una clave.', 'Cópiala y pégala abajo.'] },
};
let wzMode = DESK ? 'local' : 'cloud', wzPreset = 'gemini';
function wizardHTML() {
  const level = S.level ? '' : `<div class="level">
      <b>¿Es tu primera vez usando IAs?</b>
      <div class="row wrap"><button class="btn sm" data-level="basic">SÍ, SOY PRINCIPIANTE</button><button class="btn sm ghost" data-level="pro">YA LAS USO</button></div>
      <span class="hint">Principiante muestra lo esencial, consejos y habilidades que enseñan a usarlas bien. Puedes cambiarlo en ⚙.</span>
    </div>`;
  return `<div class="card wizard">
    <h4>EMPIEZA CON LA IA · GRATIS</h4>
    ${level}
    <div class="tabs">
      <button type="button" data-wz="local" class="${wzMode === 'local' ? 'on' : ''}">💻 IA EN ESTE EQUIPO<small>sin cuentas ni claves</small></button>
      <button type="button" data-wz="cloud" class="${wzMode === 'cloud' ? 'on' : ''}">☁ IA EN INTERNET<small>gratis, con una cuenta</small></button>
    </div>
    <div id="wzBody">${wzMode === 'local' ? localAIHTML() : cloudHTML()}</div>
  </div>`;
}
function cloudHTML() {
  const g = GUIDE[wzPreset];
  return `<label>1. ELIGE UNA IA<select id="wzPreset">${WIZ.map((k, i) => `<option value="${k}" ${k === wzPreset ? 'selected' : ''}>${PRESETS[k].name}${i ? '' : ' (recomendada)'}</option>`).join('')}</select></label>
    <div class="hint">Necesitas: <b>${esc(g.need)}</b></div>
    <div class="hint">2. <a id="wzKey" href="${esc(PRESETS[wzPreset].keyUrl)}" target="_blank" rel="noopener">Abre su página ▸</a></div>
    <ol class="steps">${g.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
    ${g.note ? `<div class="hint warn">⚠️ ${esc(g.note)}</div>` : ''}
    <label>3. PEGA LA CLAVE<input id="wzApiKey" type="password" autocomplete="off" placeholder="pega aquí tu clave"></label>
    <button class="btn wide" id="wzGo">CONECTAR Y PROBAR</button>
    <div class="hint" id="wzMsg">La clave se guarda solo en este dispositivo. Los límites gratuitos los fija cada proveedor y pueden cambiar.</div>`;
}
const renderWizard = () => { const b = document.getElementById('wzBody'); if (b) b.innerHTML = wzMode === 'local' ? localAIHTML() : cloudHTML(); renderLocalAI(); };

// ---------- IA en este equipo (Ollama), sin cuentas ----------
// Neura no instala Ollama (pide permisos de administrador y cambia por sistema): detecta si falta y enlaza el instalador.
const OLLAMA = 'http://127.0.0.1:11434';
const local = { status: 'unknown', models: [], progress: null, err: '', ctl: null };
function recommendedModel(ram) {
  if (ram && ram < 7) return { model: 'llama3.2:3b', size: '2 GB', gb: 2 };
  if (ram && ram < 15) return { model: 'qwen3:4b', size: '2,5 GB', gb: 2.5 };
  return { model: 'qwen3:8b', size: '5 GB', gb: 5.2 };
}
async function checkLocal() {
  if (!DESK) return;
  local.status = 'checking'; renderLocalAI();
  try {
    const r = await xfetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    local.models = ((await r.json()).models || []).map((m) => m.name).filter((n) => !/embed/i.test(n));
    local.status = 'ready';
  } catch { local.status = 'missing'; }
  renderLocalAI();
}
function localAIHTML() {
  if (!DESK) return `<div class="hint">La IA sin cuentas funciona en <b>Neura para PC</b>, que usa tu propio ordenador.
    <a href="https://github.com/AngelazoGit/neura/releases/latest" target="_blank" rel="noopener">Descárgalo ▸</a>
    Si ya lo tienes, conecta este dispositivo con el QR de tu PC en <b>⬡</b>.</div>`;
  return '<div class="localAI"></div>';
}
function localAIInner() {
  const b = DESK.bridge(), rec = recommendedModel(b.ram);
  const os = { win32: 'windows', darwin: 'mac' }[b.platform] || 'linux';
  if (local.status === 'unknown' || local.status === 'checking') return '<div class="hint">Comprobando si tu equipo tiene Ollama…</div>';
  if (local.status === 'missing') return `<ol class="steps">
      <li>Instala <b>Ollama</b>, el programa gratuito que ejecuta la IA en tu equipo: <a href="https://ollama.com/download/${os}" target="_blank" rel="noopener">DESCARGAR PARA ${os.toUpperCase()} ▸</a></li>
      <li>Ábrelo cuando termine (queda funcionando en segundo plano).</li>
      <li>Vuelve aquí y pulsa: <button type="button" class="btn sm" data-lai="check">YA LO HE INSTALADO</button></li></ol>`;
  if (local.status === 'pulling') {
    const p = local.progress || {}, pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    return `<div class="hint">Descargando <b>${esc(local.pulling)}</b>… puede tardar unos minutos.</div>
      <progress id="lpBar" max="100" value="${pct}"></progress>
      <div class="row"><span class="mono" id="lpTxt">${esc(p.status || 'preparando')} ${p.total ? `· ${pct}%` : ''}</span><button type="button" class="btn sm ghost" data-lai="cancel">CANCELAR</button></div>`;
  }
  const have = local.models;
  return `<div class="hint">✓ Ollama está funcionando. Tu equipo tiene <b>${b.ram || '?'} GB</b> de memoria.</div>
    ${have.length ? `<div class="hint">Ya tienes: ${have.map((m) => `<button type="button" class="btn sm" data-lai="use" data-m="${esc(m)}">USAR ${esc(m)}</button>`).join(' ')}</div>` : ''}
    <div class="hint">Te recomendamos <b>${rec.model}</b> (descarga de unos ${rec.size}): ${have.includes(rec.model) ? 'ya lo tienes.' : ''}
      ${b.freeDisk != null ? `Espacio libre: <b>${b.freeDisk} GB</b>.` : ''} Es una orientación según tu memoria: tras instalarlo, Neura lo prueba y te dice cuánto tarda en tu equipo.</div>
    ${b.freeDisk != null && b.freeDisk < rec.gb + 2 && !have.includes(rec.model) ? `<div class="hint red">⚠️ Poco espacio en disco para ${rec.model} (necesita unos ${rec.size} y conviene dejar margen). Libera espacio antes de descargarlo.</div>` : ''}
    ${local.test ? `<div class="hint ${local.test.ok ? '' : 'red'}">${local.test.ok ? `✓ Prueba de ${esc(local.test.model)}: respondió en ${(local.test.ms / 1000).toFixed(1)} s${local.test.ms > 20000 ? ' (lento en este equipo: prueba un modelo más pequeño si se te hace pesado)' : ''}.` : `✕ La prueba de ${esc(local.test.model)} falló: ${esc(local.test.err)}`}</div>` : ''}
    ${have.includes(rec.model) ? '' : `<button type="button" class="btn wide" data-lai="pull" data-m="${rec.model}">DESCARGAR Y USAR ${rec.model}</button>`}
    ${local.err ? `<div class="hint red">${esc(local.err)}</div>` : ''}
    <div class="hint">Funciona sin internet y lo que escribes no sale de tu equipo. Es más lenta y sabe menos que las IAs grandes de internet.</div>`;
}
function renderLocalAI() {
  for (const el of document.querySelectorAll('.localAI')) el.innerHTML = localAIInner();
  if (DESK && local.status === 'unknown') checkLocal();
}
async function useLocalModel(model) {
  const s = S.mcp.find((x) => x.local);
  await mcpConnect(s, true).catch(() => {});
  const key = `mcp:${s.id}::ollama/${model}`;
  if (!findT(key)) { local.err = 'El puente no ve el modelo todavía: pulsa RECONECTAR en ⬡ → ESTE PC.'; return renderLocalAI(); }
  // Prueba real antes de dar la instalación por buena: la recomendación por memoria es solo orientativa.
  local.err = ''; local.test = null; renderLocalAI(); toast(`Probando ${model} en tu equipo…`);
  const t0 = performance.now();
  try {
    const r = await callTarget(findT(key), [{ role: 'user', content: 'Responde solo: OK' }], () => {});
    if (!String(r || '').trim()) throw new Error('respuesta vacía');
    local.test = { model, ok: true, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    local.test = { model, ok: false, err: netHint(e) };
    return renderLocalAI();
  }
  S.target = key; S.wizardDone = true;
  save(); renderTargets(); renderLog(); renderLocalAI();
  toast(`✓ ${model} lista: respondió en ${(local.test.ms / 1000).toFixed(1)} s. ¡Escribe tu primera pregunta!`); $('#input').focus();
}
async function pullModel(model) {
  Object.assign(local, { status: 'pulling', pulling: model, progress: null, err: '', ctl: new AbortController() });
  renderLocalAI();
  try {
    const r = await xfetch(OLLAMA + '/api/pull', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, stream: true }), signal: local.ctl.signal });
    if (!r.ok) throw httpErr(r.status, await r.text(), r.headers);
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        local.progress = { status: j.status, done: j.completed || 0, total: j.total || 0 };
        const bar = document.getElementById('lpBar'), txt = document.getElementById('lpTxt'), pct = j.total ? Math.round((j.completed / j.total) * 100) : 0;
        if (bar) bar.value = pct;
        if (txt) txt.textContent = `${j.status}${j.total ? ` · ${pct}%` : ''}`;
      }
    }
    local.status = 'ready'; local.models = [...new Set([...local.models, model])];
    await useLocalModel(model);
  } catch (e) {
    local.status = 'ready';
    local.err = e.name === 'AbortError' ? 'Descarga cancelada.' : `No se pudo descargar: ${netHint(e)}`;
    renderLocalAI();
  }
}

// ---------- nivel: principiante o profesional ----------
// Principiante: lo esencial, consejos de uso correcto y habilidades que enseñan. Profesional: todo.
const STARTERS = [
  { name: 'Mejorar mi pregunta', description: 'Reescribe tu petición para que la IA la entienda mejor y te explica por qué. Usar para aprender a pedir mejor o cuando no sepas cómo plantear algo.',
    instructions: '# Mejorar mi pregunta\n\nAyudas a la persona a aprender a usar bien las IAs.\n\n1. Lee su petición y detecta lo que falta: objetivo, contexto, formato de la respuesta, nivel de detalle y límites.\n2. Si falta algo esencial, haz como máximo 3 preguntas breves.\n3. Escribe una versión mejorada de la petición, lista para copiar, entre comillas.\n4. Explica en 2-4 viñetas qué cambiaste y por qué, para que aprenda a hacerlo por su cuenta.\n\nNo respondas todavía a la petición original salvo que te lo pida.' },
  { name: 'Aprender paso a paso', description: 'Profesor paciente: explica un tema por partes, con ejemplos, y comprueba que lo entiendes. Usar para aprender o estudiar algo nuevo.',
    instructions: '# Aprender paso a paso\n\nActúas como profesor paciente.\n\n1. Si no está claro, pregunta qué sabe ya del tema y adapta el nivel.\n2. Explica en bloques cortos, con un ejemplo cotidiano en cada uno.\n3. Tras cada bloque, haz una pregunta sencilla para comprobar que lo ha entendido y espera su respuesta.\n4. Si se equivoca, corrige con amabilidad y explícalo de otra forma.\n5. Al final, resume lo aprendido en 3-5 viñetas y propón el siguiente paso.' },
  { name: 'Comprobar una respuesta', description: 'Revisa críticamente una respuesta de una IA u otra fuente: señala lo dudoso y cómo verificarlo. Es una evaluación orientativa, no una verificación con fuentes. Usar antes de fiarte de un dato importante.',
    instructions: '# Comprobar una respuesta\n\nRevisas críticamente una respuesta que la persona pega (de una IA o de otra fuente).\n\n1. Separa los hechos comprobables de las opiniones.\n2. Señala las afirmaciones dudosas, sin fuente o que podrían estar desactualizadas, y explica por qué.\n3. Indica cómo verificar cada punto importante: qué buscar y en qué tipo de fuente fiable.\n4. Termina con una valoración orientativa: «parece sólida», «conviene revisar» o «dudosa».\n5. Si no has consultado fuentes en esta conversación, empieza la valoración con «Evaluación orientativa: no he consultado fuentes; los hechos no están verificados». Si las has consultado, cítalas.\n\nNo presentes tu valoración como una certificación. No inventes fuentes ni enlaces.' },
];
// Más habilidades de inicio: no se instalan solas, sino con «+ HABILIDADES DE INICIO».
const EXTRA_STARTERS = [
  { name: 'Prompt para imagen', description: 'Convierte tu idea en un prompt detallado para generar imágenes (Gemini, ChatGPT, Stable Diffusion, ComfyUI…). Usar cuando quieras crear una imagen con IA.',
    instructions: '# Prompt para imagen\n\nAyudas a convertir una idea en un prompt eficaz para un generador de imágenes.\n\n1. Si falta algo esencial (qué debe aparecer, para qué es la imagen, estilo), haz como máximo 3 preguntas breves; si no, sigue.\n2. Escribe el prompt final en un bloque de código, en español, con: sujeto y acción; escenario; estilo (foto, ilustración, 3D, acuarela…); composición y encuadre (plano, ángulo); luz y color; detalles importantes; y proporción (p. ej. 16:9 o vertical 9:16).\n3. Si debe aparecer texto dentro de la imagen, escríbelo entre comillas y pide una tipografía legible.\n4. Añade una versión corta de una línea y, para Stable Diffusion o ComfyUI, una línea «Evitar:» con lo que no debe salir (prompt negativo).\n5. Termina con 2-3 variaciones (otro estilo, otra luz u otro encuadre).\n\nSi Neura tiene imágenes en tu PC, recuerda que se generan escribiendo /imagen seguido del prompt. No crees imágenes de personas reales identificables sin su consentimiento ni copies el estilo exacto de un artista vivo.' },
];
function installStarters(list = STARTERS) {
  let n = 0;
  for (const st of list) {
    if (liveSkills().some((k) => k.name === st.name)) continue;
    S.skills.push({ id: uid() + uid(), ...st, version: 1, updatedAt: Date.now() }); n++;
  }
  if (n) { save(); syncAll(); }
  return n;
}
function applyLevel() {
  document.body.classList.toggle('basic', S.level === 'basic');
  if (S.level === 'basic' && (S.council || S.useTools)) { S.council = false; S.useTools = false; }
}
const TIPS = [
  '<b>Da contexto</b>: quién eres, qué quieres conseguir y en qué formato quieres la respuesta.',
  '<b>Comprueba lo importante</b>: las IAs pueden equivocarse con mucha seguridad. Prueba ✦ «Comprobar una respuesta».',
  '<b>Cuida tus datos</b>: no pegues contraseñas ni datos personales en IAs de internet. Para lo privado, usa 🔒 PRIVADO con la IA de tu equipo.',
  '<b>Aprende a pedir</b>: activa ✦ «Mejorar mi pregunta» y verás cómo plantearlo mejor.',
];
// ---------- ruta de aprendizaje: retos cortos que se completan usando Neura ----------
// Se calculan a partir de tus hilos: no hay que marcar nada a mano.
const nWords = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;
const usedSkill = (A, name) => A.replies.some((m) => m.skill?.name === name);
const LEARN = [
  { id: 'first', t: 'Haz tu primera pregunta', how: 'Escribe lo que quieras abajo y pulsa ENVIAR.', ex: '¿Qué puedes hacer por mí? Explícamelo en 5 viñetas.',
    done: (A) => A.users.length > 0, tip: 'Es una conversación: puedes seguir preguntando sobre lo que te responda.' },
  { id: 'context', t: 'Da contexto', how: 'Di quién eres, qué quieres y para qué (al menos 25 palabras).', ex: 'Soy estudiante de bachillerato y el lunes tengo examen de biología. Explícame la fotosíntesis de forma sencilla, con un ejemplo de la vida diaria y en menos de 200 palabras.',
    done: (A) => A.users.some((m) => nWords(m.content) >= 25), tip: 'Con contexto, la IA se inventa menos y se ajusta a lo que necesitas.' },
  { id: 'format', t: 'Pide un formato', how: 'Pide la respuesta en tabla, lista, pasos o con un número de palabras.', ex: 'Compara el tren y el avión para un viaje de 600 km en una tabla con precio, tiempo y comodidad.',
    done: (A) => A.users.some((m) => /\b(tabla|lista|viñetas|pasos|esquema|en \d+ (palabras|líneas|puntos|frases))\b/i.test(m.content || '')), tip: 'Decir el formato ahorra tiempo: la respuesta llega lista para usar.' },
  { id: 'follow', t: 'Sigue la conversación', how: 'Contesta a la IA para que corrija, amplíe o lo diga de otra forma.', ex: 'Ahora explícamelo como si tuviera 10 años.',
    done: (A) => A.threads.some((t) => t.messages.filter((m) => m.role === 'user').length >= 2), tip: 'No hace falta acertar a la primera: se mejora pidiendo cambios.' },
  { id: 'improve', t: 'Mejora tu pregunta', how: 'Activa ✦ HABILIDADES → «Mejorar mi pregunta» y envía una petición.', ex: null,
    done: (A) => usedSkill(A, 'Mejorar mi pregunta'), tip: 'Fíjate en lo que cambia: es lo que conviene incluir la próxima vez.' },
  { id: 'check', t: 'Comprueba una respuesta', how: 'Activa ✦ «Comprobar una respuesta» y pega algo que quieras revisar.', ex: null,
    done: (A) => usedSkill(A, 'Comprobar una respuesta'), tip: 'Las IAs se equivocan con seguridad: comprueba siempre los datos importantes.' },
  { id: 'compare', t: 'Compara dos IAs', how: 'Cambia de IA en el desplegable de arriba y repite la pregunta en el mismo hilo.', ex: null,
    done: (A) => A.threads.some((t) => new Set(t.messages.filter((m) => m.role === 'assistant' && m.key && !m.error && m.content).map((m) => m.key)).size >= 2), tip: 'Cada IA tiene puntos fuertes: si es importante, contrasta.' },
  { id: 'file', t: 'Trabaja con un archivo', how: 'Pulsa 📎, adjunta un PDF, una foto o un texto y pregunta sobre él.', ex: null,
    done: (A) => A.users.some((m) => m.files?.length), tip: 'Puede resumir y sacar datos de tus documentos. Para lo privado, usa 🔒 PRIVADO con la IA de tu equipo.' },
];
function learnState() {
  const threads = S.threads.filter((t) => !t.deleted);
  const all = threads.flatMap((t) => t.messages);
  const A = { threads, users: all.filter((m) => m.role === 'user'), replies: all.filter((m) => m.role === 'assistant') };
  return LEARN.map((x) => ({ ...x, ok: !!x.done(A) }));
}
function learnHTML(compact) {
  const L = learnState(), n = L.filter((x) => x.ok).length, next = L.find((x) => !x.ok);
  const list = `<ol class="learn">${L.map((x) => `<li class="${x.ok ? 'ok' : ''}"><b>${x.ok ? '✓' : '○'} ${esc(x.t)}</b> <span>${esc(x.ok ? x.tip : x.how)}</span></li>`).join('')}</ol>`;
  if (!compact) return `<h3>🎓 RUTA DE APRENDIZAJE · ${n}/${L.length}</h3>${list}`;
  if (!next) return `<div class="tips learnCard"><b>🏆 RUTA COMPLETADA · ${n}/${L.length}</b><p>Ya sabes lo esencial para usar bien las IAs. Cuando quieras más, pasa a PROFESIONAL en ⚙.</p></div>`;
  return `<div class="tips learnCard"><b>🎓 TU RUTA DE APRENDIZAJE · ${n}/${L.length}</b>
    <p><b>Siguiente reto: ${esc(next.t)}.</b> ${esc(next.how)}</p>
    ${next.ex ? `<button class="btn sm" data-learnex="${next.id}">PROBAR CON UN EJEMPLO</button>` : ''}
    <details><summary>VER TODOS LOS RETOS</summary>${list}</details></div>`;
}
// Tras cada respuesta: felicita una vez por cada reto conseguido.
function learnProgress() {
  if (S.level !== 'basic') return;
  const seen = new Set(S.learnSeen || []);
  const now = learnState().filter((x) => x.ok && !seen.has(x.id));
  if (!now.length) return;
  S.learnSeen = [...seen, ...now.map((x) => x.id)];
  const x = now[now.length - 1];
  toast(`🎓 Reto conseguido: ${x.t}. ${x.tip}`);
}
document.addEventListener('click', async (e) => {
  const d = e.target.dataset || {};
  if (d.learnex) { const x = LEARN.find((l) => l.id === d.learnex); $('#input').value = x.ex; $('#input').dispatchEvent(new Event('input')); $('#input').focus(); }
  if (d.wz) { wzMode = d.wz; document.querySelectorAll('[data-wz]').forEach((b) => b.classList.toggle('on', b.dataset.wz === wzMode)); renderWizard(); }
  if (d.level) {
    S.level = d.level;
    if (d.level === 'basic') installStarters();
    applyLevel(); save(); renderTargets(); renderLog();
    toast(d.level === 'basic' ? 'Modo principiante: lo esencial y 3 habilidades para aprender (✦)' : 'Modo profesional: todas las funciones visibles');
  }
  if (d.lai === 'check') checkLocal();
  if (d.lai === 'pull') pullModel(d.m);
  if (d.lai === 'cancel') local.ctl?.abort();
  if (d.lai === 'use') useLocalModel(d.m);
});
$('#log').addEventListener('change', (e) => { if (e.target.id === 'wzPreset') { wzPreset = e.target.value; renderWizard(); } });
$('#log').addEventListener('click', async (e) => {
  if (e.target.id !== 'wzGo') return;
  const key = $('#wzApiKey').value.trim(), k = wzPreset, msg = $('#wzMsg');
  if (!key) return toast('Pega la clave primero', true);
  e.target.disabled = true; msg.textContent = 'Conectando y descargando la lista de modelos…';
  let p = S.providers.find((x) => x.wizard);
  if (!p) S.providers.push(p = { id: uid(), preset: k, ...JSON.parse(JSON.stringify(PRESETS[k])), enabled: true, wizard: true });
  Object.assign(p, { preset: k, name: PRESETS[k].name, baseUrl: PRESETS[k].baseUrl, models: [...PRESETS[k].models], apiKey: key });
  refreshed.delete(p.id); await refreshModels(p, true);
  const t = { key: `${p.id}::${p.models[0]}`, pid: p.id, model: p.models[0], kind: p.kind };
  try {
    if (!p.models[0]) throw new Error('No se encontraron modelos');
    await callTarget(t, [{ role: 'user', content: 'Responde solo: OK' }], () => {});
    delete p.wizard; S.target = t.key; S.wizardDone = true; save(); renderTargets(); renderLog();
    toast(`✓ ${p.name} conectada. ¡Ya puedes escribir!`); $('#input').focus();
  } catch (err) {
    msg.textContent = `No funcionó: ${friendly(err)} Revisa la clave y vuelve a intentarlo.`;
    S.providers = S.providers.filter((x) => x !== p); save();
    e.target.disabled = false;
  }
});

function renderTargets() {
  const all = targets();
  if (!all.some((t) => t.key === S.target)) {
    const pid = String(S.target || '').split('::')[0];
    S.target = (all.find((t) => t.pid === pid && allowed(t)) || all.find(allowed) || all[0])?.key || null;
  }
  const sel = $('#target');
  sel.innerHTML = all.length ? all.map((t) => `<option value="${esc(t.key)}">${!allowed(t) ? '⛔ ' : cooling(t.key) ? '⏳ ' : ''}${esc(t.label)}</option>`).join('') : '<option value="">— SIN IAs CONECTADAS —</option>';
  sel.value = S.target || '';
  $('#autoSkip').checked = S.autoSkip;
  $('#council').checked = S.council;
  $('#useTools').checked = S.useTools;
  $('#private').checked = !!thread().private;
  const hasTools = toolbox().length > 0;
  $('#toolsLbl').hidden = !hasTools;
  if (!hasTools && S.useTools) $('#useTools').checked = false;
  const ready = all.filter((t) => !cooling(t.key)).length;
  $('#syncTxt').textContent = ready === all.length ? `${all.length} IA` : `${ready}/${all.length} IA`;
  $('#syncDot').classList.toggle('on', ready > 0);
}

const tierBadge = (t) => t === 'free' ? '<span class="badge free">GRATIS</span>' : t === 'paid' ? '<span class="badge paid">PAGO</span>' : '<span class="badge local">OTRA</span>';
function healthChips(p) {
  const chips = p.models.map((m) => {
    const k = `${p.id}::${m}`, h = S.health[k];
    if (!h || (!h.ok && !h.fail && !cooling(k))) return '';
    if (cooling(k)) return `<span class="chip off" title="${esc(m)}">⏳ ${esc(m)} · ${esc(coolText(k))}</span>`;
    const pct = Math.round((h.ok / Math.max(1, h.ok + h.fail)) * 100);
    const caps = `${h.noVision ? ' · sin imágenes' : ''}${h.noTools ? ' · sin herramientas' : ''}`;
    return `<span class="chip" title="${esc(m)}">● ${esc(m)} · ${(h.ms / 1000).toFixed(1)} s · ${pct}%${caps}</span>`;
  }).join('');
  return chips ? `<div class="chips">${chips}</div>` : '';
}
function renderProviders() {
  $('#provList').innerHTML = S.providers.map((p) => `
    <div class="card ${p.enabled === false ? 'off' : ''}" data-pid="${p.id}">
      <div class="head"><input data-f="name" value="${esc(p.name)}">${tierBadge(p.tier)}
        <button class="btn sm ghost" data-act="toggle">${p.enabled === false ? 'ACTIVAR' : 'PAUSAR'}</button>
        <button class="btn sm red" data-act="del">✕</button></div>
      <label>ENDPOINT<input data-f="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://…/v1"></label>
      <label>CLAVE API<input data-f="apiKey" type="password" autocomplete="off" value="${esc(p.apiKey || '')}" placeholder="${vault.locked ? 'bloqueada con PIN' : 'pega tu clave'}"></label>
      ${p.keyUrl ? `<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">▸ conseguir clave${p.tier === 'free' ? ' gratuita' : ''}</a>` : ''}
      <label>MODELOS (separados por coma)<input data-f="models" value="${esc(p.models.join(', '))}"></label>
      <div class="row2">
        <label>LÍMITE DIARIO (peticiones)<input data-f="dailyLimit" type="number" min="0" step="1" inputmode="numeric" value="${esc(p.dailyLimit || '')}" placeholder="sin límite"></label>
        ${p.tier === 'free' ? '' : `<label>€ / 1M TOKENS ENTRADA<input data-f="priceIn" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(p.price?.in ?? '')}" placeholder="?"></label>
        <label>€ / 1M TOKENS SALIDA<input data-f="priceOut" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(p.price?.out ?? '')}" placeholder="?"></label>`}
      </div>
      ${healthChips(p)}
      <div class="row"><button class="btn sm" data-act="scan">ESCANEAR MODELOS</button><button class="btn sm ghost" data-act="test">PROBAR</button>${p.models.some((m) => cooling(`${p.id}::${m}`)) ? '<button class="btn sm ghost" data-act="reset">REINTENTAR YA</button>' : ''}</div>
    </div>`).join('') || '<p class="hint">Todavía no hay IAs. Elige una arriba y pulsa + AÑADIR.</p>';
  renderSettings();
}

// Panel de consumo: hoy y este mes por IA; aparte, lo que ha pasado por el Gateway de este PC.
const fmtTok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n));
function usageHTML() {
  const day = today(), U = S.usage || {}, b = S.budget || {};
  const sum = (pred, onlyDay) => {
    const a = { n: 0, err: 0, tok: 0, eur: 0 };
    for (const [k, v] of Object.entries(U)) {
      if (onlyDay ? k !== day : monthOf(k) !== monthOf(day)) continue;
      for (const [key, u] of Object.entries(v)) if (pred(key)) { a.n += u.n; a.err += u.err || 0; a.tok += u.in + u.out; a.eur += u.eur; }
    }
    return a;
  };
  const money = (p, v) => (p && p.tier !== 'free' && !priced(p) ? '<span title="Pon su precio en su tarjeta para calcular el gasto">?</span>' : eur(v));
  const row = (name, pred, p) => {
    const d = sum(pred, true), m = sum(pred, false), lim = +p?.dailyLimit, used = d.n + d.err;
    if (!used && !m.n && !lim) return '';
    return `<tr><td>${esc(name)}${lim ? `<progress max="${lim}" value="${Math.min(used, lim)}"></progress>` : ''}</td><td>${used}${lim ? ` / ${lim}` : ''}</td><td>${fmtTok(d.tok)}</td><td>${money(p, d.eur)}</td><td>${money(p, m.eur)}</td></tr>`;
  };
  const rows = [...S.providers.map((p) => row(p.name, (k) => k.startsWith(p.id + '::'), p)), row('⬡ Tus equipos', (k) => k.startsWith('mcp:'), null)].join('');
  const gw = S.gwUsage, gwRows = gw ? Object.entries(gw.today || {}).map(([id, u]) => `<tr><td>${esc(id)}</td><td>${u.n + (u.err || 0)}</td><td>${fmtTok(u.in + u.out)}</td><td>${eur(u.eur)}</td><td>${eur(gw.month?.[id]?.eur || 0)}</td></tr>`).join('') : '';
  const unpriced = S.providers.filter((p) => p.enabled !== false && p.tier !== 'free' && !priced(p) && !(S.freeOnly));
  const head = '<thead><tr><th>IA</th><th>HOY</th><th>TOKENS</th><th>€ HOY</th><th>€ MES</th></tr></thead>';
  return `<h3>📊 CONSUMO</h3>
    <p class="hint" id="usageSum">${usageSumHTML()}</p>
    ${rows ? `<table class="usage">${head}<tbody>${rows}</tbody></table>` : '<p class="hint">Aún no has usado ninguna IA hoy.</p>'}
    ${gwRows ? `<h4>🔌 POR EL GATEWAY (otras herramientas)</h4><table class="usage">${head}<tbody>${gwRows}</tbody></table>${gw.cache?.hits ? `<p class="hint">Caché: ${gw.cache.hits} respuestas repetidas servidas sin llamar a ninguna IA.</p>` : ''}` : ''}
    ${unpriced.length ? `<p class="hint warn">⚠️ ${unpriced.map((p) => esc(p.name)).join(', ')}: de pago sin precio. Ponlo en su tarjeta (€ por millón de tokens) para que su gasto cuente.</p>` : ''}
    <div class="row2"><label class="field">TOPE € / DÍA<input type="number" id="budgetDay" min="0" step="0.5" inputmode="decimal" value="${esc(b.day || '')}" placeholder="sin tope"></label>
    <label class="field">TOPE € / MES<input type="number" id="budgetMonth" min="0" step="1" inputmode="decimal" value="${esc(b.month || '')}" placeholder="sin tope"></label></div>
    <p class="hint">Al llegar al tope, Neura${DESK ? ' y el Gateway' : ''} solo usan IAs gratuitas y tus equipos hasta el día o el mes siguiente. Los tokens y el gasto son una estimación por caracteres; la factura real la da cada proveedor. Con <b>LÍMITE DIARIO</b> en la tarjeta de una IA, Neura avisa al 80 % y deja de usarla al llegar.</p>`;
}
function usageSumHTML() {
  const x = spent();
  return `Gasto de hoy: <b>${eur(x.day)}</b> · este mes: <b>${eur(x.month)}</b>${overBudget() ? ' · <b class="red">TOPE ALCANZADO: solo IAs gratuitas y tus equipos</b>' : ''}`;
}
// ---------- diagnóstico: probar todas mis IAs ----------
// Una petición mínima a cada IA (o a cada modelo) para saber cuáles funcionan ahora y por qué fallan las demás.
let diagRunning = false;
async function diagnose(allModels) {
  if (diagRunning) return;
  diagRunning = true;
  const el = () => document.getElementById('diagOut');
  const rows = [];
  const groups = [
    ...S.providers.filter((p) => p.enabled !== false).map((p) => ({ name: p.name, list: (allModels ? p.models : p.models.filter((m) => S.health[`${p.id}::${m}`]?.reason !== 'RETIRADO').slice(0, 1)).map((m) => findT(`${p.id}::${m}`)).filter(Boolean), noKey: !p.apiKey && p.preset !== 'custom', empty: !p.models.length })),
    ...S.mcp.map((s) => ({ name: `⬡ ${s.name}`, list: (allModels ? s.models || [] : (s.models || []).slice(0, 1)).map((m) => findT(`mcp:${s.id}::${m}`)).filter(Boolean), off: s.status !== 'on' && (s.error || 'sin conexión') })),
  ];
  const paint = () => {
    const okN = rows.filter((x) => x.ok).length, done = rows.filter((x) => x.ok != null).length;
    if (el()) el().innerHTML = `<p class="hint">${diagRunning ? `Probando… ${done}/${rows.length}` : `<b>${okN} de ${rows.length}</b> funcionan ahora.`}</p>
      <table class="usage"><thead><tr><th>IA</th><th>RESULTADO</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(x.label)}</td><td>${x.ok == null ? '…' : x.ok ? `<span class="okc">✓ ${(x.ms / 1000).toFixed(1)} s</span>` : `<span class="red">✕ ${esc(x.why)}</span>`}</td></tr>`).join('')}</tbody></table>`;
  };
  for (const g of groups) {
    if (g.off) rows.push({ label: g.name, ok: false, why: `no conecta: ${g.off}` });
    else if (g.noKey) rows.push({ label: g.name, ok: false, why: 'falta la clave API' });
    else if (g.empty) rows.push({ label: g.name, ok: false, why: 'sin modelos: pulsa ESCANEAR MODELOS' });
    else for (const t of g.list) rows.push({ label: t.label, t });
  }
  paint();
  // Proveedores en paralelo; los modelos de un mismo proveedor, de uno en uno (para no provocar límites por minuto).
  const byProv = new Map();
  for (const x of rows.filter((x) => x.t)) { const k = x.t.pid || x.t.sid; byProv.set(k, [...(byProv.get(k) || []), x]); }
  await Promise.all([...byProv.values()].map(async (list) => {
    for (const x of list) {
      const t = x.t;
      if (!allowed(t)) { Object.assign(x, { ok: false, why: `no se prueba: ${notAllowedWhy(t)}` }); paint(); continue; }
      if (S.health[t.key]?.reason === 'LÍMITE' && cooling(t.key)) { Object.assign(x, { ok: false, why: 'ha llegado a tu límite diario' }); paint(); continue; }
      const t0 = performance.now(), sig = AbortSignal.timeout(45000);
      try {
        await callTarget(t, [{ role: 'user', content: 'Responde solo: OK' }], () => {}, sig);
        Object.assign(x, { ok: true, ms: Math.round(performance.now() - t0) }); noteOk(t, x.ms);
      } catch (e) {
        noteFail(t, e);
        Object.assign(x, { ok: false, why: sig.aborted ? 'no respondió en 45 s' : `${friendly(e)}${e.status ? ` [${e.status}]` : ''}` });
      }
      paint();
    }
  }));
  diagRunning = false;
  paint(); save(); renderTargets();
}

// Lo que ha pasado hoy y este mes por el Gateway del PC (lo cuenta el puente).
async function refreshGwUsage() {
  if (!DESK) return;
  try {
    const b = DESK.bridge();
    const r = await xfetch(`http://127.0.0.1:${b.port}/neura/gateway`, { headers: { Authorization: 'Bearer ' + b.token } });
    if (!r.ok) return;
    const j = await r.json();
    S.gwUsage = { today: j.today, month: j.month, cache: j.cache };
    S.gwSpent = { date: j.date, day: j.spent.day, month: j.spent.month };
  } catch {}
}
// Si estás escribiendo en el panel, solo se actualiza el resumen (para no borrar el campo que editas).
const repaintUsage = () => {
  const el = document.getElementById('usagePanel'); if (!el) return;
  if (!el.contains(document.activeElement)) el.innerHTML = usageHTML(); else $('#usageSum').innerHTML = usageSumHTML();
};
function renderSettings() {
  const all = targets();
  const sec = DESK?.secure?.();
  $('#settings').innerHTML = `
    <h3>NIVEL</h3>
    <div class="row wrap"><button class="btn sm ${S.level === 'basic' ? '' : 'ghost'}" data-level="basic">PRINCIPIANTE</button><button class="btn sm ${S.level !== 'basic' ? '' : 'ghost'}" data-level="pro">PROFESIONAL</button><button class="btn sm ghost" id="addStarters">+ HABILIDADES DE INICIO</button></div>
    <p class="hint">Principiante muestra lo esencial y consejos de uso. Profesional añade CONSEJO, HERRAMIENTAS y el resto de opciones avanzadas.</p>
    <details class="learnSet"><summary>🎓 RUTA DE APRENDIZAJE · ${learnState().filter((x) => x.ok).length}/${LEARN.length}</summary>${learnHTML(false)}</details>
    ${DESK ? `<h3>💻 IA EN ESTE EQUIPO</h3>${localAIHTML()}` : ''}
    <h3>INSTRUCCIONES PARA TODAS LAS IAs</h3>
    <textarea id="instructions" rows="3" class="wide-input" placeholder="Ej.: responde solo en español y de forma breve">${esc(S.instructions ?? '')}</textarea>
    <p class="hint">Se envían a todas las IAs en cada mensaje (idioma, tono, longitud…). Déjalo vacío para no enviar nada.</p>
    <h3>GASTO</h3>
    <label class="auto"><input type="checkbox" id="freeOnly" ${S.freeOnly ? 'checked' : ''}> SOLO GRATIS</label>
    <p class="hint">Neura solo usará IAs del nivel gratuito (en OpenRouter, modelos <b>:free</b>) y tus equipos. Las de pago o de coste desconocido (⛔) no se usan ni en AUTO-SALTO, ni en CONSEJO, ni para resumir.</p>
    <div id="usagePanel">${usageHTML()}</div>
    <h3>🩺 DIAGNÓSTICO</h3>
    <p class="hint">Comprueba cuáles de tus IAs funcionan ahora y por qué fallan las demás. Hace una petición mínima a cada una (cuenta en su cuota).</p>
    <div class="row wrap"><button class="btn sm" id="diagRun">PROBAR TODAS MIS IAs</button><label class="auto"><input type="checkbox" id="diagAll"> TODOS LOS MODELOS</label></div>
    <div id="diagOut"></div>
    <h3>MEMORIA DE CONTEXTO</h3>
    <label class="field">TOKENS MÁXIMOS POR MENSAJE<input type="number" id="ctxTokens" min="1000" step="500" value="${S.ctxTokens}"></label>
    <p class="hint">Si un hilo pasa de este tamaño, Neura resume lo antiguo (con tu IA local si la tienes) y envía el resumen más lo reciente. Así las IAs gratuitas, con poco contexto, siguen respondiendo.</p>
    ${S.level === 'basic' ? '' : routingHTML()}
    <h3>⚖ CONSEJO</h3>
    <p class="hint">Elige qué IAs forman el consejo (2 a 5). Si no eliges, Neura usa las 3 mejores de proveedores distintos.</p>
    <div class="checks">${all.map((t) => `<label class="auto"><input type="checkbox" data-council="${esc(t.key)}" ${S.councilKeys.includes(t.key) ? 'checked' : ''}> ${esc(t.label)}</label>`).join('') || '<span class="hint">Añade IAs primero.</span>'}</div>
    <h3>SEGURIDAD DE LAS CLAVES</h3>
    ${sec ? `<p class="hint">🔒 En este PC las claves se guardan cifradas con el llavero del sistema (${esc(sec)}).</p>` : ''}
    ${!crypto.subtle ? '<p class="hint">El PIN necesita una conexión segura (https o la app instalada).</p>'
      : S.vault ? `<p class="hint">🔒 Claves cifradas con PIN${vault.locked ? ' · <b>BLOQUEADAS</b>' : ''}.</p>
        <div class="row">${vault.locked ? '<button class="btn sm" id="vaultUnlock">DESBLOQUEAR</button>' : '<button class="btn sm red" id="vaultOff">QUITAR PIN</button>'}</div>`
      : `<p class="hint">Cifra tus claves API y tokens con un PIN (AES-256). Te lo pedirá al abrir Neura.</p>
        <div class="row"><input type="password" id="pinNew" inputmode="numeric" autocomplete="new-password" placeholder="PIN (mín. 4)"><button class="btn sm" id="vaultOn">ACTIVAR PIN</button></div>`}
    <p class="hint">Las claves nunca se sincronizan entre dispositivos: solo viajan los hilos.</p>`;
  renderLocalAI();
  refreshGwUsage().then(repaintUsage);
}

function renderMcp() {
  const st = { on: ['on', 'EN LÍNEA'], err: ['err', 'ERROR'], wait: ['wait', 'CONECTANDO…'] };
  $('#mcpList').innerHTML = S.mcp.map((s) => {
    const [cls, lbl] = st[s.status] || ['wait', 'EN ESPERA'];
    return `<div class="card" data-sid="${s.id}">
      <div class="head"><b class="srv">${esc(s.name)}</b><span class="badge ${cls}">${lbl}</span></div>
      <div class="mono">${esc(s.url)}${s.serverInfo ? ` · ${esc(s.serverInfo.title || s.serverInfo.name)} v${esc(s.serverInfo.version)}` : ''}</div>
      ${s.error ? `<div class="mono red">${esc(s.error)}</div>` : ''}
      ${(s.backends || []).length ? `<div class="chips">${s.backends.map((b) => `<span class="chip ${b.online ? '' : 'off'}">${esc(b.id)} ${b.online ? '● ' + b.count : '○'}</span>`).join('')}</div>` : ''}
      ${(s.models || []).length ? `<div class="chips">${s.models.map((m) => `<span class="chip">${esc(m)}</span>`).join('')}</div>` : ''}
      ${(s.images || []).some((i) => i.online) ? `<div class="chips">${s.images.filter((i) => i.online).map((i) => `<span class="chip">🖼 ${esc(i.id)} ●</span>`).join('')}<span class="hint">Escribe <b>/imagen</b> y lo que quieras ver.</span></div>` : ''}
      ${(s.tools || []).length ? `<div class="chips">${s.tools.map((t) => `<span class="chip tool" title="${esc(t.description || '')}">ƒ ${esc(t.name)}</span>`).join('')}</div>` : ''}
      ${(s.tools || []).some((t) => t.name === 'threads_sync') ? `<label class="auto"><input type="checkbox" data-act="sync" ${s.sync !== false ? 'checked' : ''}> SINCRONIZAR HILOS
        <span class="mono">${s.syncError ? `<span class="red">${esc(s.syncError)}</span>` : s.syncedAt ? '· ' + hhmm(s.syncedAt) : ''}</span></label>` : ''}
      ${!s.local && (s.tools || []).some((t) => !INTERNAL.has(t.name)) ? `<label class="auto"><input type="checkbox" data-act="trust" ${s.trustTools ? 'checked' : ''}> USAR SUS HERRAMIENTAS SIN PREGUNTAR</label>` : ''}
      ${!s.local ? `<label class="auto"><input type="checkbox" data-act="mine" ${s.mine ? 'checked' : ''}> ES UN EQUIPO MÍO (sirve para hilos 🔒 PRIVADOS)</label>` : ''}
      ${s.local && DESK ? localBridgeHTML() : ''}
      <div class="row"><button class="btn sm" data-act="reconnect">RECONECTAR</button>${s.local ? '' : '<button class="btn sm red" data-act="del">ELIMINAR</button>'}</div>
    </div>`;
  }).join('');
}

// Configuración lista para copiar en otras herramientas. La clave es el token del puente.
function gatewayHTML(b) {
  const g = S.gateway || {}, base = `http://127.0.0.1:${b.port}`, t = b.gatewayToken;
  const snip = (title, text, note = '') => `<details><summary>${title}</summary><pre class="snip">${esc(text)}</pre>${note ? `<div class="hint">${note}</div>` : ''}<button type="button" class="btn sm ghost" data-act="copysnip">COPIAR</button></details>`;
  return `<h4>🔌 NEURA GATEWAY · CONECTAR OTRAS HERRAMIENTAS</h4>
    <div class="hint">Usa Neura (tus IAs, AUTO-SALTO y SOLO GRATIS) como proveedor en otras aplicaciones: Continue, Cline, Aider, Open WebUI…</div>
    <label class="auto"><input type="checkbox" data-act="gw" ${g.enabled ? 'checked' : ''}> ACTIVAR GATEWAY</label>
    ${!g.enabled ? '' : `<label class="auto"><input type="checkbox" data-act="gwlocal" ${g.localOnly ? 'checked' : ''}> SOLO MODELOS DE ESTE EQUIPO</label>
    <label class="auto"><input type="checkbox" data-act="gwunknown" ${g.unknownAsAuto ? 'checked' : ''}> USAR «auto» PARA NOMBRES DE MODELO DESCONOCIDOS</label>
    <div class="hint">Sin esta opción, un nombre que Neura no conoce (por ejemplo, una errata) da error y no se envía a ninguna IA.</div>
    <label class="auto"><input type="checkbox" data-act="gwcache" ${g.cache ? 'checked' : ''}> CACHÉ DE RESPUESTAS REPETIDAS (10 min)</label>
    <div class="hint">Si una herramienta repite exactamente la misma petición, se responde con la respuesta guardada sin gastar cuota. «Regenerar» con la misma petición devolverá la misma respuesta mientras dure.</div>
    <div class="mono">TOKEN DEL GATEWAY: <span class="secret">${esc(t)}</span> <button class="btn sm red" data-act="regengw" title="Si se filtra">REGENERAR</button></div>
    <div class="hint">Es distinto del token del puente: solo sirve para pedir respuestas y ver los modelos, no da acceso a tus hilos, archivos ni ajustes.</div>
    <div class="mono">Compatible con OpenAI: ${esc(base)}/v1 · con Anthropic: ${esc(base)} · clave: el token del Gateway · modelo: <b>auto</b> (o uno concreto de /v1/models)</div>
    <div class="hint">Configuraciones de ejemplo: la API se ha comprobado con los SDK oficiales de OpenAI y Anthropic, pero aún no con cada herramienta.</div>
    ${snip('Continue (config.yaml) · ejemplo', `models:
  - name: Neura (auto)
    provider: openai
    model: auto
    apiBase: ${base}/v1
    apiKey: ${t}`)}
    ${snip('Cline / Roo Code · ejemplo', `Proveedor: OpenAI Compatible
Base URL: ${base}/v1
API Key: ${t}
Model ID: auto`)}
    ${snip('Aider · ejemplo', `aider --openai-api-base ${base}/v1 --openai-api-key ${t} --model openai/auto`)}
    ${snip('Open WebUI · ejemplo', `Ajustes → Conexiones → API de OpenAI
URL: ${base}/v1
Clave: ${t}`, 'Si Open WebUI corre en Docker, usa http://host.docker.internal:' + b.port + '/v1.')}
    ${snip('Claude Code · ejemplo', `# macOS / Linux
export ANTHROPIC_BASE_URL=${base}
export ANTHROPIC_AUTH_TOKEN=${t}
export ANTHROPIC_MODEL=auto

# Windows (PowerShell)
$env:ANTHROPIC_BASE_URL="${base}"
$env:ANTHROPIC_AUTH_TOKEN="${t}"
$env:ANTHROPIC_MODEL="auto"`,
      'Revisa sus condiciones de uso antes de usarlo con modelos de otros proveedores. Los modelos gratuitos rinden peor en tareas largas de programación.')}
    <div class="hint warn">⚠️ Cualquier programa de este PC con el token (y otros equipos, si abres el puente a tu red) usará tus claves y tus cuotas gratuitas. Si se filtra, pulsa REGENERAR.</div>`}`;
}
// Puente integrado en Neura Desktop: emparejar el móvil, carpetas para la IA y acceso fuera de casa.
function localBridgeHTML() {
  const b = DESK.bridge();
  const urls = b.lan ? b.ips.map((ip) => `http://${ip}:${b.port}/mcp`) : [];
  const ts = b.tailscale || {};
  return `<div class="lan">
    <h4>📱 CONECTAR EL MÓVIL</h4>
    <label class="auto"><input type="checkbox" data-act="lan" ${b.lan ? 'checked' : ''}> ABRIR A MI RED</label>
    ${b.lan ? `${b.qr ? `<div class="qr"><img src="${esc(b.qr)}" alt="Código QR de emparejamiento"><span class="hint">Escanéalo con la cámara del móvil: se abre Neura ya conectada a este PC. En la app instalada: ⬡ → 📷 ESCANEAR QR.</span></div>` : ''}
      <div class="mono">URL: ${urls.map(esc).join(' · ') || 'sin red'}</div>
      <div class="mono">TOKEN: <span class="secret">${esc(b.token)}</span> <button class="btn sm ghost" data-act="copytoken">COPIAR</button> <button class="btn sm red" data-act="regentoken" title="Si pierdes el móvil o se filtra el QR">REGENERAR</button></div>`
      : '<div class="mono">Solo accesible desde este PC.</div>'}
    <h4>🌍 FUERA DE CASA (Tailscale)</h4>
    ${!ts.installed ? '<div class="hint">Instala Tailscale (gratis) en el PC y el móvil para usar Neura y tu IA local desde cualquier sitio. <a href="https://tailscale.com/download" target="_blank" rel="noopener">▸ descargar</a></div>'
      : !ts.running ? `<div class="hint">Tailscale está instalado pero apagado: ábrelo e inicia sesión.${ts.error ? ` <span class="red">${esc(ts.error)}</span>` : ''}</div>`
      : `<div class="mono">${b.lan && ts.ip ? `App instalada: http://${esc(ts.ip)}:${b.port}/mcp` : 'Activa ABRIR A MI RED para usar la IP de Tailscale.'}</div>
        ${ts.https ? `<div class="mono">Web (https): https://${esc(ts.dns)}/ · MCP: https://${esc(ts.dns)}/mcp</div>${b.qrTs ? `<div class="qr"><img src="${esc(b.qrTs)}" alt="QR para fuera de casa"><span class="hint">QR para conectarte desde fuera (con Tailscale activo en el móvil).</span></div>` : ''}<button class="btn sm ghost" data-act="tsoff">DESACTIVAR HTTPS</button>`
        : `<button class="btn sm" data-act="tson">ACTIVAR HTTPS CON TAILSCALE</button>`}
        ${ts.error ? `<div class="mono red">${esc(ts.error)}</div>` : ''}`}
    ${S.level === 'basic' ? '' : gatewayHTML(b)}
    <h4>🖼 IMÁGENES EN ESTE PC</h4>
    ${(S.mcp.find((x) => x.local)?.images || []).some((i) => i.online)
      ? '<div class="hint">Generador detectado. En el chat, escribe <b>/imagen</b> seguido de lo que quieres ver (también desde el móvil conectado a este PC). Gratis, sin cuentas y sin que la imagen salga de tu equipo.</div>'
      : `<div class="hint">Crea imágenes gratis en tu PC instalando uno de estos programas (necesitas una tarjeta gráfica con 6 GB o más; sin ella funciona, pero tarda varios minutos):</div>
        <ul class="hint"><li><b>ComfyUI</b> (recomendado): instálalo, descarga un modelo en <i>models/checkpoints</i> y ábrelo. <a href="https://www.comfy.org/download" target="_blank" rel="noopener">▸ descargar</a></li>
        <li><b>Forge / AUTOMATIC1111</b>: ábrelo con la opción <b>--api</b>. <a href="https://github.com/lllyasviel/stable-diffusion-webui-forge" target="_blank" rel="noopener">▸ Forge</a></li></ul>
        <div class="hint">Después pulsa RECONECTAR. Revisa la licencia del modelo que descargues.</div>`}
    <h4>📁 CARPETAS PARA LA IA</h4>
    <div class="hint">La IA podrá buscar y leer (nunca modificar) estos documentos con ƒ HERRAMIENTAS. Cualquiera con el token puede leerlos.</div>
    ${(b.folders || []).map((f) => `<div class="mono folder">${esc(f)} <button class="btn sm red" data-act="rmfolder" data-path="${esc(f)}">✕</button></div>`).join('')}
    <button class="btn sm" data-act="addfolder">+ AÑADIR CARPETA</button>
    ${b.error ? `<div class="mono red">${esc(b.error)}</div>` : ''}
  </div>`;
}

let toastT;
function toast(m, err) {
  const t = $('#toast'); t.textContent = m; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 3800);
}

// ---------- hilos: lista, búsqueda, exportar e importar ----------
const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
function renderThreads(withCard = true) {
  const sv = S.mcp.filter(canSync);
  $('#syncInfo').innerHTML = sv.length
    ? `⇄ Sincronizado con ${sv.map((s) => `<b>${esc(s.name)}</b>`).join(', ')}: los mismos hilos en el PC, el móvil y la web.`
    : 'Se guardan en este dispositivo. Para tener los mismos hilos en el PC y el móvil, conéctalos al mismo puente en <b>⬡</b>.';
  const projects = S.projects.filter((p) => !p.deleted);
  if (S.project && !projects.some((p) => p.id === S.project)) S.project = null;
  const pr = projects.find((p) => p.id === S.project);
  $('#projectSel').innerHTML = `<option value="">TODOS LOS HILOS</option>${projects.map((p) => `<option value="${p.id}">📁 ${esc(p.name)}</option>`).join('')}<option value="__new">+ NUEVO PROYECTO…</option>`;
  $('#projectSel').value = S.project || '';
  if (withCard) $('#projectCard').innerHTML = pr ? `<div class="card">
      <label>NOMBRE DEL PROYECTO<input id="prName" value="${esc(pr.name)}" maxlength="80"></label>
      <label>MEMORIA DEL PROYECTO (la reciben todas las IAs en sus hilos)<textarea id="prMemory" rows="4" placeholder="Datos, contexto y preferencias: p. ej. «Tesis sobre energía solar, estilo académico, citar fuentes»">${esc(pr.memory || '')}</textarea></label>
      <label>HABILIDAD POR DEFECTO EN SUS HILOS NUEVOS<select id="prSkill"><option value="">— ninguna —</option>${liveSkills().map((k) => `<option value="${k.id}" ${pr.skill === k.id ? 'selected' : ''}>✦ ${esc(k.name)}</option>`).join('')}</select></label>
      <div class="row wrap">${thread().project !== pr.id ? '<button class="btn sm" id="prAdd">AÑADIR EL HILO ACTUAL</button>' : ''}<button class="btn sm red" id="prDel">BORRAR PROYECTO</button></div>
    </div>` : '';
  const q = norm($('#threadSearch').value.trim());
  const rows = [];
  for (const t of S.threads.filter((x) => !x.deleted && (x.messages.length || x.id === S.active) && (!S.project || x.project === S.project)).sort((a, b) => b.ts - a.ts)) {
    let snip = '';
    if (q) {
      if (!norm(t.title).includes(q)) {
        const m = t.messages.find((x) => norm(x.content).includes(q));
        if (!m) continue;
        const c = String(m.content), k = norm(c).indexOf(q);
        snip = `<em class="snip">…${esc(c.slice(Math.max(0, k - 40), k))}<mark>${esc(c.slice(k, k + q.length))}</mark>${esc(c.slice(k + q.length, k + q.length + 60))}…</em>`;
      }
    }
    const tp = !S.project && t.project && projects.find((p) => p.id === t.project);
    rows.push(`<div class="chatItem ${t.id === S.active ? 'on' : ''}" data-tid="${t.id}"><span>${tp ? `<small class="proj">📁 ${esc(tp.name)}</small> ` : ''}${t.source ? `<small class="proj">↘ ${esc(t.source)}</small> ` : ''}${esc(t.title)}${snip}</span><small>${new Date(t.ts).toLocaleDateString()}</small><button class="btn sm red" data-del="${t.id}" aria-label="Borrar hilo">✕</button></div>`);
  }
  $('#threadList').innerHTML = rows.join('') || `<p class="hint">${q ? 'Nada coincide con la búsqueda.' : ''}</p>`;
}
function threadMd(th) {
  const out = [`# ${th.title}`, '', `_Exportado de Neura el ${new Date().toLocaleString()}_`, ''];
  for (const m of th.messages) {
    if (m.error) continue;
    if (m.role === 'user') out.push(`## 🧑 Tú · ${new Date(m.ts).toLocaleString()}`, '', m.content || '', ...(m.files || []).map((f) => `> 📎 ${f.name}`), '');
    else out.push(`## 🤖 ${m.label || 'IA'}`, '', m.content || '', '');
  }
  return out.join('\n');
}
async function download(name, text, type) {
  if (DESK) { const p = await DESK.saveFile(name, text); if (p) toast('GUARDADO: ' + p); return; }
  const file = new File([text], name, { type });
  if (CAP && navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = (s) => String(s).replace(/[^\p{L}\p{N} _-]+/gu, '').trim().slice(0, 40) || 'hilo';
// ---------- importar: copias de Neura y exportaciones oficiales de ChatGPT, Claude y Gemini ----------
// Lector de ZIP mínimo: lee solo el índice y los archivos que interesan (las exportaciones pueden pesar mucho).
async function readZip(file) {
  const u8 = async (a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());
  const tail = await u8(Math.max(0, file.size - 65558), file.size);
  let e = -1;
  for (let k = tail.length - 22; k >= 0; k--) if (tail[k] === 0x50 && tail[k + 1] === 0x4b && tail[k + 2] === 5 && tail[k + 3] === 6) { e = k; break; }
  if (e < 0) throw new Error('El ZIP está dañado o incompleto');
  const ev = new DataView(tail.buffer, tail.byteOffset + e);
  const count = ev.getUint16(10, true), cdSize = ev.getUint32(12, true), cdOff = ev.getUint32(16, true);
  const cd = await u8(cdOff, cdOff + cdSize), dv = new DataView(cd.buffer), dec = new TextDecoder();
  const out = [];
  for (let k = 0, n = 0; n < count && k + 46 <= cd.length; n++) {
    if (dv.getUint32(k, true) !== 0x02014b50) break;
    const method = dv.getUint16(k + 10, true), size = dv.getUint32(k + 20, true), full = dv.getUint32(k + 24, true), nl = dv.getUint16(k + 28, true), xl = dv.getUint16(k + 30, true), cl = dv.getUint16(k + 32, true), off = dv.getUint32(k + 42, true);
    const name = dec.decode(cd.subarray(k + 46, k + 46 + nl));
    out.push({ name, read: async () => {
      const h = new DataView((await u8(off, off + 30)).buffer);
      const start = off + 30 + h.getUint16(26, true) + h.getUint16(28, true);
      const blob = file.slice(start, start + size);
      // Un archivo de texto de más de 400 MB no es una exportación razonable (y no cabría en memoria).
      if (full > 400 * 2 ** 20) throw new Error(`${name} es demasiado grande para importarlo`);
      if (method === 0) return blob.text();
      if (method !== 8) throw new Error(`Compresión no admitida en ${name}`);
      return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    } });
    k += 46 + nl + xl + cl;
  }
  return out;
}
// DOMParser: documento inerte (no ejecuta scripts ni carga imágenes del HTML importado).
const htmlText = (h) => new DOMParser().parseFromString(String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n'), 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trim();
const tsOf = (x) => (typeof x === 'number' ? (x < 1e12 ? x * 1000 : x) : Date.parse(x) || Date.now());
// ChatGPT: cada conversación es un árbol (mapping); se sigue la rama visible, desde el último mensaje hacia atrás.
function fromChatGPT(list) {
  return list.map((c) => {
    const msgs = [];
    for (let id = c.current_node; id && c.mapping?.[id]; id = c.mapping[id].parent) {
      const m = c.mapping[id].message, role = m?.author?.role;
      if (!m || !['user', 'assistant'].includes(role) || m.metadata?.is_visually_hidden_from_conversation) continue;
      const text = (m.content?.parts || []).filter((x) => typeof x === 'string').join('\n').trim() || (typeof m.content?.text === 'string' ? m.content.text.trim() : '');
      if (!text) continue;
      msgs.unshift({ id: 'gpt-' + (m.id || id), role, content: text, ts: tsOf(m.create_time || c.create_time), ...(role === 'assistant' ? { label: `ChatGPT${m.metadata?.model_slug ? ' / ' + m.metadata.model_slug : ''}` } : {}) });
    }
    return { id: 'gpt-' + (c.conversation_id || c.id || uid()), title: c.title || 'ChatGPT', source: 'ChatGPT', messages: msgs, ts: tsOf(c.update_time || c.create_time) };
  });
}
function fromClaude(list) {
  return list.map((c) => ({
    id: 'claude-' + (c.uuid || uid()), title: c.name || 'Claude', source: 'Claude', ts: tsOf(c.updated_at || c.created_at),
    messages: (c.chat_messages || []).map((m) => ({
      id: 'claude-' + (m.uuid || uid()), role: m.sender === 'human' ? 'user' : 'assistant', ts: tsOf(m.created_at),
      content: (m.text || (m.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')).trim(),
      ...(m.sender === 'human' ? {} : { label: 'Claude' }),
    })).filter((m) => m.content),
  }));
}
// Gemini (Google Takeout → Mi actividad → Apps de Gemini, en JSON): cada registro es una pregunta y su respuesta.
// No son conversaciones: se agrupan en un hilo por día. Formato no documentado: lectura tolerante.
function fromGemini(list) {
  const days = new Map();
  for (const a of list) {
    const PRE = /^(Prompted|Asked|Said|Has (preguntado|dicho|escrito)|Preguntaste|Dijiste)\s*:?\s*/i;
    const prompt = String(a.title || '').replace(PRE, '').trim();
    const answer = htmlText((a.safeHtmlItem || []).map((x) => x.html).join('\n'));
    // Otros registros de actividad (p. ej. «Used an Assistant feature») no son preguntas.
    if (!prompt || (!PRE.test(a.title || '') && !answer)) continue;
    const ts = tsOf(a.time), day = today(new Date(ts));
    const key = `${ts}-${prompt.length}`;
    const t = days.get(day) || days.set(day, { id: 'gemini-' + day, title: `Gemini · ${day}`, source: 'Gemini', messages: [], ts: 0 }).get(day);
    t.messages.push({ id: `gemini-u-${key}`, role: 'user', content: prompt, ts });
    if (answer) t.messages.push({ id: `gemini-a-${key}`, role: 'assistant', label: 'Gemini', content: answer, ts: ts + 1 });
    t.ts = Math.max(t.ts, ts);
  }
  return [...days.values()].map((t) => ({ ...t, messages: t.messages.sort((a, b) => a.ts - b.ts) }));
}
function parseExport(data) {
  const list = Array.isArray(data) ? data : Array.isArray(data?.threads) ? data.threads : Array.isArray(data?.conversations) ? data.conversations : null;
  if (!list) return null;
  const x = list.find((v) => v && typeof v === 'object') || {};
  if (x.mapping) return { kind: 'ChatGPT', threads: fromChatGPT(list) };
  if (x.chat_messages) return { kind: 'Claude', threads: fromClaude(list) };
  if (list.some((a) => /gemini|bard/i.test(`${a?.header} ${(a?.products || []).join(' ')}`))) return { kind: 'Gemini', threads: fromGemini(list.filter((a) => /gemini|bard/i.test(`${a?.header} ${(a?.products || []).join(' ')}`))) };
  if (Array.isArray(x.messages)) return { kind: 'Neura', threads: portable(list) };
  return null;
}
async function importThreads(file) {
  try {
    let sources;
    if (/\.zip$/i.test(file.name) || (await file.slice(0, 2).text()) === 'PK') {
      const want = (await readZip(file)).filter((z) => /(^|\/)conversations(-\d+)?\.json$/i.test(z.name) || /(gemini|bard)[^/]*\/[^/]*\.json$/i.test(z.name));
      if (!want.length) throw new Error('En el ZIP no hay conversations.json (ChatGPT o Claude) ni la actividad de Gemini en JSON');
      sources = await Promise.all(want.map((z) => z.read()));
    } else sources = [await file.text()];
    const found = [];
    for (const txt of sources) { const r = parseExport(JSON.parse(txt)); if (r) found.push(r); }
    if (!found.length) throw new Error('No es una copia de Neura ni una exportación de ChatGPT, Claude o Gemini');
    let list = found.flatMap((f) => f.threads).filter((t) => t?.id && Array.isArray(t.messages) && t.messages.length);
    // En la web y el móvil el espacio es limitado: se importan las conversaciones más recientes que quepan.
    let left = 0;
    if (!DESK) {
      list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      let size = 0; const keep = [];
      for (const t of list) { size += JSON.stringify(t).length; if (size > 3e6 && keep.length) left++; else keep.push(t); }
      list = keep;
    }
    let n = 0;
    for (const t of list) {
      t.messages.forEach((m) => { m.id ||= uid() + uid(); });
      const i = S.threads.findIndex((x) => x.id === t.id);
      if (i >= 0) S.threads[i] = mergeThread(S.threads[i], t); else S.threads.push(t);
      n++;
    }
    save(); await persistFiles(); renderThreads(); renderLog(); syncAll();
    const kinds = [...new Set(found.map((f) => f.kind))].join(' y ');
    toast(`${n} hilos importados de ${kinds}${left ? ` · ${left} más antiguos no caben aquí: impórtalos en Neura para PC` : ''}`);
  } catch (e) { toast('Importar: ' + e.message, true); }
}

// ---------- adjuntos: imágenes, PDF y texto ----------
async function shrink(file, max = 1280) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.85);
}
// Texto con marcas de página (para citar «pág. N»). Si es escaneado (sin texto), devuelve las primeras
// páginas como imágenes para que las lea una IA con visión.
const PDF_SCAN_PAGES = 5;
async function readPdf(file) {
  const pdfjs = await import('./vendor/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.js', location.href).href;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  let out = '', chars = 0;
  for (let i = 1; i <= Math.min(doc.numPages, 100) && out.length < 60000; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    const t = c.items.map((x) => x.str + (x.hasEOL ? '\n' : ' ')).join('').trim();
    chars += t.length;
    out += `--- pág. ${i} ---\n${t}\n\n`;
  }
  if (chars) return { text: out.slice(0, 60000), pages: doc.numPages };
  const images = [];
  for (let i = 1; i <= Math.min(doc.numPages, PDF_SCAN_PAGES); i++) {
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: Math.min(2, 1400 / Math.max(vp0.width, vp0.height)) });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
    images.push(c.toDataURL('image/jpeg', 0.8));
  }
  return { images, pages: doc.numPages };
}
async function addFiles(list) {
  const before = attach.length;
  try { await addFilesRaw(list); }
  finally { for (const f of attach.slice(before)) { try { await storeFile(f); } catch (e) { storageWarn(e); } } }
}
async function addFilesRaw(list) {
  for (const f of list) {
    try {
      if (f.type.startsWith('image/')) attach.push({ kind: 'image', name: f.name, data: await shrink(f) });
      else if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        toast('Leyendo PDF…');
        const r = await readPdf(f);
        if (r.text) attach.push({ kind: 'text', name: f.name, text: r.text, pdf: true });
        else {
          r.images.forEach((data, i) => attach.push({ kind: 'image', name: `${f.name} · pág. ${i + 1}`, data }));
          toast(`PDF escaneado: se enviarán ${r.images.length} página(s) como imagen${r.pages > r.images.length ? ` (de ${r.pages})` : ''}. Usa una IA con visión (p. ej. Gemini).`);
        }
      }
      else {
        if (f.size > 5e6) throw new Error('demasiado grande (máx. 5 MB)');
        const t = await f.text();
        if (t.slice(0, 4000).includes('\u0000')) throw new Error('no es un archivo de texto');
        attach.push({ kind: 'text', name: f.name, text: t.slice(0, 60000) });
      }
    } catch (e) { toast(`${f.name}: ${e.message}`, true); }
  }
  renderAttach();
}
function renderAttach() {
  $('#attachBar').hidden = !attach.length;
  $('#attachBar').innerHTML = attach.map((f, i) => `<span class="chip">${f.kind === 'image' ? `<img src="${esc(f.data)}" alt="">` : '📄'} ${esc(f.name)} <button type="button" data-unattach="${i}" aria-label="Quitar">✕</button></span>`).join('');
}

// ---------- voz: dictado y lectura en voz alta ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
const sttProvider = () => S.providers.find((p) => p.enabled !== false && p.apiKey && PRESETS[p.preset]?.stt && (!S.freeOnly || p.tier === 'free'));
async function multipart(fields, filename, blob) {
  const b = '----neura' + uid() + uid(), enc = new TextEncoder(), parts = [];
  for (const [k, v] of Object.entries(fields)) parts.push(enc.encode(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(enc.encode(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`));
  parts.push(new Uint8Array(await blob.arrayBuffer()), enc.encode(`\r\n--${b}--\r\n`));
  const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { body.set(p, o); o += p.length; }
  return { body, type: `multipart/form-data; boundary=${b}` };
}
async function transcribe(p, blob) {
  const ext = /mp4|m4a/.test(blob.type) ? 'mp4' : /ogg/.test(blob.type) ? 'ogg' : 'webm';
  const fields = { model: PRESETS[p.preset].stt, response_format: 'json' };
  const headers = { Authorization: 'Bearer ' + p.apiKey };
  let body;
  if (DESK) { const mp = await multipart(fields, `voz.${ext}`, blob); body = mp.body; headers['Content-Type'] = mp.type; }
  else { body = new FormData(); for (const [k, v] of Object.entries(fields)) body.append(k, v); body.append('file', blob, `voz.${ext}`); }
  const r = await xfetch(p.baseUrl.replace(/\/+$/, '') + '/audio/transcriptions', { method: 'POST', headers, body });
  if (!r.ok) throw httpErr(r.status, await r.text(), r.headers);
  return String((await r.json()).text || '').trim();
}
function insertText(t) {
  if (!t) return;
  input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + t;
  input.dispatchEvent(new Event('input')); input.focus();
}
const micUI = (on) => { $('#mic').classList.toggle('rec', on); $('#mic').setAttribute('aria-pressed', on); };
async function toggleMic() {
  if (rec) { rec.stop(); return; }
  // El dictado envía la voz a un servicio externo (Groq/OpenAI o el del navegador): no en hilos privados.
  if (thread().private) return toast('🔒 Hilo privado: el dictado enviaría tu voz a un servicio externo, así que está desactivado', true);
  const p = sttProvider();
  if (!p && SR) {
    // Sin clave de Groq/OpenAI: dictado del propio navegador.
    rec = new SR(); rec.lang = navigator.language || 'es-ES'; rec.interimResults = false;
    rec.onresult = (e) => insertText([...e.results].map((r) => r[0].transcript).join(' '));
    rec.onerror = (e) => toast('Dictado: ' + e.error, true);
    rec.onend = () => { rec = null; micUI(false); };
    rec.start(); micUI(true); return;
  }
  if (!p) return toast('Para dictar, añade Groq (gratis) en ⚙', true);
  if (!navigator.mediaDevices?.getUserMedia) return toast('Este dispositivo no permite grabar audio aquí', true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { return toast('Micrófono: ' + e.message, true); }
  const chunks = [];
  rec = new MediaRecorder(stream);
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    rec = null; micUI(false);
    const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
    if (!blob.size) return;
    $('#mic').classList.add('busy');
    try { insertText(await transcribe(p, blob)); }
    catch (e) { toast('Dictado: ' + netHint(e), true); }
    finally { $('#mic').classList.remove('busy'); }
  };
  rec.start(); micUI(true);
}
let speaking = null;
function speak(id) {
  const stop = speaking === id;
  speechSynthesis.cancel(); speaking = null;
  if (stop) return;
  const m = thread().messages.find((x) => x.id === id);
  if (!m?.content) return;
  const u = new SpeechSynthesisUtterance(m.content.replace(/```[\s\S]*?```/g, ' (código) ').replace(/[*_#>`|~-]+/g, ' ').replace(/https?:\/\/\S+/g, 'enlace'));
  u.lang = navigator.language || 'es-ES';
  u.onend = () => { speaking = null; };
  speaking = id; speechSynthesis.speak(u);
}

// ---------- emparejar con un PC: enlace o código QR ----------
// El PC genera http://IP:PUERTO/#pair=<base64url {u: url MCP, t: token, n: nombre}>.
function parsePair(text) {
  const m = String(text).match(/#pair=([A-Za-z0-9_-]+)/);
  if (!m) return null;
  try {
    const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
    return j.u ? { url: j.u, token: j.t || '', name: String(j.n || 'PC').toUpperCase() } : null;
  } catch { return null; }
}
function pairWith(p) {
  let s = S.mcp.find((x) => x.url === p.url);
  // Lo emparejaste tú con el QR de tu PC: es un equipo tuyo y de confianza.
  if (s) Object.assign(s, { token: p.token, mine: true, trustTools: true });
  else S.mcp.push(s = { id: uid(), name: p.name, url: p.url, token: p.token, models: [], tools: [], mine: true, trustTools: true });
  save(); mcpConnect(s);
  toast(`Emparejando con ${s.name}…`);
}
let scanStream = null;
async function scanQR() {
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) { return toast('Cámara: ' + e.message, true); }
  const v = $('#scanVideo');
  v.srcObject = scanStream; $('#scan').hidden = false; await v.play();
  const det = new BarcodeDetector({ formats: ['qr_code'] });
  while (scanStream) {
    try {
      const [code] = await det.detect(v);
      const p = code && parsePair(code.rawValue);
      if (p) { stopScan(); pairWith(p); return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
}
function stopScan() { scanStream?.getTracks().forEach((t) => t.stop()); scanStream = null; $('#scan').hidden = true; }

// ---------- habilidades (skills): procedimientos reutilizables con cualquier IA ----------
// Formato de intercambio: SKILL.md de Agent Skills (frontmatter name/description + instrucciones).
// Solo texto: una habilidad no concede permisos ni ejecuta nada; importarla tampoco.
const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64) || 'habilidad';
function parseSkillMd(text) {
  const t = String(text).replace(/^\uFEFF/, '').trim().replace(/^```[\w-]*\n([\s\S]*?)\n```$/, '$1').trim();
  const m = t.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return { name: '', description: '', instructions: t };
  // Frontmatter YAML simple: «clave: valor», bloques «>» (une con espacios) y «|» (conserva saltos)
  // y continuaciones sangradas. shortcut: sin listas ni objetos anidados, que Agent Skills no usa en name/description.
  const fm = {};
  let key = null, mode = '';
  for (const l of m[1].split('\n')) {
    const kv = l.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1]; const v = kv[2].trim();
      mode = /^[>|][+-]?$/.test(v) ? v[0] : ' ';
      fm[key] = mode === ' ' ? v.replace(/^["']|["']$/g, '') : '';
    } else if (key && /^\s+\S/.test(l)) fm[key] += (fm[key] ? (mode === '|' ? '\n' : ' ') : '') + l.trim();
  }
  return { name: fm.name || '', description: (fm.description || '').trim(), instructions: m[2].trim() };
}
const skillMd = (k) => `---\nname: ${slug(k.name)}\ndescription: ${String(k.description).replace(/\n/g, ' ')}\n---\n\n${k.instructions}\n`;
let skDraft = null; // { id?, name, description, instructions, mode: 'goal' | 'edit' }
function renderSkills() {
  const act = activeSkill();
  $('#skillList').innerHTML = liveSkills().map((k) => `
    <div class="card ${act?.id === k.id ? 'skill-on' : ''}" data-kid="${k.id}">
      <div class="head"><b class="srv">✦ ${esc(k.name)}</b><span class="badge local">v${k.version}</span>${act?.id === k.id ? '<span class="badge on">ACTIVA EN ESTE HILO</span>' : ''}</div>
      <div class="hint">${esc(k.description)}</div>
      <div class="row wrap">${act?.id === k.id ? '<button class="btn sm ghost" data-sk="off">QUITAR DE ESTE HILO</button>' : '<button class="btn sm" data-sk="use">USAR EN ESTE HILO</button>'}
        <button class="btn sm ghost" data-sk="edit">EDITAR</button><button class="btn sm ghost" data-sk="export">EXPORTAR</button><button class="btn sm red" data-sk="del">✕</button></div>
    </div>`).join('') || '<p class="hint">Aún no tienes habilidades. Crea una con IA, en blanco, o importa un SKILL.md.</p>';
  const d = skDraft, ed = $('#skEditor');
  if (!d) { ed.innerHTML = ''; return; }
  ed.innerHTML = d.mode === 'goal' ? `<div class="card">
      <h4>CREAR CON IA</h4>
      <label>¿QUÉ QUIERES QUE HAGA?<textarea id="skGoal" rows="3" placeholder="Ej.: convierte mis apuntes en un resumen y 5 preguntas de repaso">${esc(d.goal || '')}</textarea></label>
      <label>EJEMPLO (opcional)<textarea id="skExample" rows="2" placeholder="Una entrada típica o cómo quieres el resultado">${esc(d.example || '')}</textarea></label>
      <div class="row"><button class="btn" id="skGen">GENERAR BORRADOR</button><button class="btn sm ghost" id="skCancel">CANCELAR</button></div>
    </div>` : `<div class="card">
      <h4>${d.id ? 'EDITAR HABILIDAD' : 'REVISA EL BORRADOR'}</h4>
      ${(() => { const k = d.id && S.skills.find((x) => x.id === d.id); return k?.history?.length ? `<div class="hint">Versiones anteriores: ${k.history.slice().reverse().map((h) => `<button type="button" class="btn sm ghost" data-restore="${h.version}" title="${esc(new Date(h.ts).toLocaleString())}">v${h.version}</button>`).join(' ')} · cargar una la guarda como versión nueva</div>` : ''; })()}
      <label>NOMBRE<input id="skName" value="${esc(d.name)}" maxlength="64"></label>
      <label>CUÁNDO USARLA<input id="skDesc" value="${esc(d.description)}" maxlength="1024"></label>
      <label>INSTRUCCIONES<textarea id="skInstr" rows="10">${esc(d.instructions)}</textarea></label>
      <p class="hint" id="skSize"></p>
      <label>PROBAR CON UNA ENTRADA<textarea id="skSample" rows="2" placeholder="Pega un texto de ejemplo">${esc(d.sample || '')}</textarea></label>
      <div class="row wrap"><button class="btn sm ghost" id="skTest">PROBAR</button><button class="btn" id="skSave">GUARDAR${d.id ? ' NUEVA VERSIÓN' : ''}</button><button class="btn sm ghost" id="skCancel">CANCELAR</button></div>
      <div id="skResult"></div>
    </div>`;
  skSize();
}
function skSize() {
  const el = $('#skInstr'); if (!el) return;
  const t = Math.ceil(el.value.length / 3.5);
  $('#skSize').textContent = `≈ ${t} tokens en cada mensaje${t > 1200 ? ' · es larga: las IAs gratuitas con poco contexto lo notarán' : ''}`;
}
const readDraft = () => Object.assign(skDraft, { name: $('#skName').value.trim(), description: $('#skDesc').value.trim(), instructions: $('#skInstr').value.trim(), sample: $('#skSample').value });
const SK_FORMAT = 'Responde SOLO con el archivo SKILL.md, sin explicaciones ni bloques de código, con este formato exacto:\n---\nname: nombre-en-minusculas-con-guiones\ndescription: Qué hace y cuándo usarla, en una o dos frases.\n---\n\n# Título\n\nInstrucciones en pasos numerados, formato de la respuesta y qué hacer si falta información. No inventes herramientas, archivos ni capacidades. En español, máximo 300 palabras.';
async function draftSkill(prompt, btn) {
  btn.disabled = true; btn.textContent = 'GENERANDO…';
  try {
    const { text, t } = await ask([{ role: 'system', content: 'Diseñas habilidades (skills) reutilizables para asistentes de IA en formato SKILL.md de Agent Skills.' }, { role: 'user', content: prompt }]);
    const p = parseSkillMd(text);
    if (!p.instructions) throw new Error('la IA no devolvió instrucciones');
    skDraft = { mode: 'edit', name: p.name.replace(/-/g, ' ') || 'Nueva habilidad', description: p.description, instructions: p.instructions };
    renderSkills(); toast(`Borrador creado con ${t.label}: revísalo y pruébalo`);
  } catch (e) { toast('Crear habilidad: ' + netHint(e), true); btn.disabled = false; btn.textContent = 'GENERAR BORRADOR'; }
}
// Desde una buena respuesta: se extrae el procedimiento y se quitan los datos particulares.
function skillFromReply(id) {
  const msgs = thread().messages, i = msgs.findIndex((m) => m.id === id);
  const user = [...msgs.slice(0, i)].reverse().find((m) => m.role === 'user');
  const convo = `USUARIO: ${textOf(userContent(user || {}, false))}\n\nIA: ${msgs[i].content}`.slice(0, 8000);
  openSheet('#sheetSkills');
  skDraft = { mode: 'goal' }; renderSkills();
  draftSkill(`Esta conversación salió bien. Extrae el procedimiento reutilizable como una habilidad para repetirlo con otros datos. Sustituye los datos particulares (nombres, rutas, cifras, claves) por descripciones genéricas; no copies el contenido concreto.\n\n${convo}\n\n${SK_FORMAT}`, $('#skGen'));
}
// Sugerencia mientras escribes: si el mensaje encaja con una habilidad, se propone; nunca se activa en silencio.
const STOP = new Set('para como cuando este esta esto estos estas sobre desde hasta entre pero porque donde quiero puedes hacer hace usar usarla texto cosas'.split(' '));
const words = (t) => new Set(norm(t).split(/[^a-z0-9ñ]+/).filter((x) => x.length > 3 && !STOP.has(x)));
function suggestSkill(text) {
  const th = thread();
  if (th.skill || text.trim().length < 8) return null;
  const w = [...words(text)];
  let best = null, bestN = 0;
  for (const k of liveSkills()) {
    if ((th.noSuggest || []).includes(k.id)) continue;
    // Coincidencia por raíz (5 letras) para que "apunte" encaje con "apuntes" y "resumir" con "resumen".
    const n = [...words(`${k.name} ${k.description}`)].filter((x) => w.some((y) => y.slice(0, 5) === x.slice(0, 5))).length;
    if (n > bestN) { bestN = n; best = k; }
  }
  return bestN >= 2 ? best : null;
}
let hintT;
function renderSkillHint() {
  const k = suggestSkill($('#input').value), el = $('#skillHint');
  el.hidden = !k;
  if (k) { el.dataset.kid = k.id; el.innerHTML = `✦ ¿Usar la habilidad <b>${esc(k.name)}</b> en este hilo? <button type="button" class="btn sm" data-hint="use">USAR</button><button type="button" class="btn sm ghost" data-hint="no">NO</button>`; }
}
$('#input').addEventListener('input', () => { clearTimeout(hintT); hintT = setTimeout(renderSkillHint, 300); });
$('#skillHint').addEventListener('click', (e) => {
  const act = e.target.dataset.hint; if (!act) return;
  const th = thread(), id = $('#skillHint').dataset.kid;
  if (act === 'use') th.skill = id; else th.noSuggest = [...(th.noSuggest || []), id];
  th.ts = Date.now(); save(); renderLog(); renderSkillHint(); input.focus();
});
$('#btnSkills').onclick = () => { renderSkills(); openSheet('#sheetSkills'); };
$('#skNew').onclick = () => { skDraft = { mode: 'goal' }; renderSkills(); $('#skGoal').focus(); };
$('#skBlank').onclick = () => { skDraft = { mode: 'edit', name: '', description: '', instructions: '' }; renderSkills(); $('#skName').focus(); };
$('#skImport').onclick = () => $('#skFile').click();
$('#skFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 100e3) return toast('SKILL.md demasiado grande (máx. 100 KB)', true);
  const p = parseSkillMd(await f.text());
  // Se importa como borrador para revisarlo antes de guardar: el contenido de terceros no es de confianza.
  skDraft = { mode: 'edit', name: p.name.replace(/-/g, ' ') || f.name.replace(/\.md$/i, ''), description: p.description, instructions: p.instructions };
  renderSkills(); toast('Revisa la habilidad importada antes de guardarla');
};
$('#skEditor').addEventListener('input', (e) => { if (e.target.id === 'skInstr') skSize(); });
$('#skEditor').addEventListener('click', async (e) => {
  const id = e.target.id;
  if (id === 'skCancel') { skDraft = null; renderSkills(); }
  const rv = e.target.dataset.restore;
  if (rv) {
    const h = S.skills.find((x) => x.id === skDraft.id)?.history?.find((x) => String(x.version) === rv);
    if (h) { Object.assign(skDraft, { name: h.name, description: h.description, instructions: h.instructions }); renderSkills(); toast(`v${h.version} cargada: pulsa GUARDAR para restaurarla`); }
  }
  if (id === 'skGen') {
    const goal = $('#skGoal').value.trim(), ex = $('#skExample').value.trim();
    if (!goal) return toast('Describe qué quieres que haga', true);
    Object.assign(skDraft, { goal, example: ex });
    draftSkill(`Crea una habilidad para: ${goal}${ex ? `\n\nEjemplo: ${ex}` : ''}\n\n${SK_FORMAT}`, e.target);
  }
  if (id === 'skTest') {
    const d = readDraft();
    if (!d.instructions || !d.sample.trim()) return toast('Escribe las instrucciones y una entrada de prueba', true);
    e.target.disabled = true; e.target.textContent = 'PROBANDO…';
    try {
      const { text, t } = await ask(withInstructions([{ role: 'user', content: d.sample }], { name: d.name || 'borrador', version: 'prueba', instructions: d.instructions }));
      $('#skResult').innerHTML = `<div class="reply"><div class="tag"><span>PRUEBA · ${esc(t.label)}</span></div><div class="txt">${md(text)}</div></div>`;
    } catch (err) { toast('Prueba: ' + netHint(err), true); }
    e.target.disabled = false; e.target.textContent = 'PROBAR';
  }
  if (id === 'skSave') {
    const d = readDraft();
    if (!d.name || !d.instructions) return toast('La habilidad necesita nombre e instrucciones', true);
    const k = d.id && S.skills.find((x) => x.id === d.id);
    if (k) {
      const changed = k.name !== d.name || k.description !== d.description || k.instructions !== d.instructions;
      // Las versiones anteriores se guardan sin cambios para poder consultarlas o restaurarlas.
      if (changed) k.history = [...(k.history || []), { version: k.version, name: k.name, description: k.description, instructions: k.instructions, ts: k.updatedAt }].slice(-20);
      Object.assign(k, { name: d.name, description: d.description, instructions: d.instructions, version: k.version + (changed ? 1 : 0), updatedAt: Date.now() });
    } else S.skills.push({ id: uid() + uid(), name: d.name, description: d.description, instructions: d.instructions, version: 1, updatedAt: Date.now() });
    skDraft = null; save(); renderSkills(); renderLog(); syncAll(); toast('HABILIDAD GUARDADA');
  }
});
$('#skillList').addEventListener('click', (e) => {
  const act = e.target.dataset.sk, card = e.target.closest('[data-kid]'); if (!act || !card) return;
  const k = S.skills.find((x) => x.id === card.dataset.kid), th = thread();
  if (act === 'use' || act === 'off') { th.skill = act === 'use' ? k.id : null; th.ts = Date.now(); save(); renderLog(); syncAll(); if (act === 'use') { closeSheets(); toast(`✦ ${k.name} activa en este hilo`); } }
  if (act === 'edit') { skDraft = { mode: 'edit', id: k.id, name: k.name, description: k.description, instructions: k.instructions }; }
  if (act === 'export') download(`SKILL-${slug(k.name)}.md`, skillMd(k), 'text/markdown');
  if (act === 'del') {
    if (!confirm(`¿Borrar la habilidad «${k.name}»?`)) return;
    // Se marca como borrada (no se quita) para que el borrado llegue a los demás dispositivos.
    Object.assign(k, { deleted: true, instructions: '', updatedAt: Date.now() });
    save(); renderLog(); syncAll();
  }
  renderSkills();
});

// ---------- PIN: claves cifradas con AES-GCM ----------
const vault = { key: null, locked: !!S.vault, sealed: '', timer: null };
const b64 = (u8) => btoa(String.fromCharCode(...new Uint8Array(u8)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
const secretsOf = () => JSON.stringify({ p: Object.fromEntries(S.providers.map((p) => [p.id, p.apiKey || ''])), m: Object.fromEntries(S.mcp.filter((s) => !s.local).map((s) => [s.id, s.token || ''])) });
function applySecrets(json) {
  const x = JSON.parse(json);
  for (const p of S.providers) if (x.p?.[p.id] != null) p.apiKey = x.p[p.id];
  for (const s of S.mcp) if (!s.local && x.m?.[s.id] != null) s.token = x.m[s.id];
}
function sealSoon() {
  clearTimeout(vault.timer);
  vault.timer = setTimeout(async () => {
    const plain = secretsOf();
    if (plain === vault.sealed || !vault.key) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault.key, new TextEncoder().encode(plain));
    S.vault = { ...S.vault, iv: b64(iv), data: b64(data) };
    vault.sealed = plain; save();
  }, 200);
}
async function vaultEnable(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  vault.key = await deriveKey(pin, salt); vault.locked = false; vault.sealed = '';
  S.vault = { salt: b64(salt) };
  save(); // sealSoon cifra y vuelve a guardar sin las claves en claro
}
async function vaultOpen(pin) {
  const key = await deriveKey(pin, unb64(S.vault.salt));
  const plain = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(S.vault.iv) }, key, unb64(S.vault.data)));
  applySecrets(plain);
  Object.assign(vault, { key, locked: false, sealed: plain });
}
function unlockDialog() {
  return new Promise((resolve) => {
    const dlg = $('#lock'), form = $('#lockForm'), pin = $('#lockPin');
    dlg.hidden = false; pin.value = ''; setTimeout(() => pin.focus(), 50);
    const close = () => { dlg.hidden = true; form.onsubmit = null; $('#lockSkip').onclick = null; $('#lockReset').onclick = null; renderProviders(); renderMcp(); resolve(); };
    form.onsubmit = async (e) => {
      e.preventDefault();
      try { await vaultOpen(pin.value); close(); toast('CLAVES DESBLOQUEADAS'); }
      catch { pin.value = ''; toast('PIN incorrecto', true); }
    };
    $('#lockSkip').onclick = close;
    $('#lockReset').onclick = () => {
      if (!confirm('Se borrarán las claves API y tokens guardados (los hilos se conservan). ¿Continuar?')) return;
      S.vault = null; Object.assign(vault, { key: null, locked: false });
      save(); close();
    };
  });
}

// ---------- eventos ----------
function openSheet(id) { closeSheets(); const s = $(id); s.classList.add('open'); s.setAttribute('aria-hidden', 'false'); }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => { s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); }); }
$('#btnAis').onclick = () => { renderProviders(); openSheet('#sheetAis'); };
$('#btnMcp').onclick = () => { renderMcp(); openSheet('#sheetMcp'); };
$('#btnThreads').onclick = () => { renderThreads(); openSheet('#sheetThreads'); syncAll(); };
$('#threadSearch').oninput = () => renderThreads();
$('#newThread').onclick = () => {
  if (busy) return toast('Espera a que termine la respuesta');
  if (thread().messages.length) S.active = null;
  // Si el hilo actual está vacío se reutiliza, pero empieza limpio: solo hereda lo del proyecto.
  const th = thread(), pr = S.projects.find((p) => p.id === S.project && !p.deleted);
  Object.assign(th, { project: pr?.id || null, skill: pr?.skill || null, private: false, noSuggest: [] });
  save(); renderLog(); closeSheets();
};
$('#projectSel').onchange = (e) => {
  if (e.target.value === '__new') {
    // Sin prompt(): no existe en la app de PC. Se crea y se escribe el nombre en su tarjeta.
    const p = { id: uid() + uid(), name: 'Proyecto nuevo', memory: '', skill: null, updatedAt: Date.now() };
    S.projects.push(p); S.project = p.id; syncAll();
  } else S.project = e.target.value || null;
  save(); renderThreads();
  if (e.target.value === '__new') { $('#prName').select(); $('#prName').focus(); }
};
$('#projectCard').addEventListener('change', (e) => {
  const pr = S.projects.find((p) => p.id === S.project); if (!pr) return;
  if (e.target.id === 'prName' && e.target.value.trim()) pr.name = e.target.value.trim();
  if (e.target.id === 'prMemory') pr.memory = e.target.value;
  if (e.target.id === 'prSkill') pr.skill = e.target.value || null;
  // Sin redibujar la tarjeta: el campo que se está editando sigue en su sitio.
  pr.updatedAt = Date.now(); save(); renderThreads(false); renderLog(); syncAll();
  toast('PROYECTO GUARDADO');
});
$('#projectCard').addEventListener('click', (e) => {
  const pr = S.projects.find((p) => p.id === S.project); if (!pr) return;
  if (e.target.id === 'prAdd') { const th = thread(); Object.assign(th, { project: pr.id, ts: Date.now() }); if (!th.skill && pr.skill) th.skill = pr.skill; }
  if (e.target.id === 'prDel') {
    if (!confirm(`¿Borrar el proyecto «${pr.name}»? Sus hilos se conservan, sin proyecto.`)) return;
    Object.assign(pr, { deleted: true, memory: '', updatedAt: Date.now() });
    S.project = null;
  }
  save(); renderThreads(); renderLog(); syncAll();
});
$('#threadList').addEventListener('click', (e) => {
  if (busy) return toast('Espera a que termine la respuesta');
  const del = e.target.dataset.del;
  if (del) {
    if (!confirm('¿Borrar este hilo? Se borrará también en los equipos sincronizados.')) return;
    // Se deja una marca de borrado para que el borrado llegue a los demás dispositivos.
    Object.assign(S.threads.find((t) => t.id === del), { deleted: true, messages: [], summary: null, ts: Date.now() });
    if (S.active === del) S.active = S.threads.find((t) => !t.deleted)?.id ?? null;
    save(); renderThreads(); renderLog(); syncAll(); return;
  }
  const it = e.target.closest('[data-tid]'); if (!it) return;
  S.active = it.dataset.tid; save(); renderLog(); closeSheets();
});
// PDF: en el PC se genera directamente; en la web, el diálogo de imprimir («Guardar como PDF»);
// en el móvil, una página HTML lista para abrir e imprimir.
async function exportPdf() {
  const th = thread();
  if (!th.messages.length) return toast('El hilo está vacío', true);
  closeSheets();
  document.body.dataset.print = th.title;
  const name = `${safeName(th.title)}.pdf`;
  try {
    if (DESK?.savePdf) { const p = await DESK.savePdf(name); if (p) toast('GUARDADO: ' + p); }
    else if (CAP) {
      const page = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(th.title)}</title><style>body{font:15px/1.5 system-ui,sans-serif;max-width:800px;margin:auto;padding:16px;color:#111}h1{font-size:20px}.u{background:#f1ecfa;border-left:3px solid #7b3fc9;padding:8px 10px;white-space:pre-wrap}.l{font:12px monospace;color:#666;margin-top:14px}pre{background:#f4f4f4;padding:8px;overflow:auto}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px}</style></head><body><h1>${esc(th.title)}</h1>`
        + th.messages.filter((m) => !m.error && !m.pending).map((m) => (m.role === 'user' ? `<div class="l">TÚ · ${new Date(m.ts).toLocaleString()}</div><div class="u">${esc(m.content)}</div>` : `<div class="l">${esc(m.label || 'IA')}</div>${md(m.content)}`)).join('') + '</body></html>';
      await download(`${safeName(th.title)}.html`, page, 'text/html');
    } else { renderLog(); window.print(); }
  } finally { delete document.body.dataset.print; }
}
$('#exportPdf').onclick = exportPdf;
$('#exportMd').onclick = () => { const th = thread(); if (!th.messages.length) return toast('El hilo está vacío', true); download(`${safeName(th.title)}.md`, threadMd(th), 'text/markdown'); };
document.addEventListener('click', (e) => { if (e.target.id === 'saveWarnExport') $('#exportAll').click(); });
$('#exportAll').onclick = () => download(`neura-hilos-${new Date().toISOString().slice(0, 10)}.json`,
  JSON.stringify({ app: 'neura', version: 2, exported: new Date().toISOString(), threads: portable(S.threads.filter((t) => !t.deleted && t.messages.length)) }, null, 1), 'application/json');
$('#importBtn').onclick = () => $('#importFile').click();
$('#importFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importThreads(f); };
document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('.close')) closeSheets(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSheets(); stopScan(); } });

$('#target').onchange = (e) => { S.target = e.target.value; save(); };
$('#autoSkip').onchange = (e) => { S.autoSkip = e.target.checked; save(); };
$('#council').onchange = (e) => { S.council = e.target.checked; save(); if (S.council) toast(`⚖ CONSEJO: ${councilMembers(findT(S.target)).length} IAs responderán a la vez`); };
$('#private').onchange = (e) => {
  const th = thread();
  th.private = e.target.checked; th.ts = Date.now();
  save(); renderTargets(); syncAll();
  if (th.private) toast('🔒 HILO PRIVADO: solo responderán tus equipos (⬡)');
};
$('#useTools').onchange = (e) => { S.useTools = e.target.checked; save(); if (S.useTools) toast(`ƒ ${toolbox().length} herramientas disponibles para la IA`); };

const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#send').click(); }
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  if (busy) { abortCtl?.abort(); return; }
  const text = input.value.trim();
  if (!text && !attach.length) return;
  if (/^\/imagen\b/i.test(text)) { input.value = ''; input.style.height = 'auto'; $('#skillHint').hidden = true; return sendImage(text); }
  const files = attach; attach = []; renderAttach(); $('#skillHint').hidden = true;
  input.value = ''; input.style.height = 'auto';
  send(text, files);
};
$('#attachBtn').onclick = () => $('#fileIn').click();
$('#fileIn').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
$('#attachBar').addEventListener('click', (e) => { const i = e.target.dataset.unattach; if (i != null) { attach.splice(+i, 1); renderAttach(); } });
$('#mic').hidden = !(SR || (navigator.mediaDevices?.getUserMedia && window.MediaRecorder));
$('#mic').onclick = toggleMic;
$('#app').addEventListener('dragover', (e) => e.preventDefault());
$('#app').addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]); });
$('#log').addEventListener('click', (e) => {
  const { copy, speak: sp, skillify } = e.target.dataset || {};
  if (e.target.dataset?.vote) return vote(e.target.dataset.vote);
  if (e.target.dataset?.saveimg) return saveImage(e.target.dataset.saveimg);
  if (sp) return speak(sp);
  if (skillify) return skillFromReply(skillify);
  const { branch: br, edit } = e.target.dataset || {};
  if (br || edit) {
    if (busy) return toast('Espera a que termine la respuesta', true);
    const src = thread(), i = src.messages.findIndex((m) => m.id === (br || edit));
    if (i < 0) return;
    const orig = src.messages[i];
    // La rama copia el hilo hasta ese mensaje (incluido en ⑂, excluido en ✎) con ids nuevos; el original no cambia.
    const copy = src.messages.slice(0, edit ? i : i + 1).map((m) => ({ ...JSON.parse(JSON.stringify(m)), id: uid() + uid() }));
    const th = { id: uid(), title: `⑂ ${src.title}`.slice(0, 60), messages: copy, ts: Date.now(), project: src.project || null, skill: src.skill || null, private: !!src.private };
    S.threads.unshift(th); S.active = th.id;
    if (edit) { input.value = orig.content || ''; input.dispatchEvent(new Event('input')); attach = (orig.files || []).map((f) => ({ ...f })); renderAttach(); input.focus(); }
    save(); renderLog(); syncAll();
    toast(edit ? '✎ Rama creada: edita el mensaje y envíalo' : '⑂ Rama creada a partir de ese mensaje');
  }
  if (!copy) return;
  const m = thread().messages.find((x) => x.id === copy);
  navigator.clipboard?.writeText(m?.content || '').then(() => toast('COPIADO'), () => toast('No se pudo copiar', true));
});

// IAs y ajustes
$('#presetSel').innerHTML = Object.entries(PRESETS).filter(([, p]) => NATIVE || !p.nativeOnly).map(([k, p]) => `<option value="${k}">${p.name}${p.tier === 'free' ? ' — GRATIS' : p.tier === 'paid' ? ' — PAGO' : ''}</option>`).join('');
$('#addProv').onclick = () => {
  const k = $('#presetSel').value;
  S.providers.push({ id: uid(), preset: k, ...JSON.parse(JSON.stringify(PRESETS[k])), apiKey: '', enabled: true });
  save(); renderProviders(); renderTargets(); renderLog();
};
const resetHealth = (p) => p.models.forEach((m) => delete S.health[`${p.id}::${m}`]);
$('#provList').addEventListener('change', (e) => {
  const card = e.target.closest('[data-pid]'), f = e.target.dataset.f; if (!card || !f) return;
  const p = S.providers.find((x) => x.id === card.dataset.pid);
  if (f === 'dailyLimit') { p.dailyLimit = Math.max(0, Math.floor(+e.target.value || 0)) || null; save(); return; }
  if (f === 'priceIn' || f === 'priceOut') { p.price = { ...p.price, [f === 'priceIn' ? 'in' : 'out']: Math.max(0, +e.target.value || 0) }; save(); return; }
  p[f] = f === 'models' ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value.trim();
  if (f === 'apiKey' || f === 'baseUrl') { resetHealth(p); refreshed.delete(p.id); refreshModels(p); }
  if (f === 'apiKey' && vault.locked) toast('Las claves están bloqueadas con PIN: desbloquéalas para guardar cambios', true);
  save(); renderTargets();
});
$('#provList').addEventListener('click', async (e) => {
  const act = e.target.dataset.act, card = e.target.closest('[data-pid]'); if (!act || !card) return;
  const p = S.providers.find((x) => x.id === card.dataset.pid);
  if (act === 'del') { if (!confirm(`¿Eliminar ${p.name}?`)) return; resetHealth(p); S.providers = S.providers.filter((x) => x !== p); }
  if (act === 'toggle') p.enabled = p.enabled === false;
  if (act === 'reset') resetHealth(p);
  if (act === 'scan') {
    e.target.textContent = 'ESCANEANDO…';
    try { const m = await fetchModels(p); if (!m.length) throw new Error('No se encontraron modelos'); p.models = m; toast(`${p.name}: ${m.length} modelos`); }
    catch (err) { toast(`${p.name}: ${netHint(err)}`, true); }
  }
  if (act === 'test') {
    if (!p.models[0]) return toast('Sin modelos', true);
    e.target.textContent = 'PROBANDO…';
    const t = { key: `${p.id}::${p.models[0]}`, pid: p.id, model: p.models[0], kind: p.kind };
    try { const t0 = performance.now(); const r = await callTarget(t, [{ role: 'user', content: 'Responde solo: OK' }], () => {}); noteOk(t, Math.round(performance.now() - t0)); toast(`${p.models[0]} → "${r.trim().slice(0, 40)}" · ${Math.round(performance.now() - t0)} ms`); }
    catch (err) { noteFail(t, err); toast(`${p.name}: ${err.status ? `[${err.status}] ` : ''}${netHint(err)}`, true); }
  }
  save(); renderProviders(); renderTargets(); renderLog();
});
$('#settings').addEventListener('change', (e) => {
  if (e.target.id === 'budgetDay' || e.target.id === 'budgetMonth') {
    S.budget = { ...S.budget, [e.target.id === 'budgetDay' ? 'day' : 'month']: Math.max(0, +e.target.value || 0) };
    save(); renderTargets(); repaintUsage(); toast('TOPE DE GASTO GUARDADO');
  }
  if (e.target.id === 'routeOn') { S.routing = { ...S.routing, on: e.target.checked }; save(); renderSettings(); }
  if (e.target.dataset.route) { S.routing = { ...S.routing, rules: { ...S.routing?.rules, [e.target.dataset.route]: e.target.value } }; save(); toast('ENRUTADO GUARDADO'); }
  if (e.target.id === 'ctxTokens') { S.ctxTokens = Math.max(1000, +e.target.value || 6000); save(); }
  if (e.target.id === 'freeOnly') { S.freeOnly = e.target.checked; save(); renderTargets(); }
  if (e.target.id === 'instructions') { S.instructions = e.target.value; save(); toast('INSTRUCCIONES GUARDADAS'); }
  const k = e.target.dataset.council;
  if (k) { S.councilKeys = e.target.checked ? [...new Set([...S.councilKeys, k])] : S.councilKeys.filter((x) => x !== k); save(); }
});
$('#settings').addEventListener('click', async (e) => {
  if (e.target.id === 'diagRun') diagnose($('#diagAll').checked);
  if (e.target.id === 'addStarters') { const n = installStarters([...STARTERS, ...EXTRA_STARTERS]); toast(n ? `${n} habilidades añadidas (✦)` : 'Ya las tienes'); }
  if (e.target.dataset.level) setTimeout(renderSettings, 0);
  if (e.target.id === 'vaultOn') {
    const pin = $('#pinNew').value;
    if (pin.length < 4) return toast('El PIN debe tener al menos 4 caracteres', true);
    await vaultEnable(pin); toast('PIN ACTIVADO: claves cifradas'); renderSettings();
  }
  if (e.target.id === 'vaultOff') {
    if (!confirm('¿Quitar el PIN? Las claves volverán a guardarse sin cifrar.')) return;
    S.vault = null; Object.assign(vault, { key: null, locked: false }); save(); renderSettings();
  }
  if (e.target.id === 'vaultUnlock') { await unlockDialog(); renderSettings(); }
});

// MCP
$('#mcpForm').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const raw = String(f.get('url')).trim();
  const p = parsePair(raw);
  if (p) { e.target.reset(); return pairWith(p); }
  let url = raw;
  if (new URL(url).pathname === '/') url = url.replace(/\/+$/, '') + '/mcp'; // http://ip:8787 → /mcp
  const s = { id: uid(), name: String(f.get('name')).trim().toUpperCase(), url, token: String(f.get('token')).trim(), models: [], tools: [] };
  S.mcp.push(s); e.target.reset(); save(); mcpConnect(s);
};
$('#mcpForm input[name=url]').addEventListener('input', (e) => {
  // Si se pega un enlace de emparejamiento, el resto de campos se rellenan solos.
  const p = parsePair(e.target.value);
  if (!p) return;
  const form = $('#mcpForm');
  form.elements.name.value = p.name; form.elements.token.value = p.token;
});
$('#scanBtn').hidden = !!DESK || !('BarcodeDetector' in window && navigator.mediaDevices?.getUserMedia);
$('#scanBtn').onclick = scanQR;
$('#scanClose').onclick = stopScan;
$('#mcpList').addEventListener('change', async (e) => {
  const act = e.target.dataset.act, card = e.target.closest('[data-sid]'); if (!act || !card) return;
  const s = S.mcp.find((x) => x.id === card.dataset.sid);
  if (act === 'sync') { s.sync = e.target.checked; save(); syncWith(s); }
  if (act === 'trust') { s.trustTools = e.target.checked; save(); }
  if (act === 'gw' || act === 'gwlocal' || act === 'gwunknown' || act === 'gwcache') {
    S.gateway = { ...S.gateway, [{ gw: 'enabled', gwlocal: 'localOnly', gwunknown: 'unknownAsAuto', gwcache: 'cache' }[act]]: e.target.checked };
    save(); renderMcp();
    if (act === 'gw') toast(e.target.checked ? '🔌 Gateway activo: copia la configuración de tu herramienta' : 'Gateway desactivado');
  }
  if (act === 'mine') { s.mine = e.target.checked; save(); renderTargets(); }
  if (act === 'lan') {
    e.target.disabled = true;
    await DESK.setLan(e.target.checked);
    await mcpConnect(s, true).catch(() => {});
    renderMcp();
  }
});
$('#mcpList').addEventListener('click', async (e) => {
  const act = e.target.dataset.act, card = e.target.closest('[data-sid]'); if (!act || !card) return;
  const s = S.mcp.find((x) => x.id === card.dataset.sid);
  if (act === 'copytoken') navigator.clipboard?.writeText(DESK.bridge().token).then(() => toast('TOKEN COPIADO'));
  if (act === 'regengw') {
    if (!confirm('¿Generar un token nuevo para el Gateway? Las herramientas configuradas con el anterior dejarán de funcionar hasta que copies el nuevo.')) return;
    await DESK.regenGatewayToken();
    await mcpConnect(s, true).catch(() => {});
    gwSent = ''; pushGatewaySoon(); renderMcp(); toast('TOKEN DEL GATEWAY NUEVO: actualízalo en tus herramientas');
  }
  if (act === 'copysnip') navigator.clipboard?.writeText(e.target.parentElement.querySelector('.snip').textContent).then(() => toast('COPIADO'));
  if (act === 'regentoken') {
    if (!confirm('¿Generar un token nuevo? Los móviles y equipos conectados a este PC tendrán que volver a emparejarse con el QR.')) return;
    const b = await DESK.regenToken();
    Object.assign(s, { token: b.token, url: `http://127.0.0.1:${b.port}/mcp` });
    await mcpConnect(s, true).catch(() => {});
    save(); renderMcp(); toast('TOKEN NUEVO: vuelve a emparejar tus dispositivos');
  }
  if (act === 'reconnect') mcpConnect(s);
  if (act === 'del') { S.mcp = S.mcp.filter((x) => x !== s); save(); renderMcp(); renderTargets(); renderLog(); }
  if (['addfolder', 'rmfolder', 'tson', 'tsoff'].includes(act)) {
    e.target.disabled = true;
    const r = act === 'addfolder' ? await DESK.addFolder() : act === 'rmfolder' ? await DESK.removeFolder(e.target.dataset.path)
      : await DESK.tailscale(act === 'tson');
    if (r?.error) toast(r.error, true);
    if (act.includes('folder')) await mcpConnect(s, true).catch(() => {});
    renderMcp();
  }
});

// ---------- arranque ----------
async function boot() {
  S.threads.flatMap((t) => t.messages).forEach((m) => { if (m.pending) { m.pending = false; m.error = m.error || 'Interrumpido'; } });
  await hydrateFiles();
  persistFiles(); // migra a IndexedDB los adjuntos que aún iban dentro del estado
  if (!DESK) navigator.storage?.persist?.().catch(() => {}); // que el navegador no los borre si falta espacio
  // Estadísticas solo de proveedores que existen y modelos que siguen en su lista (la lista solo cambia con datos confirmados).
  for (const k of Object.keys(S.health)) {
    const [id, model] = k.split('::');
    const p = S.providers.find((x) => x.id === id);
    if (k.startsWith('mcp:') ? !S.mcp.some((x) => `mcp:${x.id}` === id) : !p || !p.models.includes(model)) delete S.health[k];
  }
  if (DESK) {
    // El puente integrado del PC aparece siempre como primer servidor MCP.
    const b = DESK.bridge();
    let s = S.mcp.find((x) => x.local);
    if (!s) S.mcp.unshift(s = { id: 'local', local: true, name: 'ESTE PC', models: [], tools: [] });
    Object.assign(s, { url: `http://127.0.0.1:${b.port}/mcp`, token: b.token });
    pushGatewaySoon();
  }
  applyLevel();
  renderTargets(); renderLog();
  if (S.vault && S.vault.data && crypto.subtle) await unlockDialog();
  // Abierta desde el QR de un PC: se conecta sola a ese puente.
  const p = parsePair(location.hash);
  if (p) { window.history.replaceState(null, '', location.pathname + location.search); pairWith(p); }
  save();
  renderTargets(); renderLog();
  S.mcp.forEach((s) => mcpConnect(s, true).catch(() => {}));
  setInterval(() => { if (document.visibilityState === 'visible') { syncAll(); renderTargets(); } }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncAll(); });
  if (!NATIVE && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
}
boot();
