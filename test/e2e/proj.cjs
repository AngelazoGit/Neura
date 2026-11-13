// Proyectos (memoria + habilidad por defecto) y sincronización de habilidades/proyectos entre PC y móvil.
const { _electron, chromium } = require('playwright'); const fs = require('fs'), path = require('path');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [{ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido'], enabled: true }],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true,
  skills: [{ id: 'sk1', name: 'apuntes', description: 'Resume apuntes y genera preguntas de repaso', instructions: '1. Resume. 2. Pregunta.', version: 1, updatedAt: 1 }],
}));
const idle = (w) => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'), null, { timeout: 20000 });
const send = async (w, t) => { await w.fill('#input', t); await w.click('#send'); await idle(w); };
(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => [...document.querySelectorAll('#target option')].some((o) => o.textContent.includes('ESTE PC')), null, { timeout: 20000 });

  await w.click('#btnThreads');
  await w.selectOption('#projectSel', '__new');
  await w.waitForSelector('#prMemory');
  await w.fill('#prName', 'Tesis');
  await w.$eval('#prName', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await w.fill('#prMemory', 'Tesis sobre energía solar; estilo académico.');
  await w.$eval('#prMemory', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await w.selectOption('#prSkill', 'sk1');
  await w.click('#newThread');
  ok((await w.textContent('#btnSkills')).includes('APUNTES'), 'un hilo nuevo dentro del proyecto hereda su habilidad por defecto');
  ok((await w.textContent('#btnThreads')) === '📁', 'el botón de hilos indica que estás en un proyecto');
  await send(w, 'capítulo 1');
  const sys = mocks.log.at(-1).system.join('\n');
  ok(/Proyecto «Tesis»/.test(sys) && /energía solar/.test(sys) && /Habilidad activa: «apuntes»/.test(sys) && sys.indexOf('Proyecto') < sys.indexOf('Habilidad'), 'cada petición lleva: instrucciones globales → memoria del proyecto → habilidad');
  await w.click('#btnThreads');
  ok((await w.$$('#threadList .chatItem')).length === 1, 'el proyecto filtra sus hilos');
  await w.selectOption('#projectSel', '');
  ok(/📁 Tesis/.test(await w.$eval('#threadList', (e) => e.innerText)), 'en TODOS LOS HILOS se ve a qué proyecto pertenece cada uno');
  await w.keyboard.press('Escape');

  // Móvil conectado al mismo puente: recibe habilidades y proyectos
  const info = await w.evaluate(() => window.neuraDesktop.bridge());
  const b = await chromium.launch(); const m = await b.newPage();
  m.on('pageerror', (e) => { console.log('PAGEERROR móvil', e.message); failures++; });
  const link = `http://127.0.0.1:${info.port}/#pair=${Buffer.from(JSON.stringify({ u: `http://127.0.0.1:${info.port}/mcp`, t: info.token, n: 'pc' })).toString('base64url')}`;
  await m.goto(link);
  await m.waitForFunction(() => JSON.parse(localStorage.getItem('neura.v1') || '{}').skills?.length === 1 && JSON.parse(localStorage.getItem('neura.v1') || '{}').projects?.length === 1, null, { timeout: 10000 })
    .then(() => ok(true, 'el móvil recibe la habilidad y el proyecto del PC'), () => ok(false, 'sync habilidades/proyectos'));
  await m.click('#btnThreads');
  await m.click('#threadList .chatItem:has-text("capítulo 1") span');
  ok((await m.textContent('#btnSkills')).includes('APUNTES'), 'al abrir el hilo en el móvil la habilidad está disponible y activa');

  // Borrar la habilidad en el móvil → desaparece en el PC
  await m.click('#btnSkills');
  m.on('dialog', (d) => d.accept());
  await m.click('[data-sk=del]');
  await m.waitForTimeout(1500);
  await w.click('#btnThreads'); await w.waitForTimeout(1500); await w.keyboard.press('Escape');
  await w.click('#btnSkills'); await w.waitForTimeout(300);
  ok((await w.$$('#skillList .card')).length === 0, 'borrar una habilidad en el móvil la borra también en el PC');
  await b.close(); await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
