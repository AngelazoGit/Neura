// Fase 1: empezar sin saber nada. Nivel principiante/profesional, IA en este equipo (Ollama) sin cuentas,
// guía por proveedor y caso de la web sin PC.
const { _electron, chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const launch = (UD) => _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });

(async () => {
  await mocks.start();
  await mocks.stopOllama(); // equipo nuevo: Ollama aún no está instalado
  const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
  let app = await launch(UD); let w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('.wizard', { timeout: 20000 });

  // Nivel
  ok(!!(await w.$('[data-level=basic]')), 'la primera vez pregunta si es principiante o ya usa IAs');
  await w.click('[data-level=basic]');
  ok(await w.evaluate(() => S.level === 'basic' && liveSkills().map((k) => k.name).join('|') === 'Mejorar mi pregunta|Aprender paso a paso|Comprobar una respuesta'), 'principiante: se añaden 3 habilidades que enseñan a usar bien las IAs');
  ok(!(await w.isVisible('#councilLbl')) && !(await w.isVisible('#toolsLbl')), 'principiante: CONSEJO y HERRAMIENTAS se ocultan');
  ok(/CÓMO USAR BIEN LAS IAs/.test(await w.textContent('#log')), 'principiante: se muestran consejos de uso correcto');

  // IA en este equipo: sin Ollama
  await w.waitForSelector('.localAI [data-lai=check]', { timeout: 10000 });
  const link = await w.getAttribute('.localAI a[href*="ollama.com/download"]', 'href');
  ok(/ollama\.com\/download\/(linux|mac|windows)/.test(link), 'sin Ollama: enlaza el instalador de este sistema · ' + link);
  // El usuario lo instala y pulsa «ya lo he instalado»
  await mocks.startOllama();
  await w.click('[data-lai=check]');
  await w.waitForSelector('.localAI [data-lai=pull]', { timeout: 10000 });
  const txt = await w.textContent('.localAI');
  const ram = Math.round(os.totalmem() / 2 ** 30);
  const rec = ram < 7 ? 'llama3.2:3b' : ram < 15 ? 'qwen3:4b' : 'qwen3:8b';
  ok(txt.includes(`${ram} GB`) && txt.includes(rec), `con Ollama: muestra la memoria (${ram} GB) y recomienda ${rec}`);
  ok(/Ya tienes: .*qwen3:4b/.test(txt) || rec === 'qwen3:4b', 'ofrece usar los modelos que ya tienes');
  await w.click('[data-lai=pull]');
  await w.waitForSelector('#lpBar', { timeout: 5000 }).then(() => ok(true, 'descarga con barra de progreso'), () => ok(false, 'barra de progreso'));
  await w.waitForFunction((rec) => S.target === `mcp:local::ollama/${rec}`, rec, { timeout: 20000 })
    .then(() => ok(true, `al terminar, ${rec} queda elegido (ESTE PC)`), () => ok(false, 'modelo elegido tras descargar'));
  ok(!(await w.$('.wizard')), 'el asistente desaparece cuando ya hay una IA lista');
  await w.fill('#input', 'hola'); await w.click('#send');
  await w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'));
  ok(/local dice/.test(await w.$$eval('#log .reply', (r) => r.at(-1).innerText)), 'la primera pregunta la responde la IA del equipo, sin cuentas ni claves');

  // Profesional
  await w.click('#btnAis'); await w.click('#settings [data-level=pro]'); await w.keyboard.press('Escape');
  ok(await w.isVisible('#councilLbl'), 'profesional: CONSEJO vuelve a estar visible');
  await app.close();

  // Guía por proveedor (pestaña IA en internet)
  const UD2 = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
  app = await launch(UD2); w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('.wizard');
  await w.click('[data-wz=cloud]');
  ok(/Una cuenta de Google/.test(await w.textContent('#wzBody')) && /puede usar lo que escribes/.test(await w.textContent('#wzBody')), 'Gemini: qué cuenta necesitas, pasos y aviso de privacidad del nivel gratuito');
  await w.selectOption('#wzPreset', 'openrouter');
  ok(/:free/.test(await w.textContent('#wzBody')) && (await w.getAttribute('#wzKey', 'href')).includes('openrouter.ai'), 'al cambiar de IA cambian la guía y el enlace');
  ok(!!(await w.$('[data-level=pro]')), 'si aún no ha elegido nivel, la pregunta sigue ahí');
  await app.close();

  // Web sin PC: explica cómo tener IA sin cuentas
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-br-'));
  const br = spawn(process.execPath, [path.join(__dirname, '../../bridge/server.mjs')], { env: { ...process.env, PORT: '8797', HOST: '127.0.0.1', NEURA_TOKEN: 'x'.repeat(24), NEURA_DATA: data, NEURA_CONFIG: '/nonexistent.json' } });
  await new Promise((r) => br.stdout.on('data', (d) => String(d).includes('Backends') && r()));
  const b = await chromium.launch(); const p = await b.newPage();
  p.on('pageerror', (e) => { console.log('PAGEERROR web', e.message); failures++; });
  await p.goto('http://127.0.0.1:8797/');
  await p.waitForSelector('.wizard');
  ok(await p.$eval('[data-wz=cloud]', (x) => x.classList.contains('on')), 'en la web empieza por «IA en internet»');
  await p.click('[data-wz=local]');
  ok(/Neura para PC/.test(await p.textContent('#wzBody')), 'en la web, «IA en este equipo» explica cómo conseguirla con Neura para PC');
  await b.close(); br.kill();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
