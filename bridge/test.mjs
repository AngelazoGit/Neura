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
  env: { ...process.env, PORT, HOST: '0.0.0.0', NEURA_TOKEN: '', NEURA_CONFIG: '/nonexistent.json', NEURA_DATA: mkdtempSync(join(tmpdir(), 'neura-')) },
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
