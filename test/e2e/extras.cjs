// Funciones nuevas: memoria personal, órdenes «/», hilos fijados y con etiquetas, a ciegas, cuotas y ahorro,
// biblioteca del proyecto, vista previa, tareas en pasos, atajo rápido, captura de pantalla y tareas programadas.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const P = (id, name, models) => ({ id, preset: 'groq', name, kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models, enabled: true });
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [P('m', 'MOCK', ['rapido', 'svg']), P('n', 'OTRA', ['lento'])],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true, level: 'pro', wizardDone: true, mask: 'serio',
}));

(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD, '--lang=es-ES'] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await app.evaluate(({ shell }) => { global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); }; });
  await w.waitForFunction(() => typeof S !== 'undefined' && document.querySelector('.home'), null, { timeout: 20000 });
  const idle = () => w.waitForFunction(() => !busy && !document.querySelector('.reply.pending'), null, { timeout: 30000 });
  const sendText = async (t) => { await w.fill('#input', t); await w.click('#send'); await w.waitForTimeout(150); await idle(); };
  const lastReq = () => mocks.log.filter((x) => x.model).at(-1);
  const newThread = () => w.evaluate(() => { S.active = null; save(); renderLog(); });

  // ---- 1. Memoria personal ----
  await w.click('#btnAis');
  await w.fill('#profileText', 'Soy enfermera y prefiero respuestas cortas.');
  await w.keyboard.press('Escape');
  await sendText('Hola');
  ok(lastReq().system.join(' ').includes('Sobre el usuario') && lastReq().system.join(' ').includes('Soy enfermera'), 'la memoria personal llega a la IA en cada pregunta');
  await w.click('#btnAis'); await w.uncheck('#profileOn'); await w.keyboard.press('Escape');
  await sendText('Otra');
  ok(!lastReq().system.join(' ').includes('Soy enfermera'), '…y se puede desactivar');

  // ---- 4. Órdenes con «/» ----
  await w.fill('#input', '/'); await w.dispatchEvent('#input', 'input');
  await w.waitForTimeout(600); // los consejos al escribir llegan después y no deben taparla
  ok(await w.isVisible('#skillHint') && /\/resumir/.test(await w.textContent('#skillHint')) && /\/pasos/.test(await w.textContent('#skillHint')), 'al escribir «/» se ven las órdenes disponibles (y no las tapan los consejos)');
  await sendText('/traducir francés: buenos días');
  ok(/Idioma de destino: francés/.test(lastReq().q) && /buenos días/.test(lastReq().q), '/traducir francés: … pide la traducción al francés');
  await sendText('/tabla');
  ok(/^Organiza esta información en una tabla/.test(lastReq().q) && /Hola desde rapido/.test(lastReq().q), '/tabla sin texto se aplica a la última respuesta');
  ok(/\/tabla \(la última respuesta\)/.test(await w.textContent('#log')), '…y en el chat se ve la orden, no el texto largo');

  // ---- 6. A ciegas ----
  await newThread();
  await sendText('/ciegas ¿Qué es la fotosíntesis?');
  let blind = await w.$$eval('.blindSet .reply', (r) => r.map((x) => x.querySelector('.tag').innerText));
  ok(blind.length === 2 && blind.every((t) => /Respuesta [AB]/.test(t)) && !blind.some((t) => /MOCK|OTRA/.test(t)), 'a ciegas: dos respuestas «A» y «B» sin decir de qué IA son');
  await w.click('.blindSet [data-vote]');
  blind = await w.$$eval('.blindSet .reply', (r) => r.map((x) => x.querySelector('.tag').innerText));
  ok(blind.some((t) => /MOCK/.test(t)) && blind.some((t) => /OTRA/.test(t)) && await w.evaluate(() => Object.values(S.votes || {}).some((v) => Object.keys(v).length)), 'al elegir la mejor se revela cuál era cada una y el voto cuenta para el enrutado');

  // ---- 11. Tarea en varios pasos ----
  await newThread();
  const n0 = mocks.log.length;
  await sendText('/pasos Escribe una nota sobre el reciclaje');
  const chips = await w.$$eval('.chip.step', (c) => c.map((x) => x.innerText));
  ok(chips.length === 4 && /Plan/.test(chips[0]) && /Paso 1\/2 · Reunir datos/.test(chips[1]) && /Paso 2\/2 · Redactar el texto/.test(chips[2]) && /Resultado final/.test(chips[3]), `tarea en pasos: plan, cada paso y resultado final · ${chips.join(' | ')}`);
  const stepReqs = mocks.log.slice(n0).filter((x) => x.model);
  ok(stepReqs.length === 4 && /Lo hecho hasta ahora/.test(stepReqs[2].q) && /Entrega el resultado final/.test(stepReqs[3].q), 'cada paso recibe lo hecho antes y el último revisa y entrega');

  // ---- 10. Vista previa ----
  await newThread();
  await w.evaluate(() => { S.target = 'm::svg'; save(); renderTargets(); });
  await sendText('Dibuja un círculo');
  ok(!!(await w.$('.reply .preview img[src^="data:image/svg+xml"]')), 'un dibujo SVG se ve dentro de Neura');
  await w.click('[data-openhtml]');
  await w.waitForTimeout(400);
  const opened = await app.evaluate(() => global.__opened.at(-1) || '');
  ok(/^file:.*neura-[0-9a-f]+\.html$/.test(opened) && /<h1>Hola<\/h1>/.test(fs.readFileSync(new URL(opened), 'utf8')), 'una página HTML se abre en el navegador del PC');
  await w.evaluate(() => { S.target = 'm::rapido'; save(); renderTargets(); });

  // ---- 9. Biblioteca del proyecto ----
  const doc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')), 'manual-caldera.txt');
  fs.writeFileSync(doc, 'Introducción general.\n\nPara purgar la caldera, abre la válvula roja durante diez segundos con el circuito frío.');
  await w.evaluate(() => { const p = { id: 'pr1', name: 'Casa', memory: '', ts: Date.now() }; S.projects.push(p); S.project = 'pr1'; S.active = null; thread().project = 'pr1'; save(); });
  await w.click('#btnThreads');
  await w.setInputFiles('#libFile', doc);
  await w.waitForFunction(() => (S.library?.pr1 || []).length === 1, null, { timeout: 10000 });
  ok(/manual-caldera\.txt/.test(await w.textContent('#projectCard')), 'la biblioteca del proyecto lista el documento añadido');
  await w.keyboard.press('Escape');
  await sendText('¿Cómo purgar la caldera?');
  ok(/FRAGMENTOS DE LOS DOCUMENTOS DEL PROYECTO/.test(lastReq().q) && /válvula roja/.test(lastReq().q) && /manual-caldera\.txt/.test(lastReq().q), 'en los hilos del proyecto, la IA recibe el fragmento que encaja con la pregunta');
  ok(/Consultado en la biblioteca/.test(await w.textContent('#log')), '…y el mensaje muestra qué documento se consultó');
  await sendText('Dime un chiste');
  ok(!/FRAGMENTOS DE LOS DOCUMENTOS/.test(lastReq().q), 'si la pregunta no tiene nada que ver, no se envía ningún fragmento');
  await w.evaluate(() => { S.project = null; save(); });

  // ---- 5. Fijar y etiquetar hilos ----
  await w.click('#btnThreads');
  const first = await w.$eval('#threadList .chatItem:last-child', (x) => x.dataset.tid);
  await w.click(`[data-pin="${first}"]`);
  ok(await w.$eval('#threadList .chatItem', (x) => x.dataset.tid) === first && /📌/.test(await w.textContent('#threadList .chatItem')), 'un hilo fijado sube arriba con 📌');
  await w.click(`[data-tags="${first}"]`);
  await w.fill('.tagIn', 'trabajo, idiomas'); await w.press('.tagIn', 'Enter');
  ok(/#trabajo/.test(await w.textContent('#threadList')), 'las etiquetas se ven en la lista');
  await w.fill('#threadSearch', '#trab'); await w.dispatchEvent('#threadSearch', 'input');
  ok((await w.$$('#threadList .chatItem')).length === 1, 'buscar «#trab» deja solo los hilos con esa etiqueta');
  await w.fill('#threadSearch', ''); await w.dispatchEvent('#threadSearch', 'input');
  await w.keyboard.press('Escape');

  // ---- 7 y 8. Cuotas y ahorro ----
  await w.click('#btnAis');
  const panel = await w.textContent('#usagePanel');
  ok(/CUOTA GRATIS DE HOY/.test(panel) && /MOCK/.test(panel) && /Ahora conviene usar/.test(panel), 'consumo: cuota gratis de hoy por IA y cuál conviene usar ahora');
  ok(/habría costado unos/.test(panel), '…y lo que habría costado con un modelo de pago');
  await w.keyboard.press('Escape');

  // ---- 2. Atajo rápido ----
  ok(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('CommandOrControl+Shift+Space')), 'atajo global Ctrl+Mayús+Espacio registrado');
  await newThread();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('quick', 'El informe trimestral muestra un aumento de ventas.'));
  await w.waitForSelector('[data-quick=resumir]');
  ok(!/informe trimestral/.test(await w.textContent('#skillHint')) && /caracteres/.test(await w.textContent('#skillHint')), 'el atajo no enseña en pantalla lo copiado (podría ser una contraseña), solo su tamaño');
  await w.click('[data-quick=resumir]'); await w.waitForTimeout(150); await idle();
  ok(/^Resume en 5 puntos clave/.test(lastReq().q) && /informe trimestral/.test(lastReq().q), 'con lo copiado, un toque lo resume');

  // ---- 3. Captura de pantalla ----
  ok(await w.isVisible('#shotBtn'), 'en el PC hay botón 📸 de captura');
  await app.evaluate(({ ipcMain, nativeImage }) => { ipcMain.removeHandler('capture-screen'); ipcMain.handle('capture-screen', () => 'data:image/jpeg;base64,' + nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==').resize({ width: 64, height: 64 }).toJPEG(80).toString('base64')); });
  await w.click('#shotBtn');
  await w.waitForFunction(() => attach.length === 1, null, { timeout: 5000 }).catch(() => {});
  ok(await w.evaluate(() => attach[0]?.kind === 'image' && /^captura-/.test(attach[0].name)), 'la captura queda adjunta como imagen para preguntar · ' + await w.textContent('#toast'));
  await w.evaluate(() => { attach = []; renderAttach(); });

  // ---- 12. Tareas programadas ----
  await w.click('#btnAis');
  await w.fill('#schName', 'Resumen diario'); await w.fill('#schPrompt', 'Dame el resumen del día');
  await w.fill('#schTime', '00:00'); await w.click('#schAdd');
  ok(/Resumen diario/.test(await w.textContent('#settings')), 'se programa una tarea con nombre, qué pedir y hora');
  ok(await w.evaluate(() => dueSchedules().length === 0 && S.schedules[0].last === today()), 'creada después de su hora, no se hace hasta mañana');
  await w.evaluate(() => { S.schedules[0].last = '2000-01-01'; }); // como si fuera el día siguiente
  ok(await w.evaluate(() => dueSchedules().length === 1), 'al día siguiente, a su hora, queda pendiente de hacerse');
  await w.keyboard.press('Escape');
  const back = await w.evaluate(() => S.active);
  await w.evaluate(() => runSchedule(dueSchedules()[0]));
  await idle();
  const sch = await w.evaluate(() => { const x = S.schedules[0], t = S.threads.find((y) => y.id === x.tid); return { title: t?.title, ans: t?.messages.some((m) => m.role === 'assistant' && /Hola desde/.test(m.content)), last: x.last, due: dueSchedules().length, active: S.active }; });
  ok(sch.title === '⏰ Resumen diario' && sch.ans && sch.due === 0, `se hace en su propio hilo ⏰ y no se repite ese día · ${JSON.stringify(sch)}`);
  ok(sch.active === back, '…y te deja en el hilo en el que estabas');

  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
