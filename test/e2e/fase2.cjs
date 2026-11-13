// Sugerencias de habilidades, configuración guiada, capacidades, PDF (páginas y escaneados), consejo revisable, ramas y edición.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const FIX = path.join(__dirname, 'fixtures');
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const idle = (w) => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'), null, { timeout: 20000 });
const send = async (w, t) => { await w.fill('#input', t); await w.click('#send'); await idle(w); };
const setT = (w, k) => w.evaluate((k) => { const s = document.querySelector('#target'); s.value = k; s.dispatchEvent(new Event('change')); }, k);
const launch = (UD) => _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
const lastQ = () => { const x = mocks.log.filter((l) => l.model).at(-1); return x; };

(async () => {
  await mocks.start();

  // --- Configuración guiada (sin ninguna IA) ---
  const UD0 = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
  let app = await launch(UD0); let w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('.wizard', { timeout: 15000 });
  ok(true, 'sin IAs, la pantalla de inicio muestra el asistente de configuración');
  await w.selectOption('#wzPreset', 'groq');
  ok((await w.getAttribute('#wzKey', 'href')).includes('console.groq.com'), 'el enlace de la clave cambia según la IA elegida');
  await w.selectOption('#wzPreset', 'gemini');
  await w.evaluate("PRESETS.gemini.baseUrl = 'http://127.0.0.1:5601/v1'"); // simulador en lugar de Google
  await w.fill('#wzApiKey', 'clave-de-prueba');
  await w.click('#wzGo');
  await w.waitForFunction(() => !document.querySelector('.wizard'), null, { timeout: 15000 }).catch(() => {});
  const tgt = await w.$eval('#target', (s) => s.selectedOptions[0]?.textContent || '');
  ok(/Gemini \/ gemini-flash-latest/.test(tgt) && !(await w.$('.wizard')), 'CONECTAR Y PROBAR: descarga modelos, prueba y deja Gemini Flash elegida: ' + tgt);
  await app.close();

  // --- Resto de funciones ---
  const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
  fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
    providers: [{ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido', 'ciega', 'vision'], enabled: true }],
    mcp: [], threads: [], target: 'm::rapido', autoSkip: true,
    skills: [{ id: 'sk1', name: 'apuntes de estudio', description: 'Resume apuntes y genera preguntas de repaso', instructions: '1. Resume. 2. Pregunta.', version: 1, updatedAt: 1 }],
  }));
  app = await launch(UD); w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => [...document.querySelectorAll('#target option')].some((o) => o.textContent.includes('ESTE PC')), null, { timeout: 20000 });

  // Sugerencias
  await w.fill('#input', 'hazme un resumen de estos apuntes de biología');
  await w.waitForSelector('#skillHint:not([hidden])', { timeout: 3000 }).then(() => ok(true, 'al escribir algo que encaja, se sugiere la habilidad'), () => ok(false, 'sugerencia'));
  await w.click('[data-hint=use]');
  ok((await w.textContent('#btnSkills')).includes('APUNTES'), 'USAR la activa en el hilo');
  await w.click('#btnThreads'); await w.click('#newThread');
  await w.fill('#input', 'otro resumen de apuntes');
  await w.waitForSelector('#skillHint:not([hidden])');
  await w.click('[data-hint=no]');
  await w.fill('#input', 'y otro resumen de apuntes más'); await w.waitForTimeout(500);
  ok(await w.$('#skillHint[hidden]') && !(await w.textContent('#btnSkills')).includes('APUNTES'), 'NO la descarta en ese hilo y no vuelve a sugerirla');
  await w.fill('#input', 'qué tiempo hace hoy'); await w.waitForTimeout(500);
  await w.click('#btnThreads'); await w.click('#newThread');
  await w.fill('#input', 'qué tiempo hace hoy en Madrid'); await w.waitForTimeout(500);
  ok(!!(await w.$('#skillHint[hidden]')), 'un mensaje que no encaja no sugiere nada');
  await w.fill('#input', '');

  // Capacidades
  await setT(w, 'm::ciega');
  await w.setInputFiles('#fileIn', path.join(FIX, 'foto.png'));
  await w.waitForSelector('#attachBar .chip');
  await send(w, 'qué ves');
  let log = await w.$eval('#log', (l) => l.innerText);
  ok(/no admite imágenes\.? → probando otra IA/.test(log) && !/ciega responde/.test(log), 'un modelo sin visión rechaza la foto → salta a otro modelo');
  const ciega1 = mocks.calls.ciega;
  await w.setInputFiles('#fileIn', path.join(FIX, 'foto.png'));
  await w.waitForSelector('#attachBar .chip');
  await send(w, 'y esta');
  ok(mocks.calls.ciega === ciega1 && /📷 no admite imágenes/.test(await w.$eval('#log', (l) => l.innerText)), 'la siguiente foto ya no se manda al modelo sin visión');
  await send(w, 'ahora solo texto');
  ok(mocks.calls.ciega === ciega1 + 1, 'ese modelo sigue usándose para texto (no queda pausado)');

  // PDF con páginas y PDF escaneado
  await setT(w, 'm::vision');
  await w.setInputFiles('#fileIn', path.join(FIX, 'factura.pdf'));
  await w.waitForSelector('#attachBar .chip', { timeout: 15000 });
  await send(w, 'resume la factura');
  const reqPdf = JSON.stringify(mocks.log.filter((x) => x.model === 'vision').at(-1));
  const pdfReply = await w.$$eval('#log .reply', (r) => r.at(-1).innerText);
  ok(/PDF:sí/.test(pdfReply) && /cita la página/.test(mocks.log.filter((x) => x.model === 'vision').at(-1).q) && /pág\. 1/.test(mocks.log.filter((x) => x.model === 'vision').at(-1).q), 'PDF con texto: se envía con marcas de página y la indicación de citarlas · ' + pdfReply.split('\n').pop());
  await w.setInputFiles('#fileIn', path.join(FIX, 'escaneado.pdf'));
  await w.waitForFunction(() => [...document.querySelectorAll('#attachBar .chip')].some((c) => /pág\. 1/.test(c.textContent)), null, { timeout: 15000 })
    .then(() => ok(true, 'PDF escaneado: sus páginas se adjuntan como imágenes'), () => ok(false, 'PDF escaneado'));
  await send(w, 'qué pone');
  ok(/IMAGEN:sí/.test(await w.$$eval('#log .reply', (r) => r.at(-1).innerText)), 'la IA con visión recibe la página escaneada');

  // Consejo revisable
  await setT(w, 'm::rapido');
  await w.check('#council');
  await send(w, 'pregunta para el consejo');
  ok(mocks.log.some((x) => x.model && /Desacuerdos y puntos a comprobar/.test(x.q || '')), 'CONSEJO: la síntesis debe terminar con «⚠️ Desacuerdos y puntos a comprobar»');
  await w.uncheck('#council');

  // CONSEJO con miembros elegidos a mano: el modelo sin visión queda fuera cuando el mensaje lleva una foto
  await w.evaluate(() => { S.councilKeys = ['m::ciega', 'm::vision', 'm::rapido']; save(); });
  await w.check('#council');
  const ciega2 = mocks.calls.ciega;
  await w.setInputFiles('#fileIn', path.join(FIX, 'foto.png'));
  await w.waitForSelector('#attachBar .chip');
  await send(w, 'consejo manual con foto');
  const members = await w.$$eval('#log .council', (c) => [...c.at(-1).querySelectorAll('.cgrid .reply .tag span:first-child')].map((x) => x.textContent));
  ok(mocks.calls.ciega === ciega2 && !members.some((x) => /ciega/.test(x)) && members.length >= 2, 'CONSEJO manual: con foto se excluye al miembro sin visión · ' + members.join(' | '));
  await w.uncheck('#council');
  await w.evaluate(() => { S.councilKeys = []; save(); });

  // Ramas y edición
  const before = await w.evaluate('thread().messages.length');
  const firstUser = await w.evaluate("thread().messages.find((m) => m.role === 'user').content");
  await w.click('#log .reply:not(.err) [data-branch]');
  const br = await w.evaluate('({ title: thread().title, n: thread().messages.length, count: S.threads.length })');
  ok(br.title.startsWith('⑂') && br.n < before, `⑂ RAMA: hilo nuevo con la conversación hasta ese mensaje (${br.n} de ${before})`);
  await w.click('#log .msg.user [data-edit]');
  ok((await w.inputValue('#input')) === firstUser && await w.evaluate('thread().messages.length') === 0, '✎ EDITAR: rama sin ese mensaje y su texto listo en la caja');
  await w.click('#btnThreads'); await w.waitForTimeout(300);
  ok((await w.$$('#threadList .chatItem')).length >= 3, 'el hilo original se conserva junto a sus ramas');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
