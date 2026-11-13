// Neura Gateway con clientes reales: los SDK oficiales de OpenAI y de Anthropic.
// Requiere: npm i --no-save openai @anthropic-ai/sdk   ·   Uso: node test/e2e/sdk.mjs
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const ver = (p) => JSON.parse(readFileSync(join(HERE, '../../node_modules', p, 'package.json'), 'utf8')).version;
console.log(`openai ${ver('openai')} · @anthropic-ai/sdk ${ver('@anthropic-ai/sdk')}`);

// IA de origen simulada (compatible con OpenAI): texto, herramientas, streaming y un modelo que se corta.
const upstream = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    const j = JSON.parse(b || '{}');
    const tool = j.tools?.length && !j.messages.some((m) => m.role === 'tool');
    const sse = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (j.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (j.model === 'corta') { sse({ choices: [{ index: 0, delta: { content: 'a medias' }, finish_reason: null }] }); return setTimeout(() => res.destroy(), 100); }
      if (tool) {
        sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'leer', arguments: '' } }] }, finish_reason: null }] });
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"ruta":' } }] }, finish_reason: null }] });
        sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] });
      } else {
        sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hola ' }, finish_reason: null }] });
        sse({ choices: [{ index: 0, delta: { content: 'desde Neura' }, finish_reason: 'stop' }] });
      }
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const last = j.messages.at(-1);
    res.end(JSON.stringify(tool
      ? { id: 'c1', object: 'chat.completion', created: 1, model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'leer', arguments: '{"ruta":"a.txt"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }
      : { id: 'c1', object: 'chat.completion', created: 1, model: j.model, choices: [{ index: 0, message: { role: 'assistant', content: last.role === 'tool' ? `El archivo dice: ${last.content}` : 'Hola desde Neura' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }));
  });
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const UP = `http://127.0.0.1:${upstream.address().port}/v1`;

const PORT = 8798, ADMIN = 'token-puente-sdk-1234567890', GWT = 'token-gateway-sdk-1234567890', BASE = `http://127.0.0.1:${PORT}`;
const br = spawn(process.execPath, [join(HERE, '../../bridge/server.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NEURA_TOKEN: ADMIN, NEURA_GATEWAY_TOKEN: GWT, NEURA_DATA: mkdtempSync(join(tmpdir(), 'neura-sdk-')), NEURA_CONFIG: '/nonexistent.json' } });
await new Promise((r) => br.stdout.on('data', (d) => String(d).includes('Backends') && r()));
const cfg = await fetch(`${BASE}/neura/gateway`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` },
  body: JSON.stringify({ enabled: true, providers: [{ id: 'nube/bueno', url: UP, apiKey: 'k', model: 'bueno' }, { id: 'nube/corta', url: UP, apiKey: 'k', model: 'corta' }], order: ['nube/bueno'] }) });
ok(cfg.status === 200, 'Gateway configurado');
const tools = [{ name: 'leer', description: 'Lee un archivo', input_schema: { type: 'object', properties: { ruta: { type: 'string' } }, required: ['ruta'] } }];

try {
  // ---- SDK de OpenAI ----
  const oa = new OpenAI({ baseURL: `${BASE}/v1`, apiKey: GWT, maxRetries: 0 });
  const models = []; for await (const m of oa.models.list()) models.push(m.id);
  ok(models[0] === 'auto' && models.includes('nube/bueno'), 'OpenAI SDK · models.list');
  const c = await oa.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'hola' }] });
  ok(c.choices[0].message.content === 'Hola desde Neura', 'OpenAI SDK · chat.completions.create');
  let txt = ''; for await (const ch of await oa.chat.completions.create({ model: 'auto', stream: true, messages: [{ role: 'user', content: 'hola' }] })) txt += ch.choices[0]?.delta?.content || '';
  ok(txt === 'Hola desde Neura', 'OpenAI SDK · streaming');
  const tc = await oa.chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'lee a.txt' }], tools: [{ type: 'function', function: { name: 'leer', parameters: tools[0].input_schema } }] });
  ok(JSON.parse(tc.choices[0].message.tool_calls[0].function.arguments).ruta === 'a.txt', 'OpenAI SDK · herramientas');
  try { await oa.chat.completions.create({ model: 'modelo-con-errata', messages: [{ role: 'user', content: 'x' }] }); ok(false, 'OpenAI SDK · modelo desconocido'); }
  catch (e) { ok(e.status === 404 && /\/v1\/models/.test(e.message), 'OpenAI SDK · un modelo desconocido lanza NotFoundError (404)'); }
  try { let t = ''; for await (const ch of await oa.chat.completions.create({ model: 'nube/corta', stream: true, messages: [{ role: 'user', content: 'x' }] })) t += ch.choices[0]?.delta?.content || ''; ok(false, 'OpenAI SDK · corte en streaming terminó sin error: ' + t); }
  catch (e) { ok(/interrump/i.test(e.message), 'OpenAI SDK · un corte a mitad del streaming lanza un error (no se da por terminado)'); }

  // ---- SDK de Anthropic ----
  const an = new Anthropic({ baseURL: BASE, apiKey: GWT, maxRetries: 0 });
  const m1 = await an.messages.create({ model: 'auto', max_tokens: 50, messages: [{ role: 'user', content: 'hola' }] });
  ok(m1.content[0].type === 'text' && m1.content[0].text === 'Hola desde Neura' && m1.stop_reason === 'end_turn', 'Anthropic SDK · messages.create');
  const m2 = await an.messages.create({ model: 'auto', max_tokens: 50, tools, messages: [{ role: 'user', content: 'lee a.txt' }] });
  const use = m2.content.find((b) => b.type === 'tool_use');
  ok(m2.stop_reason === 'tool_use' && use?.input?.ruta === 'a.txt', 'Anthropic SDK · herramientas (tool_use)');
  const m3 = await an.messages.create({ model: 'auto', max_tokens: 50, tools, messages: [
    { role: 'user', content: 'lee a.txt' }, { role: 'assistant', content: m2.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: use.id, content: 'hola mundo' }] }] });
  ok(m3.content[0].text === 'El archivo dice: hola mundo', 'Anthropic SDK · devolver el resultado de la herramienta (tool_result)');
  const s1 = await an.messages.stream({ model: 'auto', max_tokens: 50, messages: [{ role: 'user', content: 'hola' }] }).finalMessage();
  ok(s1.content[0].text === 'Hola desde Neura' && s1.stop_reason === 'end_turn', 'Anthropic SDK · streaming (texto)');
  const s2 = await an.messages.stream({ model: 'auto', max_tokens: 50, tools, messages: [{ role: 'user', content: 'lee a.txt' }] }).finalMessage();
  ok(s2.stop_reason === 'tool_use' && s2.content.find((b) => b.type === 'tool_use')?.input?.ruta === 'a.txt', 'Anthropic SDK · streaming con herramientas (input_json_delta)');
  try { await an.messages.create({ model: 'claude-errata', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }); ok(false, 'Anthropic SDK · modelo desconocido'); }
  catch (e) { ok(e.status === 404, 'Anthropic SDK · un modelo desconocido lanza NotFoundError (404)'); }
  try { await an.messages.stream({ model: 'nube/corta', max_tokens: 10, messages: [{ role: 'user', content: 'x' }] }).finalMessage(); ok(false, 'Anthropic SDK · corte terminó sin error'); }
  catch (e) { ok(/interrump/i.test(e.message), 'Anthropic SDK · un corte a mitad del streaming lanza un error (no se da por terminado)'); }
  try { await new Anthropic({ baseURL: BASE, apiKey: ADMIN, maxRetries: 0 }).messages.create({ model: 'auto', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }); ok(false, 'token del puente'); }
  catch (e) { ok(e.status === 401, 'Anthropic SDK · el token del puente no sirve en el Gateway (401)'); }
} catch (e) { console.error(e); failures++; }
br.kill(); upstream.close();
console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
