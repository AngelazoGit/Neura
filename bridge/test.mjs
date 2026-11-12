// node --test bridge/test.mjs — comprueba las defensas del puente.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 18787, BASE = `http://127.0.0.1:${PORT}`;
const srv = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', import.meta.url))], {
  env: { ...process.env, PORT, HOST: '0.0.0.0', NEURA_TOKEN: '', NEURA_CONFIG: '/nonexistent.json' },
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
  assert.deepEqual(r.result.tools.map((t) => t.name), ['list_models', 'chat', 'system_info']);
});
test('/health no revela datos del equipo', async () => {
  assert.deepEqual(await (await fetch(`${BASE}/health`)).json(), { ok: true });
});
test('peticiones malformadas no tumban el servidor', async () => {
  assert.equal((await fetch(`${BASE}/%E0%A4%A`)).status, 400);
  assert.equal((await rpc('{no json')).status, 400);
  const big = await rpc('x'.repeat(6 * 2 ** 20)).catch(() => ({ status: 'reset' }));
  assert.ok([413, 'reset'].includes(big.status));
  assert.equal((await fetch(`${BASE}/health`)).status, 200);
});
test('no sirve archivos fuera de la app', async () => {
  assert.equal((await fetch(`${BASE}/..%2f..%2fbridge%2fserver.mjs`)).status, 404);
});
