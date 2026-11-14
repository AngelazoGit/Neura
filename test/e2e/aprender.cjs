// Ruta de aprendizaje (principiante) y habilidad «Prompt para imagen».
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [{ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido', 'tabla'], enabled: true }],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true, level: 'basic', wizardDone: true,
}));

(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('.learnCard', { timeout: 20000 });
  const card = await w.textContent('.learnCard');
  ok(/TU RUTA DE APRENDIZAJE · 0\/8/.test(card) && /Haz tu primera pregunta/.test(card), 'principiante: la pantalla inicial muestra la ruta de aprendizaje y el siguiente reto');
  await w.click('[data-learnex=first]');
  ok(/5 viñetas/.test(await w.inputValue('#input')), '«PROBAR CON UN EJEMPLO» escribe un ejemplo en la caja');
  await w.click('#send');
  await w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg').length > 1);
  ok(/Reto conseguido/.test(await w.textContent('#toast')), 'al conseguir un reto, Neura lo celebra con un consejo');
  ok(await w.evaluate(() => ['first', 'format'].every((x) => S.learnSeen.includes(x))), 'detecta los retos conseguidos sin marcarlos a mano (primera pregunta y formato: «viñetas»)');

  await w.fill('#input', 'Ahora dímelo de otra forma'); await w.click('#send');
  await w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'));
  await w.selectOption('#target', 'm::tabla');
  await w.fill('#input', 'Y tú qué opinas'); await w.click('#send');
  await w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'));
  ok(await w.evaluate(() => learnState().filter((x) => x.ok).map((x) => x.id).join(',')) === 'first,format,follow,compare', 'seguir la conversación y comparar dos IAs en el mismo hilo cuentan como retos');

  await w.click('#btnThreads'); await w.click('#newThread');
  await w.waitForSelector('.learnCard');
  ok(/4\/8/.test(await w.textContent('.learnCard')) && /Da contexto/.test(await w.textContent('.learnCard')), 'en un hilo nuevo, la ruta continúa por el siguiente reto');

  await w.click('#btnAis');
  ok(/RUTA DE APRENDIZAJE · 4\/8/.test(await w.textContent('.learnSet summary')), 'también se ve en ⚙ → NIVEL');
  await w.click('#addStarters');
  ok(await w.evaluate(() => liveSkills().some((k) => k.name === 'Prompt para imagen' && /Evitar:/.test(k.instructions))), '«+ HABILIDADES DE INICIO» añade «Prompt para imagen» (prompt detallado y negativo)');
  await w.click('#settings [data-level=pro]'); await w.keyboard.press('Escape');
  ok(!(await w.$('.learnCard')), 'en modo profesional la tarjeta de la ruta no aparece en el chat');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
