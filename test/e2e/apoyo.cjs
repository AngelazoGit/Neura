// Funciones de apoyo: datos sensibles, ajustes rápidos, COMPROBAR, consejo al escribir, ESTRUCTURAR, aviso de actualidad,
// glosario, por qué esta IA y plantillas PRO.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [{ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido', 'cuota'], enabled: true }],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true, level: 'pro', wizardDone: true,
}));

(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => typeof S !== 'undefined' && S.mcp[0]?.status === 'on', null, { timeout: 20000 });
  const idle = () => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg').length > 0, null, { timeout: 30000 });
  const sendMsg = async (t) => { await w.fill('#input', t); await w.click('#send'); await idle(); };
  const lastQ = () => mocks.log.filter((x) => x.model).at(-1)?.q || '';

  // ---- 1. Datos sensibles ----
  const n0 = mocks.log.length;
  await w.fill('#input', 'Hazme una carta para el banco. Mi DNI es 12345678Z y mi IBAN ES91 2100 0418 4502 0005 1332');
  await w.click('#send');
  await w.waitForSelector('.hintbar.guard');
  const g = await w.textContent('.hintbar.guard');
  ok(/datos sensibles/.test(g) && /IBAN/.test(g) && /DNI\/NIE/.test(g) && mocks.log.length === n0, 'antes de enviar, avisa de los datos sensibles (DNI, IBAN) y no envía nada todavía');
  ok(!!(await w.$('[data-guard=private]')), 'ofrece mandarlo solo a la IA local (hay IA en este PC)');
  await w.click('[data-guard=hide]'); await idle();
  ok(/Mi DNI es \[DNI\] y mi IBAN \[IBAN\]/.test(lastQ()) && !/12345678Z|2100 0418/.test(lastQ()), 'OCULTARLOS: la IA recibe [DNI] y [IBAN], nunca los datos reales');
  await w.fill('#input', 'mi contraseña: Secreta123'); await w.click('#send'); await w.waitForSelector('.hintbar.guard');
  await w.click('[data-guard=cancel]');
  ok(await w.inputValue('#input') === 'mi contraseña: Secreta123' && await w.isHidden('#skillHint'), 'CANCELAR devuelve el texto a la caja para editarlo');
  await w.click('#send'); await w.waitForSelector('.hintbar.guard');
  await w.click('[data-guard=private]'); await idle();
  ok(await w.evaluate(() => thread().private) && /local dice: mi contraseña/.test(await w.$$eval('#log .reply', (r) => r.at(-1).innerText)), 'SOLO A MI IA LOCAL: el hilo pasa a 🔒 PRIVADO y responde la IA del PC');
  await w.evaluate(() => { thread().private = false; S.active = null; save(); renderLog(); renderTargets(); });
  await w.fill('#input', 'Escribe un correo a ana@empresa.com'); await w.click('#send');
  await w.waitForSelector('.hintbar.guard').then(() => ok(true, 'también avisa de correos'), () => ok(false, 'aviso de correo'));
  await w.click('[data-guard=send]'); await idle();
  ok(/ana@empresa\.com/.test(lastQ()), 'ENVIAR IGUALMENTE lo manda tal cual');
  await w.evaluate(() => { S.guard = false; save(); });
  await sendMsg('Mi teléfono es 612 345 678');
  ok(await w.isHidden('#skillHint') && /612 345 678/.test(lastQ()), 'se puede desactivar en ⚙ → DATOS SENSIBLES');
  await w.evaluate(() => { S.guard = true; S.active = null; save(); renderLog(); });

  // ---- 2. Ajustes rápidos ----
  await sendMsg('Explícame la fotosíntesis');
  ok((await w.$$('.adjust button')).length === 6, 'bajo la última respuesta aparecen los ajustes de un toque');
  await w.click('.adjust button:has-text("Más corta")'); await idle();
  ok(/Hazla más corta/.test(lastQ()) && /Hazla más corta/.test(await w.$$eval('#log .msg.user', (u) => u.at(-1).innerText)), '«Más corta» lo pide como un mensaje normal (se ve qué se pidió)');
  ok((await w.$$('.adjust')).length === 1, 'solo la última respuesta tiene los ajustes');

  // ---- 3. COMPROBAR ----
  const ids = await w.$$eval('[data-check]', (b) => b.map((x) => x.dataset.check));
  await w.click(`[data-check="${ids.at(-1)}"]`); await idle();
  const ch = mocks.log.filter((x) => x.model).at(-1);
  ok(/Comprueba esta respuesta/.test(ch.q) && /Habilidad activa: «Comprobar una respuesta»/.test(ch.system.join(' ')), '🔎 COMPROBAR envía la respuesta con la habilidad «Comprobar una respuesta» (aunque no esté instalada)');
  ok(/🔎 Comprueba la respuesta de MOCK/.test(await w.$$eval('#log .msg.user', (u) => u.at(-1).innerText)) && !(await w.evaluate(() => thread().skill)), 'en el chat se ve una línea corta y la habilidad no queda activada en el hilo');

  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
