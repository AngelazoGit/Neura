const { _electron } = require('playwright'); const fs = require('fs'), path = require('path');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [
    { id: 'gem', preset: 'gemini', name: 'Google Gemini', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['gemini-pro-latest', 'gemini-4-hydrogen', 'gemini-flash-lite-latest', 'gemini-flash-latest'], enabled: true },
    { id: 'pay', preset: 'custom', name: 'DE PAGO', kind: 'openai', tier: 'paid', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido'], enabled: true },
  ], mcp: [], threads: [], target: 'gem::gemini-pro-latest', autoSkip: true,
}));
const idle = (w) => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'), null, { timeout: 20000 });
const send = async (w, t) => { await w.fill('#input', t); await w.click('#send'); await idle(w); };
const setT = (w, k) => w.evaluate((k) => { const s = document.querySelector('#target'); s.value = k; s.dispatchEvent(new Event('change')); }, k);
const last = (w) => w.$$eval('#log .msg', (m) => m.at(-1).innerText);
(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => [...document.querySelectorAll('#target option')].some((o) => o.textContent.includes('ESTE PC')), null, { timeout: 20000 });
  ok(await w.$eval('#target', (s) => s.value) === 'gem::gemini-flash-latest', 'la selección pasa de Pro (sin cuota gratis) a gemini-flash-latest');
  const order = await w.$$eval('#target option', (o) => o.map((x) => x.value).filter((v) => v.startsWith('gem::')));
  ok(order.join() === 'gem::gemini-flash-latest,gem::gemini-flash-lite-latest,gem::gemini-pro-latest,gem::gemini-4-hydrogen', 'orden: flash, flash-lite, pro, experimental: ' + order.join(', '));
  await send(w, 'hola');
  const log1 = await w.$eval('#log', (l) => l.innerText);
  ok(!/probando otra IA/.test(log1) && /Respuesta del modelo vigente/.test(log1), 'responde a la primera, sin fallos previos (el caso de la imagen)');

  await setT(w, 'gem::gemini-4-hydrogen');
  await send(w, 'uno'); await send(w, 'dos');
  ok(mocks.calls['gemini-4-hydrogen'] === 1, 'un modelo caído (5xx) se pausa al primer fallo y no se reintenta en el siguiente mensaje');

  ok(!await w.evaluate("trusted({ serverInfo: { name: 'neura-bridge' } })") && !!await w.evaluate("trusted({ trustTools: true })"), 'un servidor que solo DICE ser neura-bridge ya no es de confianza');

  await w.click('#btnAis'); await w.check('#freeOnly'); await w.keyboard.press('Escape');
  await setT(w, 'pay::rapido');
  const before = mocks.calls.rapido || 0;
  await send(w, 'pregunta gratis');
  const log2 = await w.$$eval('#log .msg', (m) => m.slice(-2).map((x) => x.innerText).join('\n'));
  ok((mocks.calls.rapido || 0) === before && /⛔ es de pago/.test(log2), 'SOLO GRATIS: no llama a la IA de pago, avisa y contesta una gratuita');
  ok(await w.$eval('#target', (s) => [...s.options].find((o) => o.value === 'pay::rapido').textContent.startsWith('⛔')), 'la IA de pago aparece con ⛔ en el desplegable');
  await w.click('#btnAis'); await w.uncheck('#freeOnly'); await w.keyboard.press('Escape');

  await w.click('#btnThreads'); await w.click('#newThread');
  await w.check('#private');
  await setT(w, 'gem::gemini-flash-latest');
  const gemBefore = mocks.calls['gemini-flash-latest'];
  await send(w, 'secreto');
  ok(mocks.calls['gemini-flash-latest'] === gemBefore && /local dice/.test(await last(w)), '🔒 PRIVADO: solo responde el puente de este PC, nada sale a Gemini');
  await w.click('#btnThreads'); await w.click('#newThread');
  ok(!(await w.$eval('#private', (c) => c.checked)), 'el modo privado es de cada hilo (un hilo nuevo no lo hereda)');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
