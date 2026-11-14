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

  // ---- 4. Consejos mientras escribes y ✨ ESTRUCTURAR ----
  await w.evaluate(() => { S.active = null; save(); renderLog(); });
  await w.fill('#input', 'escribe un correo');
  await w.waitForFunction(() => /Para una respuesta mejor/.test(document.querySelector('#skillHint').textContent) && !document.querySelector('#skillHint').hidden);
  const tip = await w.textContent('#skillHint');
  ok(/para quién/.test(tip) && /tono/.test(tip), 'mientras escribes una petición vaga, sugiere qué añadir (sin usar IA) · ' + tip.replace(/\s+/g, ' ').slice(0, 90));
  const before = mocks.log.length;
  await w.click('[data-assist=struct]');
  await w.waitForFunction(() => /\*\*Rol:\*\*/.test(document.querySelector('#input').value), null, { timeout: 15000 });
  ok(/\[completa: para quién es\]/.test(await w.inputValue('#input')) && mocks.log.length === before + 1 && (await w.evaluate(() => thread().messages.length)) === 0,
    '✨ ESTRUCTURAR convierte la petición en una profesional (Rol, Objetivo, Formato…) en la caja, sin enviarla');
  ok(/DESHACER/.test(await w.textContent('#skillHint')), 'avisa de rellenar los huecos y deja DESHACER');
  await w.click('[data-assist=undo]');
  ok(await w.inputValue('#input') === 'escribe un correo', 'DESHACER recupera lo que habías escrito');
  await w.fill('#input', 'escribe un correo con mi DNI 12345678Z');
  await w.click('#structBtn'); await w.click('[data-tpl=struct]');
  ok(/Quita los datos sensibles/.test(await w.textContent('#toast')) && mocks.log.length === before + 1, 'no estructura (no envía a la IA) si hay datos sensibles');
  await w.fill('#input', 'Redacta un correo formal para mi jefe en 5 líneas pidiendo vacaciones');
  await w.waitForTimeout(500);
  ok(await w.isHidden('#skillHint'), 'una petición completa no muestra consejos');

  // ---- 5. Aviso de actualidad ----
  await w.evaluate(() => { S.search = { type: 'searxng', url: 'http://127.0.0.1:9' }; renderTargets(); });
  await w.fill('#input', '¿Cuál es el precio del bitcoin hoy?');
  await w.waitForFunction(() => /Parece algo reciente/.test(document.querySelector('#skillHint').textContent));
  ok(!!(await w.$('[data-assist=web]')), 'si preguntas por algo reciente, avisa y ofrece buscar en internet');
  await w.click('[data-assist=web]'); await w.click('#send'); await idle();
  ok(/Sin búsqueda:/.test(await w.textContent('#log')), '…y ese mensaje intenta buscar (aquí el buscador está apagado y se avisa)');
  ok(!(await w.evaluate(() => S.web)), 'solo ese mensaje: 🌐 WEB no queda activado');
  await w.evaluate(() => { S.search = {}; renderTargets(); });

  // ---- 6. ¿Qué es esto? ----
  await w.click('#btnAis');
  await w.click('#settings h3 [data-help=contexto]');
  ok(/Contexto/.test(await w.textContent('#helpPop')) && /recuerda/.test(await w.textContent('#helpPop')) && await w.isVisible('#helpPop'), '«?» junto a cada apartado explica el término en lenguaje llano');
  await w.click('[data-helpclose]');
  ok(await w.isHidden('#helpPop'), 'ENTENDIDO lo cierra');
  ok(/GLOSARIO/.test(await w.textContent('#settings')) && (await w.$$('dl.gloss dt')).length >= 15, '⚙ incluye un glosario completo');
  const tipsBox = await w.isChecked('#tipsOn');
  await w.click('label:has(#tipsOn) [data-help]');
  ok(await w.isChecked('#tipsOn') === tipsBox, 'pulsar «?» dentro de una opción no la cambia');
  await w.click('[data-helpclose]');
  await w.keyboard.press('Escape');

  // ---- 7. ¿Por qué esta IA? ----
  await w.evaluate(() => { S.active = null; S.target = 'm::cuota'; save(); renderLog(); renderTargets(); });
  await sendMsg('Hola, prueba de motivo');
  const whyIds = await w.$$eval('[data-why]', (b) => b.map((x) => x.dataset.why));
  await w.click(`[data-why="${whyIds.at(-1)}"]`);
  const why = await w.textContent('#helpPop');
  ok(/AUTO-SALTO/.test(why) && /Cuota gratuita agotada/.test(why), 'ⓘ en la respuesta explica por qué contestó esa IA (aquí: la elegida agotó su cuota) · ' + why.replace(/\s+/g, ' ').slice(0, 120));
  await w.click('[data-helpclose]');
  await w.evaluate(() => { S.target = 'm::rapido'; S.health = {}; S.active = null; save(); renderLog(); renderTargets(); });
  await sendMsg('Otra prueba');
  await w.click(`[data-why="${(await w.$$eval('[data-why]', (b) => b.map((x) => x.dataset.why))).at(-1)}"]`);
  ok(/Es la IA que tienes elegida arriba/.test(await w.textContent('#helpPop')), '…o que es la que tienes elegida');
  await w.click('[data-helpclose]');

  // ---- 8. Plantillas PRO ----
  await w.evaluate(() => { S.active = null; save(); renderLog(); });
  ok((await w.$$('.quick [data-tplq]')).length === 7, 'la pantalla inicial ofrece atajos a las plantillas («¿Qué quieres hacer?»)');
  await w.click('.quick [data-tplq=correo]');
  await w.fill('#tplBody [data-f=para]', 'un cliente que se queja del retraso');
  await w.fill('#tplBody [data-f=objetivo]', 'disculparnos y proponer una nueva fecha');
  await w.selectOption('#tplBody [data-f=tono]', 'cordial');
  await w.click('[data-tpl=make]');
  const pr = await w.inputValue('#input');
  ok(/\*\*Rol:\*\* Actúa como redactor profesional/.test(pr) && /Para quién es: un cliente que se queja/.test(pr) && /Tono: cordial/.test(pr) && /\*\*Criterios de calidad:\*\*/.test(pr) && /pregúntala antes de responder/.test(pr),
    'el formulario monta una petición profesional (rol, objetivo, contexto, pasos, formato y criterios)');
  ok(!/\[completa:/.test(pr), 'con los campos obligatorios rellenos no quedan huecos');
  await w.fill('#input', '');
  await w.click('#structBtn');
  await w.click('[data-tpl=acta]'); await w.click('[data-tpl=make]');
  ok(/Notas o transcripción: \[completa: notas o transcripción\]/.test(await w.inputValue('#input')), 'un campo obligatorio vacío queda como hueco [completa: …]');
  await w.click('#structBtn'); await w.click('[data-tpl=decision]'); await w.click('[data-tpl=skill]');
  ok(await w.evaluate(() => liveSkills().some((k) => k.name === 'Analizar una decisión' && /Actúa como analista de decisiones/.test(k.instructions))), '✦ GUARDAR COMO HABILIDAD guarda el método para reutilizarlo');
  await w.keyboard.press('Escape');
  await w.fill('#input', 'quiero un post sobre mi tienda');
  await w.click('#structBtn');
  ok(/ESTRUCTURAR MI PETICIÓN/.test(await w.textContent('#tplBody')), 'si ya escribiste algo, ✨ ofrece estructurarlo');
  await w.keyboard.press('Escape');

  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
