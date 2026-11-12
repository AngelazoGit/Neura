'use strict';
// NEURA — todas las IAs públicas en un solo chat + puente MCP a IA local.
const $ = (s, r = document) => r.querySelector(s);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = 'neura.v1';
// Dentro de la app nativa (Capacitor) las peticiones salen por la red del móvil: sin CORS ni bloqueo http.
const NATIVE = !!window.Capacitor?.isNativePlatform?.();

// IAs públicas con API. Los nombres de modelo cambian: usa ESCANEAR para actualizarlos.
const PRESETS = {
  gemini:     { name: 'Google Gemini', kind: 'openai', tier: 'free', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], keyUrl: 'https://aistudio.google.com/apikey' },
  groq:       { name: 'Groq', kind: 'openai', tier: 'free', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'llama-3.1-8b-instant'], keyUrl: 'https://console.groq.com/keys' },
  openrouter: { name: 'OpenRouter', kind: 'openai', tier: 'free', baseUrl: 'https://openrouter.ai/api/v1', models: [], freeOnly: true, keyUrl: 'https://openrouter.ai/keys' },
  cerebras:   { name: 'Cerebras', kind: 'openai', tier: 'free', baseUrl: 'https://api.cerebras.ai/v1', models: ['llama-3.3-70b', 'gpt-oss-120b'], keyUrl: 'https://cloud.cerebras.ai' },
  mistral:    { name: 'Mistral', kind: 'openai', tier: 'free', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-small-latest', 'open-mistral-nemo'], keyUrl: 'https://console.mistral.ai/api-keys' },
  github:     { name: 'GitHub Models', kind: 'openai', tier: 'free', baseUrl: 'https://models.github.ai/inference', models: ['openai/gpt-4.1-mini', 'meta/Llama-3.3-70B-Instruct'], keyUrl: 'https://github.com/settings/tokens' },
  hf:         { name: 'Hugging Face', kind: 'openai', tier: 'free', baseUrl: 'https://router.huggingface.co/v1', models: ['meta-llama/Llama-3.3-70B-Instruct'], keyUrl: 'https://huggingface.co/settings/tokens' },
  cohere:     { name: 'Cohere', kind: 'openai', tier: 'free', baseUrl: 'https://api.cohere.ai/compatibility/v1', models: ['command-a-03-2025'], keyUrl: 'https://dashboard.cohere.com/api-keys' },
  anthropic:  { name: 'Anthropic Claude', kind: 'anthropic', tier: 'paid', baseUrl: 'https://api.anthropic.com/v1', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], keyUrl: 'https://console.anthropic.com/settings/keys' },
  openai:     { name: 'OpenAI', kind: 'openai', tier: 'paid', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4.1-mini'], keyUrl: 'https://platform.openai.com/api-keys' },
  deepseek:   { name: 'DeepSeek', kind: 'openai', tier: 'paid', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat'], keyUrl: 'https://platform.deepseek.com/api_keys' },
  custom:     { name: 'Otra (compatible OpenAI)', kind: 'openai', tier: 'other', baseUrl: '', models: [] },
};

// ---------- estado ----------
const S = Object.assign({ providers: [], mcp: [], messages: [], target: null, autoSkip: true }, load());
function load() { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } }
function save() {
  try { localStorage.setItem(LS, JSON.stringify({ ...S, mcp: S.mcp.map(({ sessionId, status, ...m }) => m) })); }
  catch (e) { toast('No se pudo guardar: ' + e.message, true); }
}
let busy = false, abortCtl = null, rpcId = 0;

function targets() {
  const t = [];
  for (const p of S.providers) if (p.enabled !== false) for (const m of p.models) t.push({ key: `${p.id}::${m}`, pid: p.id, model: m, label: `${p.name} / ${m}`, kind: p.kind });
  for (const s of S.mcp) for (const m of s.models || []) t.push({ key: `mcp:${s.id}::${m}`, sid: s.id, model: m, label: `⬡ ${s.name} / ${m}`, kind: 'mcp' });
  return t;
}
const findT = (k) => targets().find((t) => t.key === k);

// ---------- llamadas a IAs ----------
function httpErr(status, body) {
  let m = body;
  try { const j = JSON.parse(body); m = j.error?.message || j.message || j.error || body; } catch {}
  const e = new Error(String(typeof m === 'string' ? m : JSON.stringify(m)).slice(0, 300));
  e.status = status; return e;
}
function netHint(e) {
  if (e.name === 'AbortError') return 'Cancelado';
  if (e instanceof TypeError && /fetch|network|load/i.test(e.message)) return 'Sin conexión: servidor apagado, CORS bloqueado o contenido mixto (http desde https).';
  return e.message;
}

async function callOpenAI(p, model, messages, onDelta, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (p.apiKey) headers.Authorization = 'Bearer ' + p.apiKey;
  if (p.baseUrl.includes('openrouter.ai')) { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Neura'; }
  const r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST', headers, signal, body: JSON.stringify({ model, messages, stream: !NATIVE }),
  });
  if (!r.ok) throw httpErr(r.status, await r.text());
  if (!(r.headers.get('content-type') || '').includes('event-stream')) {
    const j = await r.json(); const txt = j.choices?.[0]?.message?.content ?? '';
    onDelta(txt); return txt;
  }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '', out = '';
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
      const c = j.choices?.[0]?.delta?.content;
      if (c) { out += c; onDelta(out); }
    }
  }
  return out;
}

async function callAnthropic(p, model, messages, onDelta, signal) {
  const r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/messages', {
    method: 'POST', signal, body: JSON.stringify({ model, max_tokens: 4096, messages }),
    headers: { 'content-type': 'application/json', 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
  });
  if (!r.ok) throw httpErr(r.status, await r.text());
  const j = await r.json();
  const txt = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  onDelta(txt); return txt;
}

async function callTarget(t, messages, onDelta, signal) {
  if (t.kind === 'mcp') {
    const s = S.mcp.find((x) => x.id === t.sid);
    if (!s) throw new Error('Servidor MCP eliminado');
    if (!s.sessionId) await mcpConnect(s, true);
    const r = await mcpRpc(s, 'tools/call', { name: 'chat', arguments: { model: t.model, messages } }, false, signal);
    const txt = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (r.isError) throw new Error(txt || 'Error MCP');
    onDelta(txt); return txt;
  }
  const p = S.providers.find((x) => x.id === t.pid);
  if (!p) throw new Error('IA eliminada');
  return (p.kind === 'anthropic' ? callAnthropic : callOpenAI)(p, t.model, messages, onDelta, signal);
}

async function fetchModels(p) {
  const headers = p.kind === 'anthropic'
    ? { 'x-api-key': p.apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
    : (p.apiKey ? { Authorization: 'Bearer ' + p.apiKey } : {});
  const r = await fetch(p.baseUrl.replace(/\/+$/, '') + '/models', { headers });
  if (!r.ok) throw httpErr(r.status, await r.text());
  const j = await r.json();
  let list = j.data || j.models || [];
  if (p.freeOnly) list = list.filter((m) => String(m.id).endsWith(':free') || (m.pricing && +m.pricing.prompt === 0 && +m.pricing.completion === 0));
  return list.map((m) => (typeof m === 'string' ? m : m.id || m.name).replace(/^models\//, '')).filter(Boolean);
}

// ---------- cliente MCP (Streamable HTTP) ----------
async function mcpRpc(s, method, params, notify = false, signal, retried = false) {
  const body = { jsonrpc: '2.0', method };
  if (params !== undefined) body.params = params;
  if (!notify) body.id = ++rpcId;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (s.token) headers.Authorization = 'Bearer ' + s.token;
  if (s.sessionId) headers['Mcp-Session-Id'] = s.sessionId;
  if (s.protocolVersion) headers['MCP-Protocol-Version'] = s.protocolVersion;
  const r = await fetch(s.url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const sid = r.headers.get('Mcp-Session-Id'); if (sid) s.sessionId = sid;
  if (r.status === 404 && s.sessionId && !retried && method !== 'initialize') {
    await mcpConnect(s, true); return mcpRpc(s, method, params, notify, signal, true);
  }
  if (notify) return;
  if (!r.ok) throw httpErr(r.status, await r.text());
  let msg;
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of (await r.text()).split('\n')) {
      if (!line.startsWith('data:')) continue;
      try { const j = JSON.parse(line.slice(5)); if (j.id === body.id) msg = j; } catch {}
    }
  } else msg = await r.json();
  if (!msg) throw new Error('Respuesta MCP vacía');
  if (msg.error) throw new Error(msg.error.message || 'Error MCP');
  return msg.result;
}

async function mcpConnect(s, quiet) {
  s.status = 'wait'; s.sessionId = null; s.protocolVersion = null; renderMcp();
  try {
    const init = await mcpRpc(s, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'neura-app', version: '1.0.0' } });
    s.protocolVersion = init.protocolVersion; s.serverInfo = init.serverInfo;
    await mcpRpc(s, 'notifications/initialized', undefined, true);
    const tl = await mcpRpc(s, 'tools/list', {});
    s.tools = (tl.tools || []).map((t) => ({ name: t.name, description: t.description }));
    s.models = []; s.backends = [];
    if (s.tools.some((t) => t.name === 'list_models') && s.tools.some((t) => t.name === 'chat')) {
      const r = await mcpRpc(s, 'tools/call', { name: 'list_models', arguments: {} });
      let data = r.structuredContent;
      if (!data) try { data = JSON.parse(r.content?.[0]?.text || '{}'); } catch { data = {}; }
      s.models = (data.models || []).map((m) => (typeof m === 'string' ? m : m.id));
      s.backends = data.backends || [];
    }
    s.status = 'on'; s.error = null;
    if (!quiet) toast(`${s.name}: CONECTADO · ${s.models.length} modelos`);
  } catch (e) {
    s.status = 'err'; s.error = netHint(e);
    if (!quiet) toast(`${s.name}: ${s.error}`, true);
    if (quiet) { save(); renderMcp(); throw e; }
  }
  save(); renderMcp(); renderTargets();
}

// ---------- envío ----------
function history() {
  const h = [];
  for (const m of S.messages) {
    if (m.role === 'user') h.push({ role: 'user', content: m.content });
    else if (m.content && !m.error) h.push({ role: 'assistant', content: m.content });
  }
  return h;
}
// Errores que merecen probar otra IA: cuota agotada, sobrecarga, sin conexión, clave inválida.
const skippable = (e) => e.name !== 'AbortError' && (!e.status || e.status === 429 || e.status >= 500 || e.status === 401 || e.status === 403 || e.status === 402);

async function send(text) {
  const hist = history();
  hist.push({ role: 'user', content: text });
  S.messages.push({ role: 'user', content: text, ts: Date.now() });
  const all = targets();
  const first = findT(S.target);
  const queue = first ? [first, ...(S.autoSkip ? all.filter((t) => t.key !== first.key) : [])] : [];
  setBusy(true);
  if (!queue.length) {
    S.messages.push({ role: 'assistant', error: 'No hay IAs conectadas. Añade una en ⚙ o conecta un servidor en ⬡.', ts: Date.now() });
  }
  for (const t of queue) {
    const msg = { id: uid(), role: 'assistant', label: t.label, content: '', pending: true, ts: Date.now() };
    S.messages.push(msg); renderLog();
    try {
      msg.content = (await callTarget(t, hist, (x) => { msg.content = x; schedule(msg); }, abortCtl.signal)) || msg.content || '(respuesta vacía)';
      msg.pending = false; break;
    } catch (e) {
      msg.pending = false; msg.content = '';
      msg.error = (e.status ? `[${e.status}] ` : '') + netHint(e);
      msg.skipped = S.autoSkip && skippable(e) && t !== queue[queue.length - 1];
      if (!msg.skipped) break;
    }
  }
  setBusy(false); save(); renderLog();
}

function setBusy(b) {
  busy = b;
  abortCtl = b ? new AbortController() : null;
  const btn = $('#send');
  btn.classList.toggle('abort', b);
  btn.firstElementChild.textContent = b ? 'PARAR' : 'ENVIAR';
}

// ---------- render ----------
function md(s) {
  return String(s).split('```').map((seg, i) => {
    if (i % 2) { const nl = seg.indexOf('\n'); return `<pre><code>${esc(nl >= 0 ? seg.slice(nl + 1) : seg)}</code></pre>`; }
    return esc(seg)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/^#{1,6} (.*)$/gm, '<b class="h">$1</b>')
      .replace(/\n/g, '<br>');
  }).join('');
}
const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function msgHTML(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="tag">▶ TÚ // ${hhmm(m.ts)}</div><div class="body">${esc(m.content)}</div></div>`;
  if (m.error) return `<div class="msg"><div class="reply err ${m.skipped ? 'skip' : ''}"><div class="tag"><span>✕ ${esc(m.label || 'NEURA')}${m.skipped ? ' → SALTANDO A OTRA IA' : ''}</span></div><div class="txt">${esc(m.error)}</div></div></div>`;
  return `<div class="msg"><div class="reply ${m.pending ? 'pending' : ''}" data-id="${m.id}"><div class="tag"><span>${esc(m.label)}</span>${m.pending ? '<span class="processing">PROCESANDO</span>' : `<button data-copy="${m.id}">COPIAR</button>`}</div><div class="txt">${md(m.content)}</div></div></div>`;
}

function renderLog() {
  const log = $('#log');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  if (!S.messages.length) {
    const n = targets().length;
    log.innerHTML = `<div class="empty">
      <svg viewBox="0 0 40 46" class="biglogo" aria-hidden="true">${$('.logo').innerHTML}</svg>
      <div class="big">NEURA</div><div class="sub">ESPERANDO ENTRADA</div>
      <ol><li>${n ? `<b>${n} modelos</b> conectados.` : 'Pulsa <b>⚙</b> y añade IAs públicas con su clave gratuita (Gemini, Groq, OpenRouter…).'}</li>
      <li>Pulsa <b>⬡</b> para conectar tu IA local mediante un servidor MCP.</li>
      <li><b>AUTO-SALTO</b>: si una IA agota sus tokens gratis, contesta otra.</li></ol></div>`;
    return;
  }
  log.innerHTML = S.messages.map(msgHTML).join('');
  if (stick) log.scrollTop = log.scrollHeight;
}

const pend = new Set();
function schedule(m) {
  if (pend.has(m)) return;
  pend.add(m);
  requestAnimationFrame(() => {
    pend.delete(m);
    const el = document.querySelector(`.reply[data-id="${m.id}"] .txt`);
    if (!el) return renderLog();
    const log = $('#log'); const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    el.innerHTML = md(m.content);
    if (stick) log.scrollTop = log.scrollHeight;
  });
}

function renderTargets() {
  const all = targets();
  if (!all.some((t) => t.key === S.target)) S.target = all[0]?.key || null;
  const sel = $('#target');
  sel.innerHTML = all.length ? all.map((t) => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('') : '<option value="">— SIN IAs CONECTADAS —</option>';
  sel.value = S.target || '';
  $('#autoSkip').checked = S.autoSkip;
  $('#syncTxt').textContent = `${all.length} IA`;
  $('#syncDot').classList.toggle('on', all.length > 0);
}

const tierBadge = (t) => t === 'free' ? '<span class="badge free">GRATIS</span>' : t === 'paid' ? '<span class="badge paid">PAGO</span>' : '<span class="badge local">OTRA</span>';

function renderProviders() {
  $('#provList').innerHTML = S.providers.map((p) => `
    <div class="card ${p.enabled === false ? 'off' : ''}" data-pid="${p.id}">
      <div class="head"><input data-f="name" value="${esc(p.name)}">${tierBadge(p.tier)}
        <button class="btn sm ghost" data-act="toggle">${p.enabled === false ? 'ACTIVAR' : 'PAUSAR'}</button>
        <button class="btn sm red" data-act="del">✕</button></div>
      <label>ENDPOINT<input data-f="baseUrl" value="${esc(p.baseUrl)}" placeholder="https://…/v1"></label>
      <label>CLAVE API<input data-f="apiKey" type="password" autocomplete="off" value="${esc(p.apiKey || '')}" placeholder="pega tu clave"></label>
      ${p.keyUrl ? `<a href="${esc(p.keyUrl)}" target="_blank" rel="noopener">▸ conseguir clave${p.tier === 'free' ? ' gratuita' : ''}</a>` : ''}
      <label>MODELOS (separados por coma)<input data-f="models" value="${esc(p.models.join(', '))}"></label>
      <div class="row"><button class="btn sm" data-act="scan">ESCANEAR MODELOS</button><button class="btn sm ghost" data-act="test">PROBAR</button></div>
    </div>`).join('') || '<p class="hint">Todavía no hay IAs. Elige una arriba y pulsa + AÑADIR.</p>';
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
      ${(s.tools || []).length ? `<div class="chips">${s.tools.map((t) => `<span class="chip tool" title="${esc(t.description || '')}">ƒ ${esc(t.name)}</span>`).join('')}</div>` : ''}
      <div class="row"><button class="btn sm" data-act="reconnect">RECONECTAR</button><button class="btn sm red" data-act="del">ELIMINAR</button></div>
    </div>`;
  }).join('');
}

let toastT;
function toast(m, err) {
  const t = $('#toast'); t.textContent = m; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT); toastT = setTimeout(() => (t.className = ''), 3800);
}

// ---------- eventos ----------
function openSheet(id) { closeSheets(); const s = $(id); s.classList.add('open'); s.setAttribute('aria-hidden', 'false'); }
function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => { s.classList.remove('open'); s.setAttribute('aria-hidden', 'true'); }); }
$('#btnAis').onclick = () => { renderProviders(); openSheet('#sheetAis'); };
$('#btnMcp').onclick = () => { renderMcp(); openSheet('#sheetMcp'); };
$('#btnClear').onclick = () => {
  if (busy || !S.messages.length || !confirm('¿Vaciar el chat?')) return;
  S.messages = []; save(); renderLog();
};
document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('.close')) closeSheets(); }));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheets(); });

$('#target').onchange = (e) => { S.target = e.target.value; save(); };
$('#autoSkip').onchange = (e) => { S.autoSkip = e.target.checked; save(); };

const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && matchMedia('(pointer:fine)').matches) { e.preventDefault(); $('#send').click(); }
});
$('#composer').onsubmit = (e) => {
  e.preventDefault();
  if (busy) { abortCtl?.abort(); return; }
  const text = input.value.trim(); if (!text) return;
  input.value = ''; input.style.height = 'auto';
  send(text);
};
$('#log').addEventListener('click', (e) => {
  const id = e.target.dataset?.copy; if (!id) return;
  const m = S.messages.find((x) => x.id === id);
  navigator.clipboard?.writeText(m?.content || '').then(() => toast('COPIADO'), () => toast('No se pudo copiar', true));
});

// IAs
$('#presetSel').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${p.name}${p.tier === 'free' ? ' — GRATIS' : p.tier === 'paid' ? ' — PAGO' : ''}</option>`).join('');
$('#addProv').onclick = () => {
  const k = $('#presetSel').value;
  S.providers.push({ id: uid(), preset: k, ...JSON.parse(JSON.stringify(PRESETS[k])), apiKey: '', enabled: true });
  save(); renderProviders(); renderTargets(); renderLog();
};
$('#provList').addEventListener('change', (e) => {
  const card = e.target.closest('[data-pid]'), f = e.target.dataset.f; if (!card || !f) return;
  const p = S.providers.find((x) => x.id === card.dataset.pid);
  p[f] = f === 'models' ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value.trim();
  save(); renderTargets();
});
$('#provList').addEventListener('click', async (e) => {
  const act = e.target.dataset.act, card = e.target.closest('[data-pid]'); if (!act || !card) return;
  const p = S.providers.find((x) => x.id === card.dataset.pid);
  if (act === 'del') { if (!confirm(`¿Eliminar ${p.name}?`)) return; S.providers = S.providers.filter((x) => x !== p); }
  if (act === 'toggle') p.enabled = p.enabled === false;
  if (act === 'scan') {
    e.target.textContent = 'ESCANEANDO…';
    try { const m = await fetchModels(p); if (!m.length) throw new Error('No se encontraron modelos'); p.models = m; toast(`${p.name}: ${m.length} modelos`); }
    catch (err) { toast(`${p.name}: ${netHint(err)}`, true); }
  }
  if (act === 'test') {
    if (!p.models[0]) return toast('Sin modelos', true);
    e.target.textContent = 'PROBANDO…';
    try { const t0 = performance.now(); const r = await callTarget({ pid: p.id, model: p.models[0], kind: p.kind }, [{ role: 'user', content: 'Responde solo: OK' }], () => {}); toast(`${p.models[0]} → "${r.trim().slice(0, 40)}" · ${Math.round(performance.now() - t0)} ms`); }
    catch (err) { toast(`${p.name}: ${err.status ? `[${err.status}] ` : ''}${netHint(err)}`, true); }
  }
  save(); renderProviders(); renderTargets(); renderLog();
});

// MCP
$('#mcpForm').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  let url = String(f.get('url')).trim();
  if (new URL(url).pathname === '/') url = url.replace(/\/+$/, '') + '/mcp'; // http://ip:8787 → /mcp
  const s = { id: uid(), name: String(f.get('name')).trim().toUpperCase(), url, token: String(f.get('token')).trim(), models: [], tools: [] };
  S.mcp.push(s); e.target.reset(); save(); mcpConnect(s);
};
$('#mcpList').addEventListener('click', (e) => {
  const act = e.target.dataset.act, card = e.target.closest('[data-sid]'); if (!act || !card) return;
  const s = S.mcp.find((x) => x.id === card.dataset.sid);
  if (act === 'reconnect') mcpConnect(s);
  if (act === 'del') { S.mcp = S.mcp.filter((x) => x !== s); save(); renderMcp(); renderTargets(); renderLog(); }
});

// ---------- arranque ----------
S.messages.forEach((m) => { if (m.pending) { m.pending = false; m.error = m.error || 'Interrumpido'; } });
renderTargets(); renderLog();
S.mcp.forEach((s) => mcpConnect(s, true).catch(() => {}));
if (!NATIVE && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
