// Máscaras (apariencia) e inicio con «¿Qué quieres hacer?» y los hilos recientes (web, en Chromium).
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os');
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const user = (extra) => ({
  providers: [{ id: 'g', preset: 'groq', name: 'Groq', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', models: ['rapido'], enabled: true }],
  threads: [{ id: 't1', title: 'Contrato de alquiler', messages: [{ id: 'a', role: 'user', content: 'Hola', ts: 1 }], ts: Date.now() - 1000 }],
  active: null, target: 'g::rapido', autoSkip: true, level: 'pro', wizardDone: true, lang: 'es', ...extra,
});

(async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-br-'));
  const br = spawn(process.execPath, [path.join(__dirname, '../../bridge/server.mjs')], { env: { ...process.env, PORT: '8796', HOST: '127.0.0.1', NEURA_TOKEN: 'x'.repeat(24), NEURA_DATA: data, NEURA_CONFIG: '/nonexistent.json' } });
  await new Promise((r) => br.stdout.on('data', (d) => String(d).includes('Backends') && r()));
  const b = await chromium.launch();
  const page = async (state) => {
    const ctx = await b.newContext({ locale: 'es-ES' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
    if (state) await p.addInitScript((s) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('neura.v1', JSON.stringify(s)); sessionStorage.setItem('seeded', '1'); } }, state);
    await p.goto('http://127.0.0.1:8796/');
    await p.waitForFunction(() => typeof S !== 'undefined');
    return p;
  };
  const mask = (p) => p.evaluate(() => document.documentElement.dataset.mask);

  // ---- Por defecto: quien empieza, Serio; quien ya usaba Neura, su aspecto de siempre (Mando) ----
  let p = await page(null);
  ok(await mask(p) === 'serio' && !!(await p.$('.wizard .masks')), 'un usuario nuevo empieza con la máscara Serio y puede cambiarla desde la bienvenida');
  await p.context().close();
  p = await page(user({}));
  ok(await mask(p) === 'mando', 'quien ya usaba Neura conserva su aspecto (Mando)');

  // ---- Cambiar de máscara: al momento, sin recargar, y se recuerda ----
  await p.click('#btnAis');
  await p.click('#settings [data-maskset=limpio]');
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(await mask(p) === 'limpio' && bg === 'rgb(245, 245, 247)' && await p.$eval('#settings [data-maskset=limpio]', (x) => x.classList.contains('on')), 'en ⚙ → APARIENCIA, Limpio se aplica al momento (fondo claro)');
  ok(await p.evaluate(() => getComputedStyle(document.querySelector('.stripe')).display) === 'none', 'fuera de Mando no hay franja ni efectos de pantalla antigua');
  await p.reload(); await p.waitForFunction(() => typeof S !== 'undefined');
  ok(await mask(p) === 'limpio', 'la máscara elegida se recuerda al volver a abrir');

  // ---- Inicio: tarjetas e hilos recientes ----
  await p.keyboard.press('Escape');
  await p.evaluate(() => { S.active = null; renderLog(); });
  ok((await p.$$('.homeCard')).length === 8 && /¿Qué quieres hacer\?/.test(await p.textContent('.home')), 'el inicio muestra «¿Qué quieres hacer?» con sus tarjetas');
  await p.click('[data-home=council]');
  ok(await p.evaluate(() => S.council && document.querySelector('#council').checked), '«Comparar varias IAs» activa el CONSEJO');
  await p.click('[data-home=web]');
  ok(/Elige un buscador/.test(await p.textContent('#toast')) && await p.evaluate(() => document.querySelector('#sheetAis').classList.contains('open')), '«Buscar en internet» sin buscador explica dónde configurarlo y abre ⚙');
  await p.keyboard.press('Escape');
  await p.click('[data-home=tpl]');
  ok(await p.evaluate(() => document.querySelector('#sheetTpl').classList.contains('open')), '«Usar una plantilla» abre las Plantillas PRO');
  await p.keyboard.press('Escape');
  await p.click('[data-tid-open=t1]');
  ok(await p.evaluate(() => S.active === 't1') && /Hola/.test(await p.textContent('#log')), 'un hilo reciente se abre con un toque');
  await p.context().close();

  // ---- Principiante: sin la tarjeta del CONSEJO (opción avanzada) ----
  p = await page(user({ level: 'basic' }));
  ok(!(await p.$('[data-home=council]')) && (await p.$$('.homeCard')).length === 7, 'en modo principiante no se ofrece el CONSEJO en el inicio');
  await b.close(); br.kill();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
