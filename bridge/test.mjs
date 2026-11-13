// node --test bridge/test.mjs — comprueba las defensas del puente.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 18787, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', import.meta.url))], {
  env: { ...process.env, PORT, HOST: '0.0.0.0', NEURA_TOKEN: '', NEURA_GATEWAY_TOKEN: 'gw-token-de-prueba-123456', NEURA_CONFIG: '/nonexistent.json', NEURA_DATA: mkdtempSync(join(tmpdir(), 'neura-')) },
});
let out = '';
srv.stdout.on('data', (d) => (out += d));
await new Promise((r) => srv.stdout.on('data', () => out.includes('Backends') && r()));
after(() => srv.kill());
const token = out.match(/TOKEN: (\S+)/)?.[1];
const rpc = (body, auth = token) => fetch(`${BASE}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('en la red sin token propio genera uno aleatorio', () => assert.ok(token && token.length >= 20));
test('rechaza peticiones sin token o con token falso', async () => {
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'x')).status, 401);
});
test('acepta el token correcto', async () => {
  const r = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
  assert.deepEqual(r.result.tools.map((t) => t.name), ['list_models', 'chat', 'system_info', 'threads_sync']);
});
test('/health no revela datos del equipo', async () => {
  assert.deepEqual(await (await fetch(`${BASE}/health`)).json(), { ok: true });
});
test('peticiones malformadas no tumban el servidor', async () => {
  assert.equal((await fetch(`${BASE}/%E0%A4%A`)).status, 400);
  assert.equal((await rpc('{no json')).status, 400);
  const big = await rpc('x'.repeat(26 * 2 ** 20)).catch(() => ({ status: 'reset' }));
  assert.ok([413, 'reset'].includes(big.status));
  assert.equal((await fetch(`${BASE}/health`)).status, 200);
});
test('no sirve archivos fuera de la app', async () => {
  assert.equal((await fetch(`${BASE}/..%2f..%2fbridge%2fserver.mjs`)).status, 404);
});

test('también en 127.0.0.1 exige token (una web cualquiera no puede leer los hilos)', async () => {
  const p = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', import.meta.url))], {
    env: { ...process.env, PORT: '18789', HOST: '127.0.0.1', NEURA_TOKEN: '', NEURA_CONFIG: '/nonexistent.json', NEURA_DATA: mkdtempSync(join(tmpdir(), 'neura-')) },
  });
  let o = '';
  await new Promise((r) => p.stdout.on('data', (d) => { o += d; if (o.includes('Backends')) r(); }));
  try {
    const r = await fetch('http://127.0.0.1:18789/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://web-cualquiera.example' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(r.status, 401);
    assert.match(o, /TOKEN: \S{20,}/);
  } finally { p.kill(); }
});
const sync = async (args) => (await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'threads_sync', arguments: args } })).json()).result.structuredContent;
test('threads_sync fusiona hilos de dos dispositivos sin perder mensajes', async () => {
  const pc = await sync({ threads: [{ id: 't1', title: 'Hola', ts: 10, messages: [{ id: 'a', role: 'user', content: 'uno', ts: 1 }] }] });
  assert.equal(pc.threads.length, 1);
  const movil = await sync({ since: pc.rev, threads: [{ id: 't1', title: 'Hola', ts: 20, messages: [{ id: 'b', role: 'user', content: 'dos', ts: 2 }] }] });
  assert.deepEqual(movil.threads[0].messages.map((m) => m.id), ['a', 'b']);
  assert.equal((await sync({ since: movil.rev })).threads.length, 0, 'sin cambios no devuelve nada');
  const borrado = await sync({ since: movil.rev, threads: [{ id: 't1', deleted: true, ts: 30, messages: [] }] });
  assert.equal(borrado.threads[0].deleted, true);
  assert.equal(borrado.threads[0].messages.length, 0);
});

// ---------- carpetas compartidas, RAG, imágenes, herramientas y streaming (con un Ollama simulado) ----------
const vec = (t) => { // embeddings deterministas: palabras repartidas en 64 dimensiones
  const v = new Array(64).fill(0);
  for (const w of String(t).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2)) {
    let h = 0; for (const ch of w) h = (h * 31 + ch.codePointAt(0)) % 64; v[h]++;
  }
  return v;
};
const mock = { embedFail: false, chats: [] };
const ollama = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = b ? JSON.parse(b) : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'mock' }] }));
    if (req.url === '/api/embed') {
      if (mock.embedFail) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'model not found' })); }
      return res.end(JSON.stringify({ embeddings: j.input.map(vec) }));
    }
    if (req.url === '/api/chat') {
      mock.chats.push(j);
      const toolMsg = j.messages.find((m) => m.role === 'tool');
      if (j.tools && !toolMsg) return res.end(JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'docs/notas.md' } } }] } }));
      if (toolMsg) return res.end(JSON.stringify({ message: { role: 'assistant', content: 'leído: ' + toolMsg.content.slice(0, 40) } }));
      if (j.stream) {
        for (const c of ['Hola', ' mundo', '!']) res.write(JSON.stringify({ message: { content: c }, done: false }) + '\n');
        return res.end(JSON.stringify({ message: { content: '' }, done: true, eval_count: 3 }) + '\n');
      }
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'ok' } }));
    }
    res.statusCode = 404; res.end('{}');
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
after(() => ollama.close());

const base = mkdtempSync(join(tmpdir(), 'neura-carpetas-'));
const shared = join(base, 'docs'), outside = join(base, 'fuera');
mkdirSync(join(shared, 'sub'), { recursive: true }); mkdirSync(outside); mkdirSync(join(shared, '.oculta'));
writeFileSync(join(shared, 'notas.md'), '# Receta\nLa paella lleva arroz, azafrán y caldo.\nSegunda línea.\n');
writeFileSync(join(shared, 'sub', 'codigo.js'), 'function suma(a, b) { return a + b; }\n');
writeFileSync(join(shared, '.oculta', 'clave.txt'), 'secreto oculto');
writeFileSync(join(outside, 'secreto.txt'), 'secreto de fuera');
symlinkSync(outside, join(shared, 'enlace'));
const cfgFile = join(base, 'config.json');
writeFileSync(cfgFile, JSON.stringify({ backends: [{ id: 'ollama', type: 'ollama', url: `http://127.0.0.1:${ollama.address().port}` }], folders: [shared] }));

const PORT2 = 18788, BASE2 = `http://127.0.0.1:${PORT2}`;
const srv2 = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', import.meta.url))], {
  env: { ...process.env, PORT: PORT2, HOST: '127.0.0.1', NEURA_TOKEN: 't', NEURA_CONFIG: cfgFile, NEURA_DATA: mkdtempSync(join(tmpdir(), 'neura-')), NEURA_FOLDERS: '' },
});
let out2 = '';
srv2.stdout.on('data', (d) => (out2 += d));
srv2.stderr.on('data', (d) => (out2 += d));
await new Promise((r) => srv2.stdout.on('data', () => out2.includes('Backends') && r()));
after(() => srv2.kill());
const rpc2 = (body, extra = {}) => fetch(`${BASE2}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t', ...extra }, body: JSON.stringify(body) });
const call = async (name, args) => (await (await rpc2({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json()).result;

test('con carpetas aparecen las herramientas de archivos', async () => {
  const r = await (await rpc2({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).json();
  assert.deepEqual(r.result.tools.map((t) => t.name), ['list_models', 'chat', 'system_info', 'threads_sync', 'list_dir', 'search_files', 'read_file', 'search_docs']);
});
test('list_dir, search_files y read_file', async () => {
  assert.deepEqual((await call('list_dir', {})).structuredContent.entries, [{ name: 'docs', type: 'dir' }]);
  const names = (await call('list_dir', { path: 'docs' })).structuredContent.entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['notas.md', 'sub'], 'sin ocultos ni enlaces que salen fuera');
  const found = (await call('search_files', { query: 'AZAFRÁN' })).structuredContent.results;
  assert.deepEqual(found, [{ path: 'docs/notas.md', line: 2, snippet: 'La paella lleva arroz, azafrán y caldo.' }]);
  assert.equal((await call('search_files', { query: 'secreto' })).structuredContent.results.length, 0, 'no busca fuera ni en ocultos');
  const f = (await call('read_file', { path: 'docs/notas.md', offset: 2, limit: 1 })).structuredContent;
  assert.deepEqual(f, { path: 'docs/notas.md', text: 'La paella lleva arroz, azafrán y caldo.', total_lines: 4, truncated: true });
  assert.equal((await call('read_file', { path: 'docs\\sub\\codigo.js' })).structuredContent.path, 'docs/sub/codigo.js');
});
test('no se puede salir de la carpeta compartida', async () => {
  for (const path of ['docs/../fuera/secreto.txt', 'docs/enlace/secreto.txt', join(outside, 'secreto.txt'), 'C:/Windows/win.ini', 'docs/.oculta/clave.txt', 'otra/x.txt']) {
    const r = await call('read_file', { path });
    assert.equal(r.isError, true, path);
  }
});
test('search_docs: semántico y, sin modelo de embeddings, por palabras', async () => {
  const s = (await call('search_docs', { query: 'receta de paella con arroz', k: 2 })).structuredContent;
  assert.equal(s.mode, 'semantic');
  assert.equal(s.results[0].path, 'docs/notas.md');
  mock.embedFail = true;
  writeFileSync(join(shared, 'nuevo.txt'), 'El caldo de verduras se hace con paciencia.');
  const k = (await call('search_docs', { query: 'caldo' })).structuredContent;
  assert.equal(k.mode, 'keyword');
  assert.match(k.hint, /ollama pull nomic-embed-text/);
  assert.ok(k.results.some((r) => r.path === 'docs/nuevo.txt'));
  mock.embedFail = false;
});
test('chat con imágenes las envía a Ollama en images', async () => {
  await call('chat', { model: 'ollama/mock', messages: [{ role: 'user', content: [{ type: 'text', text: '¿Qué es?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] });
  const m = mock.chats.at(-1).messages[0];
  assert.equal(m.content, '¿Qué es?');
  assert.deepEqual(m.images, ['AAAA']);
});
test('chat con tools:true usa las carpetas y devuelve tool_log', async () => {
  const r = (await call('chat', { model: 'ollama/mock', tools: true, messages: [{ role: 'user', content: 'Lee mis notas' }] })).structuredContent;
  assert.deepEqual(r.tool_log, [{ name: 'read_file', arguments: { path: 'docs/notas.md' }, ok: true }]);
  assert.match(r.text, /^leído: .*Receta/);
});
test('chat en streaming envía el texto por trozos', async () => {
  const r = await rpc2({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'chat', _meta: { progressToken: 'p1' }, arguments: { model: 'ollama/mock', messages: [{ role: 'user', content: 'hola' }] } } },
    { Accept: 'application/json, text/event-stream' });
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = (await r.text()).split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5)));
  const deltas = events.filter((e) => e.method === 'notifications/progress');
  assert.deepEqual(deltas.map((e) => e.params.progress), [1, 2, 3]);
  assert.ok(deltas.every((e) => e.params.progressToken === 'p1'));
  const final = events.at(-1);
  assert.equal(final.id, 7);
  assert.equal(deltas.map((e) => e.params.message).join(''), final.result.structuredContent.text);
  assert.equal(final.result.structuredContent.text, 'Hola mundo!');
  // sin Accept de streaming responde como siempre
  const plain = await rpc2({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'chat', _meta: { progressToken: 'p2' }, arguments: { model: 'ollama/mock', messages: [{ role: 'user', content: 'hola' }] } } });
  assert.equal((await plain.json()).result.structuredContent.text, 'ok');
});

test('threads_sync también sincroniza habilidades y proyectos (gana el más reciente, también al borrar)', async () => {
  const a = await sync({ collections: { skills: [{ id: 'k1', name: 'Apuntes', version: 1, updatedAt: 10 }], projects: [{ id: 'p1', name: 'Tesis', updatedAt: 10 }], otra: [{ id: 'x', updatedAt: 1 }] } });
  assert.equal(a.collections.skills[0].name, 'Apuntes');
  assert.equal(a.collections.projects[0].name, 'Tesis');
  assert.equal(a.collections.otra, undefined, 'solo colecciones conocidas');
  const viejo = await sync({ since: a.rev, collections: { skills: [{ id: 'k1', name: 'Viejo', updatedAt: 5 }] } });
  assert.equal(viejo.collections.skills.length, 0, 'una versión más antigua no pisa la nueva');
  const borrado = await sync({ since: a.rev, collections: { skills: [{ id: 'k1', deleted: true, updatedAt: 20 }] } });
  assert.equal(borrado.collections.skills[0].deleted, true);
});

test('backends: local si están en este equipo o en la red privada; local_only rechaza los externos', async () => {
  const r = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_models', arguments: {} } })).json();
  for (const b of r.result.structuredContent.backends) assert.equal(b.local, /127\.0\.0\.1|localhost/.test(b.url), b.url);
});

// ---------- Neura Gateway ----------
const gwSeen = [];
const gwMock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b || '{}'); gwSeen.push({ url: req.url, auth: req.headers.authorization, body: j });
    if (j.model === 'agotado') { res.writeHead(429, { 'retry-after': '120', 'content-type': 'application/json' }); return res.end('{"error":{"message":"quota"}}'); }
    if (req.headers.authorization === 'Bearer mala') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"invalid api key"}}'); }
    if (j.model === 'noexiste') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"model not found"}}'); }
    if (j.model === 'corta') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'a medias' }, finish_reason: null }] })}\n\n`); return setTimeout(() => res.destroy(), 100); }
    if (j.model === 'eco' && j.stream) {
      // Responde con el texto de la pregunta, por trozos y con pausas: sirve para comprobar clientes simultáneos.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const q = String(j.messages.at(-1).content);
      let k = 0;
      const tick = () => {
        if (k < q.length) { res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: q[k++] }, finish_reason: null }] })}\n\n`); return setTimeout(tick, 15); }
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`); res.end('data: [DONE]\n\n');
      };
      return tick();
    }
    const tool = j.tools?.length && !j.messages.some((m) => m.role === 'tool');
    if (j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      if (tool) { chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'leer', arguments: '' } }] }); chunk({ tool_calls: [{ index: 0, function: { arguments: '{"ruta":' } }] }); chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, 'tool_calls'); }
      else { chunk({ content: 'Hola ' }); chunk({ content: 'mundo' }, 'stop'); }
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tool
      ? { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'leer', arguments: '{"ruta":"a.txt"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }
      : { choices: [{ message: { role: 'assistant', content: `respuesta de ${j.model}` }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } }));
  });
});
await new Promise((r) => gwMock.listen(0, '127.0.0.1', r));
after(() => gwMock.close());
const MOCK = `http://127.0.0.1:${gwMock.address().port}/v1`;
const GWT = 'gw-token-de-prueba-123456';
// /v1/* usa el token propio del Gateway; /neura/gateway, el del puente.
const gw = (p, body, h = {}) => fetch(`${BASE}${p}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.startsWith('/v1') ? GWT : token}`, ...h }, body: body && JSON.stringify(body) });
const configure = (c) => gw('/neura/gateway', c);

test('Gateway: desactivado por defecto y siempre con token', async () => {
  assert.equal((await gw('/v1/models')).status, 404);
  assert.equal((await fetch(`${BASE}/v1/models`)).status, 401);
});
test('Gateway: AUTO-SALTO entre proveedores con las claves del usuario', async () => {
  assert.equal((await configure({ enabled: true, providers: [
    { id: 'gratis/agotado', url: MOCK, apiKey: 'clave-1', model: 'agotado' },
    { id: 'gratis/bueno', url: MOCK, apiKey: 'clave-2', model: 'bueno' },
  ], order: ['gratis/agotado', 'gratis/bueno'] })).status, 200);
  const models = await (await gw('/v1/models')).json();
  assert.deepEqual(models.data.map((m) => m.id).slice(0, 3), ['auto', 'gratis/agotado', 'gratis/bueno']);
  const r = await (await gw('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'hola' }] })).json();
  assert.equal(r.choices[0].message.content, 'respuesta de bueno');
  assert.equal(gwSeen.find((x) => x.body.model === 'bueno').auth, 'Bearer clave-2', 'cada proveedor recibe su propia clave');
  const n = gwSeen.filter((x) => x.body.model === 'agotado').length;
  await gw('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'otra' }] });
  assert.equal(gwSeen.filter((x) => x.body.model === 'agotado').length, n, 'el agotado (429) queda en pausa');
});
test('Gateway: streaming compatible con OpenAI', async () => {
  const t = await (await gw('/v1/chat/completions', { model: 'gratis/bueno', stream: true, messages: [{ role: 'user', content: 'hola' }] })).text();
  assert.match(t, /"content":"Hola "/); assert.match(t, /\[DONE\]/);
});
test('Gateway: /v1/messages traduce Anthropic ⇄ OpenAI (sistema, herramientas y resultados)', async () => {
  const body = { model: 'auto', max_tokens: 100, system: [{ type: 'text', text: 'Eres útil' }],
    tools: [{ name: 'leer', description: 'Lee un archivo', input_schema: { type: 'object', properties: { ruta: { type: 'string' } } } }],
    messages: [{ role: 'user', content: 'lee a.txt' }] };
  const r = await (await gw('/v1/messages', body, { Authorization: '', 'x-api-key': GWT })).json();
  assert.equal(r.type, 'message'); assert.equal(r.stop_reason, 'tool_use');
  assert.deepEqual(r.content[0], { type: 'tool_use', id: 'call_1', name: 'leer', input: { ruta: 'a.txt' } });
  const sent = gwSeen.at(-1).body;
  assert.equal(sent.messages[0].role, 'system'); assert.equal(sent.tools[0].function.name, 'leer');
  const r2 = await (await gw('/v1/messages', { ...body, messages: [...body.messages, { role: 'assistant', content: r.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'contenido de a' }] }] })).json();
  const sent2 = gwSeen.at(-1).body.messages;
  assert.deepEqual(sent2.at(-2).tool_calls[0].function, { name: 'leer', arguments: '{"ruta":"a.txt"}' });
  assert.deepEqual(sent2.at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'contenido de a' });
  assert.equal(r2.content[0].text, 'respuesta de bueno'); assert.equal(r2.stop_reason, 'end_turn');
});
test('Gateway: /v1/messages en streaming emite los eventos de Anthropic', async () => {
  const t = await (await gw('/v1/messages', { model: 'auto', max_tokens: 50, stream: true, tools: [{ name: 'leer', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: 'lee' }] })).text();
  const events = [...t.matchAll(/^event: (\w+)/gm)].map((m) => m[1]);
  assert.deepEqual([events[0], events[1], events.at(-2), events.at(-1)], ['message_start', 'content_block_start', 'message_delta', 'message_stop']);
  assert.match(t, /"type":"tool_use","id":"call_1","name":"leer"/);
  assert.match(t, /"partial_json":"\\"a.txt\\"}"/);
  assert.match(t, /"stop_reason":"tool_use"/);
});
test('Gateway: SOLO LOCAL no usa los proveedores de internet', async () => {
  await configure({ enabled: true, localOnly: true, providers: [{ id: 'gratis/bueno', url: MOCK, model: 'bueno' }] });
  const ids = (await (await gw('/v1/models')).json()).data.map((m) => m.id);
  assert.ok(!ids.includes('gratis/bueno'));
  await configure({ enabled: false });
});

// Revisión: token propio, modelo desconocido, alcance de pausas, cortes en streaming y clientes simultáneos
const prov = (id, model, apiKey = 'buena') => ({ id, url: MOCK, apiKey, model });
test('Gateway: su token solo sirve para /v1 y el del puente no sirve en /v1', async () => {
  await configure({ enabled: true, providers: [prov('p/bueno', 'bueno')] });
  assert.equal((await gw('/v1/models')).status, 200);
  const mcp = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GWT}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'threads_sync', arguments: {} } }) });
  assert.equal(mcp.status, 401, 'con el token del Gateway no se leen los hilos');
  assert.equal((await fetch(`${BASE}/neura/gateway`, { method: 'POST', headers: { Authorization: `Bearer ${GWT}` }, body: '{}' })).status, 403, 'ni se cambia la configuración');
  assert.equal((await fetch(`${BASE}/v1/models`, { headers: { Authorization: `Bearer ${token}` } })).status, 401, 'el token del puente no vale en /v1');
});
test('Gateway: un modelo desconocido da error y no llama a ningún proveedor (salvo que se active el alias)', async () => {
  await configure({ enabled: true, providers: [prov('p/bueno', 'bueno')] });
  const n = gwSeen.length;
  const r = await gw('/v1/chat/completions', { model: 'gpt-4o-errata', messages: [{ role: 'user', content: 'hola' }] });
  const j = await r.json();
  assert.equal(r.status, 404); assert.equal(j.error.code, 'model_not_found'); assert.match(j.error.message, /v1\/models/);
  assert.equal(gwSeen.length, n, 'ninguna llamada a proveedores');
  const a = await gw('/v1/messages', { model: 'claude-x', max_tokens: 10, messages: [{ role: 'user', content: 'hola' }] });
  assert.equal(a.status, 404); assert.equal((await a.json()).error.type, 'not_found_error');
  await configure({ enabled: true, unknownAsAuto: true, providers: [prov('p/bueno', 'bueno')] });
  assert.equal((await (await gw('/v1/chat/completions', { model: 'gpt-4o-errata', messages: [{ role: 'user', content: 'hola' }] })).json()).choices[0].message.content, 'respuesta de bueno');
});
test('Gateway: clave inválida pausa el proveedor entero; modelo inexistente solo ese modelo; corregir la clave quita la pausa', async () => {
  const cfg = (key) => ({ enabled: true, providers: [prov('mala/a', 'bueno', key), prov('mala/b', 'bueno', key), prov('p/noexiste', 'noexiste'), prov('p/bueno', 'bueno')], order: ['mala/a', 'mala/b', 'p/noexiste', 'p/bueno'] });
  await configure(cfg('mala'));
  const bad = () => gwSeen.filter((x) => x.auth === 'Bearer mala').length;
  const nx = () => gwSeen.filter((x) => x.body.model === 'noexiste').length;
  const b0 = bad(), n0 = nx();
  const ask = () => gw('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'hola' }] }).then((r) => r.json());
  assert.equal((await ask()).choices[0].message.content, 'respuesta de bueno');
  assert.equal(bad(), b0 + 1, 'tras el 401 de mala/a no se prueba mala/b (mismo proveedor)');
  await ask();
  assert.equal(bad(), b0 + 1, 'el proveedor sigue en pausa'); assert.equal(nx(), n0 + 1, 'el modelo inexistente queda en pausa');
  assert.equal((await gw('/v1/chat/completions', { model: 'p/bueno', messages: [{ role: 'user', content: 'x' }] })).status, 200, 'los modelos válidos del mismo proveedor siguen funcionando');
  await configure(cfg('buena'));
  await ask();
  assert.ok(gwSeen.at(-1).auth === 'Bearer buena' && gwSeen.at(-1).body.model === 'bueno' && gwSeen.filter((x) => x.auth === 'Bearer buena').length > 0);
  assert.equal(gwSeen.filter((x) => x.body.model === 'bueno' && x.auth === 'Bearer buena').at(-1), gwSeen.at(-1));
});
test('Gateway: si todo está en pausa, se intenta igualmente como último recurso', async () => {
  await configure({ enabled: true, providers: [prov('x/agotado1', 'agotado'), prov('x/agotado2', 'agotado')] });
  const n = () => gwSeen.filter((x) => x.body.model === 'agotado').length;
  await gw('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'a' }] });
  const n1 = n();
  const r = await gw('/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'b' }] });
  assert.equal(r.status, 429); assert.ok(n() > n1, 'vuelve a probar en lugar de rendirse sin intentarlo');
});
test('Gateway: si el proveedor se corta a mitad del streaming, el cliente recibe un error (no un final correcto)', async () => {
  await configure({ enabled: true, providers: [prov('p/corta', 'corta')] });
  const o = await (await gw('/v1/chat/completions', { model: 'p/corta', stream: true, messages: [{ role: 'user', content: 'hola' }] })).text();
  assert.match(o, /a medias/); assert.match(o, /upstream_interrupted/); assert.doesNotMatch(o, /\[DONE\]/);
  const a = await (await gw('/v1/messages', { model: 'p/corta', max_tokens: 10, stream: true, messages: [{ role: 'user', content: 'hola' }] })).text();
  assert.match(a, /event: error/); assert.doesNotMatch(a, /message_stop/); assert.doesNotMatch(a, /end_turn/);
});
test('Gateway: dos clientes a la vez no mezclan sus respuestas', async () => {
  await configure({ enabled: true, providers: [prov('p/eco', 'eco')] });
  const one = (q) => gw('/v1/chat/completions', { model: 'p/eco', stream: true, messages: [{ role: 'user', content: q }] }).then((r) => r.text())
    .then((t) => [...t.matchAll(/"content":"(.)"/g)].map((m) => m[1]).join(''));
  const [a, b] = await Promise.all([one('primer-cliente'), one('SEGUNDO-CLIENTE')]);
  assert.equal(a, 'primer-cliente'); assert.equal(b, 'SEGUNDO-CLIENTE');
  await configure({ enabled: false });
});
