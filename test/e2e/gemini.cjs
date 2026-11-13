// Usuario de Gemini con los modelos viejos guardados: migración, 404, errores en español, solo español y <think>.
const { _electron } = require('playwright');
const fs = require('fs'), path = require('path');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
let failures = 0;
const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [
    { id: 'gem', preset: 'gemini', name: 'Google Gemini', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], enabled: true },
    { id: 'x', preset: 'custom', name: 'OTRA', kind: 'openai', tier: 'other', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['gemini-2.5-flash', 'think'], enabled: true },
  ], mcp: [], threads: [], target: 'x::gemini-2.5-flash', autoSkip: true,
}));
(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('#target option', { state: 'attached' });
  const opts = await w.$$eval('#target option', (o) => o.map((x) => x.value));
  ok(opts.includes('gem::gemini-flash-latest') && !opts.includes('gem::gemini-2.5-flash'), 'Gemini: los modelos 2.5 guardados pasan a los alias -latest');
  await w.fill('#input', 'hola'); await w.click('#send');
  await w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'));
  const log = await w.$eval('#log', (l) => l.innerText);
  console.log('--- chat ---\n' + log + '\n------------');
  ok(/ya no está disponible.*probando otra IA/s.test(log) && !/no longer available/.test(log), 'el modelo retirado sale en una línea en español (el inglés queda plegado)');
  await w.evaluate(() => { const s = document.querySelector('#target'); s.value = 'x::think'; s.dispatchEvent(new Event('change')); });
  await w.fill('#input', 'saluda'); await w.click('#send');
  await w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'));
  const log2 = await w.$eval('#log', (l) => l.innerText);
  ok(/¡Hola! Solo en español\./.test(log2) && !/The user wants/.test(log2), 'el razonamiento interno <think> en inglés no se muestra');

  ok(mocks.log.filter((x) => x.model === 'think').at(-1).system.some((s) => /solo en español/.test(s)), 'cada petición lleva la instrucción "solo en español"');
  await w.waitForFunction(() => ![...document.querySelectorAll('#target option')].some((o) => o.value === 'x::gemini-2.5-flash'), null, { timeout: 5000 })
    .then(() => ok(true, 'tras el 404 se actualiza sola la lista de modelos'), () => ok(false, 'refresco de modelos'));
  const now = await w.$$eval('#target option', (o) => o.map((x) => x.value).filter((v) => v.startsWith('x::')));
  ok(now[0] === 'x::gemini-flash-latest' && !now.some((v) => /embedding|imagen|tts/.test(v)), `lista nueva solo con modelos de chat, alias primero: ${now.join(', ')}`);
  await w.click('#btnAis');
  ok((await w.inputValue('#instructions')).includes('solo en español'), '⚙ muestra las instrucciones editables');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
