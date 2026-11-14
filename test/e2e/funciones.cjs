// Importar historial (ChatGPT, Claude, Gemini), enrutado por tarea, votos en el CONSEJO y exportar a PDF.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const FX = path.join(__dirname, 'fixtures');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [{ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido', 'tabla'], enabled: true }],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true, level: 'pro', wizardDone: true,
}));

(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('#target option', { state: 'attached' });
  const idle = () => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg').length > 0);
  const sendMsg = async (t) => { await w.fill('#input', t); await w.click('#send'); await idle(); };
  const imp = async (f) => { await w.setInputFiles('#importFile', path.join(FX, f)); await w.waitForTimeout(800); return w.textContent('#toast'); };

  // ---- 7. Importar historial ----
  ok(/1 hilos importados de ChatGPT/.test(await imp('chatgpt-export.zip')), 'importa la exportación de ChatGPT directamente desde el .zip');
  const gpt = await w.evaluate(() => S.threads.find((t) => t.id === 'gpt-c-paella'));
  ok(gpt?.title === 'Receta de paella' && gpt.messages.map((m) => m.content).join('|') === '¿Cómo hago una paella valenciana?|Necesitas arroz bomba, pollo y conejo.|¿Y el sofrito?|Tomate rallado y pimentón.',
    'ChatGPT: sigue la rama visible (sin mensajes ocultos ni respuestas descartadas) y toma el texto de los mensajes con imagen');
  ok(gpt.messages[1].label === 'ChatGPT / gpt-4o' && gpt.source === 'ChatGPT', '…con el modelo que respondió y la procedencia');
  await imp('chatgpt-export.zip');
  ok(await w.evaluate(() => S.threads.filter((t) => t.id === 'gpt-c-paella').length === 1 && S.threads.find((t) => t.id === 'gpt-c-paella').messages.length === 4), 'importar dos veces no duplica hilos ni mensajes');
  ok(/de Claude/.test(await imp('claude-conversations.json')), 'importa conversations.json de Claude');
  ok(await w.evaluate(() => { const t = S.threads.find((x) => x.id === 'claude-conv-1'); return t.title === 'Plan de estudio' && t.messages[1].content === 'Divide el temario en bloques de 45 minutos.' && t.messages[1].label === 'Claude'; }), 'Claude: preguntas y respuestas (también con el texto en bloques)');
  ok(/de Gemini/.test(await imp('takeout-gemini.zip')), 'importa la actividad de Gemini de Google Takeout (.zip)');
  const gem = await w.evaluate(() => S.threads.filter((t) => t.source === 'Gemini').map((t) => ({ title: t.title, msgs: t.messages.map((m) => m.content) })));
  ok(gem.length === 1 && gem[0].title.startsWith('Gemini · 2026-09-15') && gem[0].msgs.length === 4 && /calor/.test(gem[0].msgs[1]) && !/<b>|<img/.test(gem[0].msgs[1]),
    'Gemini: un hilo por día con cada pregunta y su respuesta en texto (sin registros que no son preguntas ni actividad de otros productos)');
  ok(await w.evaluate(() => !window.__pwned), 'el HTML importado no ejecuta nada');
  await w.click('#btnThreads');
  ok(/↘ ChatGPT/.test(await w.textContent('#threadList')) && /↘ Claude/.test(await w.textContent('#threadList')), 'la lista de hilos indica de dónde viene cada uno');
  await w.click('#newThread');

  // ---- 8. Enrutado por tarea ----
  await w.click('#btnAis'); await w.check('#routeOn');
  await w.selectOption('[data-route=codigo]', 'm::tabla');
  await w.keyboard.press('Escape');
  const tabla0 = mocks.calls.tabla || 0;
  await sendMsg('Escríbeme una función en Python que sume dos números');
  ok(mocks.calls.tabla === tabla0 + 1 && /🧭 💻 Código → MOCK \/ tabla/.test(await w.textContent('#log')), 'una petición de código va a la IA asignada a «Código» y se indica en el mensaje');
  const r0 = mocks.calls.rapido || 0;
  await sendMsg('Hola, ¿qué tal?');
  ok(mocks.calls.rapido === r0 + 1, 'lo que no encaja en ningún tipo va a la IA elegida arriba');
  ok(await w.evaluate(() => taskOf('¿Por qué el cielo es azul?') === 'razonar' && taskOf('resume este texto') === 'resumen' && taskOf('```js\nx\n```') === 'codigo' && taskOf('redacta un correo a mi jefe') === 'redactar'), 'reconoce los tipos de petición (también con tildes)');

  // ---- 9. Votar en el CONSEJO ----
  await w.evaluate(() => { S.councilKeys = ['m::rapido', 'm::tabla']; S.council = true; save(); renderTargets(); });
  await sendMsg('Resume en una frase qué es la fotosíntesis');
  const btns = await w.$$('[data-vote]');
  ok(btns.length === 2 && !(await w.$('.synth [data-vote]')), 'en el CONSEJO cada respuesta tiene 👍 MEJOR (la síntesis no)');
  const keyOf = (id) => w.evaluate((id) => thread().messages.find((m) => m.id === id).key, id);
  const ids = await w.$$eval('[data-vote]', (b) => b.map((x) => x.dataset.vote));
  await w.click(`[data-vote="${ids[1]}"]`);
  const k1 = await keyOf(ids[1]);
  ok(await w.evaluate((k) => S.votes.resumen[k] === 1, k1) && /prefieres/.test(await w.textContent('#toast')) && !!(await w.$('.chip.voted')), 'votar anota la IA preferida para ese tipo de tarea (resumir)');
  await w.click(`[data-vote="${ids[0]}"]`);
  const k0 = await keyOf(ids[0]);
  ok(await w.evaluate(([a, b]) => S.votes.resumen[a] === 1 && S.votes.resumen[b] === 0, [k0, k1]) && (await w.$$('.chip.voted')).length === 1, 'un voto por consejo: cambiar de opinión mueve el voto');
  await w.evaluate(() => { S.council = false; S.target = 'm::tabla'; save(); renderTargets(); });
  const before = { ...mocks.calls };
  await sendMsg('Resume la historia de Roma');
  ok((mocks.calls[k0.split('::')[1]] || 0) === (before[k0.split('::')[1]] || 0) + 1, `con «la más votada», los resúmenes van a la que elegiste (${k0})`);

  // ---- 10. Exportar a PDF ----
  const out = process.env.PDF_OUT || path.join(UD, 'hilo.pdf');
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, out);
  await w.click('#btnThreads'); await w.click('#exportPdf');
  await w.waitForFunction(() => /GUARDADO/.test(document.querySelector('#toast').textContent), null, { timeout: 15000 });
  const pdf = fs.existsSync(out) ? fs.readFileSync(out) : Buffer.alloc(0);
  ok(pdf.slice(0, 5).toString() === '%PDF-' && pdf.length > 3000, `PDF del hilo guardado en el PC (${pdf.length} bytes)`);
  await w.emulateMedia({ media: 'print' });
  ok(!(await w.isVisible('#composer')) && !(await w.isVisible('nav.bar')) && await w.isVisible('#log .msg'), 'al imprimir solo sale la conversación (sin barra, ni caja de texto, ni botones)');
  await w.emulateMedia({ media: 'screen' });
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
