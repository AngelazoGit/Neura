// Hallazgos de la revisión externa: gratis/privado por backend real, sincronización y dictado en hilos privados,
// historial de versiones de habilidades y presupuesto de contexto sobre la petición completa.
const { _electron } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
// Puente del PC con un backend local (Ollama simulado) y otro externo de pago.
fs.writeFileSync(path.join(UD, 'puente.json'), JSON.stringify({ backends: [
  { id: 'ollama', type: 'ollama', url: 'http://127.0.0.1:11434' },
  { id: 'nube', type: 'openai', url: 'http://203.0.113.5/v1', apiKey: 'de-pago', models: ['gpt-x'] },
] }));
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [
    { id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido'], enabled: true },
    { id: 'oa', preset: 'openai', name: 'OPENAI', kind: 'openai', tier: 'paid', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido'], enabled: true },
  ],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true,
  skills: [{ id: 'sk1', name: 'larga', description: 'x', instructions: 'Regla. '.repeat(500), version: 1, updatedAt: 1 }],
}));
const idle = (w) => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'), null, { timeout: 30000 });
const send = async (w, t) => { await w.fill('#input', t); await w.click('#send'); await idle(w); };
const setT = (w, k) => w.evaluate((k) => { const s = document.querySelector('#target'); s.value = k; s.dispatchEvent(new Event('change')); }, k);
const optText = (w, k) => w.$eval('#target', (s, k) => [...s.options].find((o) => o.value === k)?.textContent || '', k);

(async () => {
  await mocks.start();
  // Segundo puente que NO es un equipo tuyo (p. ej. el de un amigo), con sincronización.
  const otherData = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-otro-'));
  const other = spawn(process.execPath, [path.join(__dirname, '../../bridge/server.mjs')], { env: { ...process.env, PORT: '8799', HOST: '127.0.0.1', NEURA_TOKEN: 'otro-token-1234567890', NEURA_DATA: otherData, NEURA_CONFIG: '/nonexistent.json' } });
  await new Promise((r) => other.stdout.on('data', (d) => String(d).includes('Backends') && r()));

  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => [...document.querySelectorAll('#target option')].some((o) => o.value.includes('nube/gpt-x')), null, { timeout: 20000 });
  const nube = 'mcp:local::nube/gpt-x', local = 'mcp:local::ollama/qwen3:4b';
  ok(await w.evaluate(() => JSON.stringify(S.mcp[0].backends.map((b) => [b.id, b.local]))) === '[["ollama",true],["nube",false]]', 'el puente indica qué backend es local y cuál externo');

  await w.click('#btnAis'); await w.check('#freeOnly'); await w.keyboard.press('Escape');
  ok((await optText(w, nube)).startsWith('⛔') && !(await optText(w, local)).startsWith('⛔'), 'SOLO GRATIS: un backend externo del puente ya no cuenta como gratis; el local sí');
  await w.click('#btnAis'); await w.uncheck('#freeOnly'); await w.keyboard.press('Escape');

  await w.check('#private');
  ok((await optText(w, nube)).startsWith('⛔') && !(await optText(w, local)).startsWith('⛔'), '🔒 PRIVADO: el backend externo del puente queda fuera, aunque el puente sea tuyo');
  const viaBridge = await w.evaluate(async () => {
    const s = S.mcp[0];
    const r = await mcpRpc(s, 'tools/call', { name: 'chat', arguments: { model: 'nube/gpt-x', messages: [{ role: 'user', content: 'hola' }], local_only: true } });
    return r.isError ? r.content[0].text : 'ENVIADO';
  });
  ok(/no es local/.test(viaBridge), 'el puente también rechaza enviar un hilo privado a un backend externo: ' + viaBridge);
  await setT(w, local);
  await send(w, 'dato privado');
  ok(/local dice/.test(await w.$$eval('#log .reply', (r) => r.at(-1).innerText)), 'el hilo privado lo responde el backend local');

  // Dictado
  const sttBefore = mocks.log.filter((x) => x.stt).length;
  await w.click('#mic');
  await w.waitForTimeout(500);
  ok(/Hilo privado: el dictado/.test(await w.textContent('#toast')), 'el dictado se desactiva en un hilo privado');
  await w.click('#btnThreads'); await w.click('#newThread');
  await w.click('#btnAis'); await w.check('#freeOnly'); await w.keyboard.press('Escape');
  ok(await w.evaluate("sttProvider()?.name") === 'MOCK', 'con SOLO GRATIS, el dictado solo usa proveedores gratuitos (no OpenAI de pago)');
  await w.click('#btnAis'); await w.uncheck('#freeOnly'); await w.keyboard.press('Escape');
  ok(mocks.log.filter((x) => x.stt).length === sttBefore, 'no se envió audio en el hilo privado');

  // Sincronización: el hilo privado no va al puente que no es tuyo
  await setT(w, 'm::rapido');
  await send(w, 'hilo normal');
  await w.evaluate(() => { S.mcp.push({ id: 'otro', name: 'AMIGO', url: 'http://127.0.0.1:8799/mcp', token: 'otro-token-1234567890', models: [], tools: [] }); save(); return mcpConnect(S.mcp.at(-1), true); });
  await w.waitForTimeout(2500);
  const remote = JSON.parse(fs.readFileSync(path.join(otherData, 'hilos.json'), 'utf8'));
  const titles = Object.values(remote.threads).map((t) => t.title);
  ok(titles.includes('hilo normal') && !titles.includes('dato privado'), 'los hilos privados solo se sincronizan con tus equipos: ' + titles.join(', '));
  const mine = JSON.parse(fs.readFileSync(path.join(UD, 'hilos.json'), 'utf8'));
  ok(Object.values(mine.threads).some((t) => t.title === 'dato privado'), '…y sí con el puente de tu PC');

  // Presupuesto de contexto con una habilidad larga
  await w.click('#btnAis'); await w.fill('#ctxTokens', '2500'); await w.$eval('#ctxTokens', (e) => e.dispatchEvent(new Event('change', { bubbles: true }))); await w.keyboard.press('Escape');
  await w.click('#btnThreads'); await w.click('#newThread');
  await w.click('#btnSkills'); await w.click('[data-sk=use]');
  for (let i = 0; i < 4; i++) await send(w, `pregunta ${i} ` + 'contexto '.repeat(120));
  const lastReq = mocks.log.filter((x) => x.model === 'rapido').at(-1);
  const est = Math.ceil(lastReq.size / 3.5);
  ok(est <= 2500 - 800 + 200, `la petición completa (habilidad incluida) respeta el presupuesto y deja sitio a la respuesta: ~${est} tokens de 2500`);

  // Historial de versiones
  await w.click('#btnSkills'); await w.click('[data-sk=edit]');
  await w.fill('#skInstr', 'Versión dos'); await w.click('#skSave');
  await w.click('[data-sk=edit]');
  await w.click('[data-restore="1"]');
  ok((await w.inputValue('#skInstr')).startsWith('Regla.'), 'se puede consultar y cargar una versión anterior (v1)');
  await w.click('#skSave');
  const k = await w.evaluate("JSON.parse(JSON.stringify(S.skills[0]))");
  ok(k.version === 3 && k.instructions.startsWith('Regla.') && k.history.map((h) => h.version).join() === '1,2', 'restaurar crea la v3 con el contenido de la v1 y conserva v1 y v2 en el historial');
  await app.close(); other.kill();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
