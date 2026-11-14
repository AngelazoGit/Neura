// Búsqueda en internet con fuentes, registro de privacidad por hilo y tareas por lotes.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [{ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido'], enabled: true }],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true, level: 'pro', wizardDone: true,
  skills: [{ id: 'sk1', name: 'Resumir acta', description: 'Resume actas', instructions: 'Resume en 3 viñetas.', version: 1, updatedAt: 1 }],
}));
// SearXNG simulado: resultados con HTML en los extractos.
const queries = [];
const searx = http.createServer((req, res) => {
  const q = new URL(req.url, 'http://x').searchParams.get('q'); queries.push(q);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ results: [
    { title: 'Mundial <b>2026</b>', url: 'https://deportes.example/mundial', content: 'La final fue el <strong>19 de julio</strong>.' },
    { title: 'Crónica', url: 'https://noticias.example/cronica', content: 'Resumen del partido.' },
    { title: 'Malo', url: 'javascript:alert(1)', content: 'no debe salir' }] }));
});

(async () => {
  await mocks.start();
  await new Promise((r) => searx.listen(5605, '127.0.0.1', r));
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD, '--lang=es-ES'] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => typeof S !== 'undefined' && S.mcp[0]?.status === 'on', null, { timeout: 20000 });
  const idle = () => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg').length > 0, null, { timeout: 30000 });
  const sendMsg = async (t) => { await w.fill('#input', t); await w.click('#send'); await idle(); };

  // ---- 1. Búsqueda en internet con fuentes ----
  ok(await w.isHidden('#webLbl'), 'sin buscador, 🌐 WEB no aparece');
  await w.click('#btnAis');
  await w.selectOption('#searchType', 'searxng');
  await w.fill('#searchUrl', 'http://127.0.0.1:5605'); await w.$eval('#searchUrl', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await w.click('#searchTest');
  await w.waitForFunction(() => /✓ 2 resultados/.test(document.querySelector('#toast').textContent), null, { timeout: 10000 })
    .then(() => ok(true, 'PROBAR BÚSQUEDA confirma que el buscador funciona'), async () => ok(false, 'probar búsqueda · ' + await w.textContent('#toast')));
  await w.keyboard.press('Escape');
  ok(await w.isVisible('#webLbl'), 'con buscador, aparece 🌐 WEB en la barra');
  await w.check('#web');
  const n0 = mocks.log.length;
  await sendMsg('¿Cuándo fue la final del Mundial 2026?');
  const sent = mocks.log.slice(n0).find((x) => x.model === 'rapido');
  ok(queries.at(-1) === '¿Cuándo fue la final del Mundial 2026?' && /Resultados de una búsqueda en internet/.test(sent?.q) && /\[1\] Mundial 2026 — https:\/\/deportes\.example\/mundial/.test(sent?.q) && /cítalas/.test(sent?.q),
    'busca antes de preguntar y la IA recibe las fuentes numeradas con la orden de citarlas');
  ok(/19 de julio/.test(sent.q) && !/<strong>|<b>/.test(sent.q) && !/javascript:/.test(sent.q), 'los extractos llegan como texto limpio y los enlaces que no son web se descartan');
  ok(/🌐 2 fuentes de internet/.test(await w.textContent('#log')) && await w.getAttribute('.sources a', 'href') === 'https://deportes.example/mundial', 'el mensaje muestra las fuentes con sus enlaces');
  await new Promise((r) => searx.close(r));
  await sendMsg('Otra pregunta sin buscador');
  ok(/Sin búsqueda:/.test(await w.textContent('#log')) && /Hola desde rapido: Otra pregunta/.test(await w.textContent('#log')), 'si el buscador falla, se avisa y la IA responde igualmente');
  await w.uncheck('#web');
  // Un buscador externo (Brave) no se usa en hilos privados.
  await w.evaluate(() => { S.search = { type: 'brave', key: 'x' }; thread().private = true; renderTargets(); });
  ok(await w.isHidden('#webLbl'), 'en un hilo 🔒 PRIVADO, un buscador de internet (Brave) no se ofrece');
  await w.evaluate(() => { S.search = { type: 'searxng', url: 'http://127.0.0.1:5605' }; renderTargets(); });
  ok(await w.isVisible('#webLbl'), '…pero un SearXNG de tu equipo sí');
  await w.evaluate(() => { thread().private = false; S.search = {}; save(); renderTargets(); });

  // ---- 2. Registro de privacidad ----
  await w.setInputFiles('#fileIn', path.join(__dirname, 'fixtures/foto.png'));
  await w.waitForSelector('#attachBar:not([hidden])');
  await sendMsg('Describe la foto');
  await w.click('#btnAis'); await w.click('#diagRun');
  await w.waitForFunction(() => /funcionan ahora/.test(document.querySelector('#diagOut')?.textContent || ''), null, { timeout: 30000 });
  await w.keyboard.press('Escape');
  await w.click('#btnThreads'); await w.click('#auditBtn');
  const au = await w.textContent('#auditOut');
  ok(/MOCK/.test(au) && /127\.0\.0\.1:5601/.test(au) && /3 envíos/.test(au) && !/Neura inteligencia artificial/.test(au), 'el registro agrupa los envíos por destino (las pruebas de conexión y PROBAR BÚSQUEDA no cuentan) · ' + au.replace(/\s+/g, ' '));
  ok(/búsqueda: «¿Cuándo fue la final/.test(au) && /SearXNG/.test(au), 'incluye las búsquedas y adónde fueron');
  ok(/Adjuntos: .*foto\.png/.test(au), 'y qué adjuntos se enviaron');
  ok(/Nada de este hilo ha salido a internet/.test(au), 'todo fue a servicios de tu equipo (127.0.0.1): lo dice claramente');
  ok(await w.evaluate(() => {
    S.providers.push({ id: 'g', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', models: [] });
    auditTarget({ pid: 'g', model: 'llama', label: 'Groq / llama' }, 'mensaje', [{ role: 'user', content: 'hola [Archivo adjunto: acta.pdf — al usar su contenido…]' }]);
    const h = auditHTML(); S.providers.pop(); return /api\.groq\.com/.test(h) && /INTERNET/.test(h) && /1<\/b> servicio de internet/.test(h) && /acta\.pdf/.test(h);
  }), 'una IA de internet aparece marcada como INTERNET y se cuenta en el resumen');
  await w.keyboard.press('Escape');

  // ---- 3. Tareas por lotes ----
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lote-'));
  const largo = Array.from({ length: 60 }, (_, i) => `Párrafo ${i + 1}. ` + 'texto del acta '.repeat(40)).join('\n\n');
  fs.writeFileSync(path.join(dir, 'acta-larga.txt'), largo);
  fs.writeFileSync(path.join(dir, 'acta-corta.md'), 'Reunión breve: se aprueba el presupuesto.');
  await w.evaluate(() => { S.ctxTokens = 3000; save(); });
  await w.click('#btnSkills');
  await w.evaluate(() => { batchSkill = 'sk1'; });
  const n1 = mocks.log.length;
  await w.setInputFiles('#batchFile', [path.join(dir, 'acta-larga.txt'), path.join(dir, 'acta-corta.md')]);
  await w.waitForFunction(() => thread().batch && !busy && batchState(thread()).every((x) => x.done), null, { timeout: 60000 })
    .then(() => ok(true, 'el lote se procesa entero'), () => ok(false, 'lote completo'));
  const st = await w.evaluate(() => { const th = thread(); return { title: th.title, items: batchState(th).map((x) => x.m.content), order: th.messages.map((m) => m.role[0]).join('') }; });
  const parts = st.items.filter((x) => /acta-larga\.txt \(parte \d+\/\d+\)/.test(x)).length;
  ok(parts >= 3 && st.items.includes('📄 acta-corta.md') && st.title === '📦 Resumir acta · 2 archivos', `el documento largo se divide en partes (${parts}) y cada archivo es una tarea · ${st.items.length} tareas`);
  ok(/^(ua)+$/.test(st.order), 'cada respuesta queda justo debajo de su archivo · ' + st.order);
  const reqs = mocks.log.slice(n1).filter((x) => x.model === 'rapido');
  ok(reqs.length === st.items.length && reqs.every((x) => x.n === 2 && /Resume en 3 viñetas/.test(x.system.join(' '))), 'cada tarea va sola (sin el resto del hilo) y con la habilidad');
  ok(/📦 LOTE · ✦ Resumir acta/.test(await w.textContent('.card.batch')) && /(\d+)\/\1/.test(await w.textContent('.card.batch .badge')), 'la tarjeta del lote muestra el progreso completo · ' + await w.textContent('.card.batch'));
  // PARAR y CONTINUAR
  await w.evaluate(() => { batchSkill = 'sk1'; });
  await w.setInputFiles('#batchFile', [path.join(dir, 'acta-larga.txt')]);
  await w.waitForFunction(() => batchState(thread()).filter((x) => x.done).length >= 1, null, { timeout: 30000 });
  await w.evaluate(() => abortCtl?.abort());
  await w.waitForFunction(() => !busy, null, { timeout: 15000 });
  const mid = await w.evaluate(() => { const s = batchState(thread()); return [s.filter((x) => x.done).length, s.length]; });
  ok(mid[0] < mid[1] && await w.isVisible('#batchGo'), `PARAR deja el lote a medias (${mid[0]}/${mid[1]}) con CONTINUAR`);
  await w.click('#batchGo');
  await w.waitForFunction(() => !busy && batchState(thread()).every((x) => x.done), null, { timeout: 60000 })
    .then(() => ok(true, 'CONTINUAR termina los que faltaban'), () => ok(false, 'continuar'));
  ok(await w.evaluate(() => /^(ua)+$/.test(thread().messages.filter((m) => !m.error).map((m) => m.role[0]).join(''))), '…sin duplicar respuestas ni desordenar');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
