// Prueba de punta a punta de Neura Desktop con todas las funciones nuevas.
const { _electron } = require('playwright');
const fs = require('fs'), path = require('path');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const FIX = path.join(__dirname, 'fixtures');
const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
const SHOT = path.join(require('os').tmpdir(), 'neura-shots'); fs.mkdirSync(SHOT, { recursive: true });
let failures = 0;
const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Estado inicial: una IA "personalizada" que apunta al simulador y la carpeta docs compartida con la IA.
fs.writeFileSync(path.join(UD, 'escritorio.json'), JSON.stringify({ port: 8787, lan: false, folders: [path.join(FIX, 'docs')] }));
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [{ id: 'mock', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'clave-secreta', models: ['rapido', 'cuota', 'tools', 'vision', 'ctx', 'tabla'], enabled: true }],
  mcp: [], threads: [], target: 'mock::rapido', autoSkip: true,
}));

const launch = () => _electron.launch({
  executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT,
  args: [ROOT, '--user-data-dir=' + UD, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const idle = (w) => w.waitForFunction(() => !document.querySelector('.reply.pending') && document.querySelector('#send').textContent.includes('ENVIAR'), null, { timeout: 30000 });
async function send(w, text) { await w.fill('#input', text); await w.click('#send'); await idle(w); }
const S = (w) => w.evaluate(() => JSON.parse(JSON.stringify(window.__S || null)));
const lastReply = (w) => w.$$eval('#log .reply', (r) => r.at(-1)?.innerText || '');
const setTarget = (w, key) => w.evaluate((k) => { const s = document.querySelector('#target'); s.value = k; s.dispatchEvent(new Event('change')); }, key);

(async () => {
  await mocks.start();
  const app = await launch();
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  w.on('console', (m) => { if (m.type() === 'error') console.log('console.error', m.text()); });
  await w.waitForFunction(() => [...document.querySelectorAll('#target option')].some((o) => o.textContent.includes('ESTE PC')), null, { timeout: 20000 });

  // 2. streaming (IA pública por IPC)
  await w.fill('#input', 'hola');
  await w.click('#send');
  await w.waitForFunction(() => { const t = document.querySelector('.reply.pending .txt')?.textContent || ''; return t.length > 0 && t.length < 20; }, null, { timeout: 5000 }).then(() => ok(true, 'streaming: el texto aparece poco a poco en el PC'), () => ok(false, 'streaming en PC'));
  await idle(w);
  ok((await lastReply(w)).includes('Hola desde rapido'), 'respuesta completa tras el streaming');

  // 2b. streaming de la IA local a través del puente (MCP + progress)
  await setTarget(w, 'mcp:local::ollama/qwen3:4b');
  await w.fill('#input', 'saluda');
  await w.click('#send');
  await w.waitForFunction(() => { const t = document.querySelector('.reply.pending .txt')?.textContent || ''; return t.length > 0; }, null, { timeout: 8000 }).then(() => ok(true, 'streaming de la IA local vía puente MCP'), () => ok(false, 'streaming IA local'));
  await idle(w);
  ok((await lastReply(w)).includes('local dice'), 'respuesta de la IA local completa');

  // 5. AUTO-SALTO inteligente
  await setTarget(w, 'mock::cuota');
  await send(w, 'pregunta con cuota agotada');
  const log1 = await w.$eval('#log', (l) => l.innerText);
  ok(/Cuota gratuita agotada por ahora. → probando otra IA/.test(log1) && mocks.calls.cuota === 1, 'cuota agotada (429) → salta a otra IA');
  const opt = await w.$eval('#target', (s) => [...s.options].find((o) => o.value === 'mock::cuota').textContent);
  ok(opt.startsWith('⏳'), 'el desplegable marca la IA agotada con ⏳');
  await send(w, 'otra vez');
  ok(mocks.calls.cuota === 1 && /CUOTA · hasta/.test(await w.$eval('#log', (l) => l.innerText)), 'no se reintenta la IA agotada hasta que pasa la espera (1m30s)');
  await w.click('#btnAis'); await sleep(300);
  ok(/⏳ cuota · CUOTA · hasta/.test(await w.$eval('#provList', (e) => e.innerText)), '⚙ muestra el estado de cada modelo');
  await w.screenshot({ path: SHOT + '/ajustes.png' });
  await w.keyboard.press('Escape');

  // 4. Markdown
  await setTarget(w, 'mock::tabla');
  await send(w, 'dame una tabla');
  ok(await w.$('#log .reply:last-of-type .tbl table, #log .msg:last-child .tbl') !== null, 'Markdown: tablas y listas');

  // 9. herramientas MCP: la IA pública lee un documento del PC
  await w.waitForSelector('#toolsLbl:not([hidden])', { timeout: 5000 }).catch(() => {});
  await w.check('#useTools');
  await setTarget(w, 'mock::tools');
  await send(w, '¿qué dice mi nota?');
  const tr = await lastReply(w);
  ok(/NEURA-2026/.test(tr) && /ƒ read_file/.test(tr), 'ƒ HERRAMIENTAS: la IA usa read_file del puente y responde con el contenido');
  await w.uncheck('#useTools');

  // 8. adjuntos: imagen + PDF
  await setTarget(w, 'mock::vision');
  await w.setInputFiles('#fileIn', [path.join(FIX, 'foto.png'), path.join(FIX, 'factura.pdf')]);
  await w.waitForFunction(() => document.querySelectorAll('#attachBar .chip').length === 2, null, { timeout: 15000 }).then(() => ok(true, 'adjuntos listos (imagen + PDF leído)'), () => ok(false, 'adjuntos'));
  await send(w, 'mira esto');
  ok((await lastReply(w)).includes('IMAGEN:sí PDF:sí'), 'la IA recibe la imagen y el texto del PDF');
  ok(await w.$('#log .thumb') !== null, 'la miniatura aparece en el mensaje');

  // 8b. dictado por voz (micrófono simulado → /audio/transcriptions de Groq)
  await w.fill('#input', '');
  await w.click('#mic'); await sleep(1500); await w.click('#mic');
  await w.waitForFunction(() => document.querySelector('#input').value.includes('hola dictado'), null, { timeout: 10000 }).then(() => ok(true, 'dictado: graba, transcribe con whisper y escribe el texto'), () => ok(false, 'dictado'));
  ok(mocks.log.some((x) => x.stt && x.model === 'whisper-large-v3-turbo' && x.bytes > 500), 'el audio llega como multipart con el modelo whisper');
  await w.fill('#input', '');

  // 7. CONSEJO
  await setTarget(w, 'mock::rapido');
  await w.evaluate(() => { document.querySelector('#target').dispatchEvent(new Event('change')); });
  await w.check('#council');
  await send(w, 'pregunta para el consejo');
  const cn = await w.$$eval('#log .council', (c) => ({ n: c.length, answers: c.at(-1)?.querySelectorAll('.cgrid .reply').length, synth: c.at(-1)?.querySelector('.reply.synth')?.innerText || '' }));
  ok(cn.n === 1 && cn.answers >= 2 && /SÍNTESIS FINAL/.test(cn.synth), `⚖ CONSEJO: ${cn.answers} IAs + síntesis`);
  await w.screenshot({ path: SHOT + '/consejo.png' });
  await w.uncheck('#council');

  // 6. contexto: resumen automático + reintento por contexto lleno
  await w.click('#btnThreads'); await w.click('#newThread');
  await w.evaluate(() => { const i = document.createElement('input'); }); // noop
  await w.click('#btnAis'); await sleep(200);
  await w.fill('#ctxTokens', '1000'); await w.$eval('#ctxTokens', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await w.keyboard.press('Escape');
  await setTarget(w, 'mock::rapido');
  for (let i = 0; i < 5; i++) await send(w, `mensaje ${i} ` + 'números largos '.repeat(60));
  ok(await w.$('#log details.note') !== null, 'contexto: lo antiguo se resume y se muestra la nota 🗜');
  ok(mocks.log.some((x) => x.ollama && /Conversación a resumir/.test(x.q)), 'el resumen lo hace la IA local (gratis)');
  ok(mocks.log.filter((x) => x.model === 'rapido').at(-1).system.some((s) => /RESUMEN LOCAL/.test(s)), 'la siguiente petición lleva el resumen como contexto');
  await w.click('#btnAis'); await sleep(200);
  await w.fill('#ctxTokens', '50000'); await w.$eval('#ctxTokens', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await w.keyboard.press('Escape');
  await setTarget(w, 'mock::ctx');
  await send(w, 'otra pregunta ' + 'x'.repeat(400));
  ok(/ctx ok/.test(await lastReply(w)), 'error de contexto lleno → comprime y reintenta con la misma IA');

  // 3. búsqueda en hilos
  await w.click('#btnThreads'); await sleep(300);
  await w.fill('#threadSearch', 'consejo');
  const found = await w.$$eval('#threadList .chatItem', (x) => x.length);
  ok(found === 1, 'buscar en los hilos filtra por contenido');
  await w.screenshot({ path: SHOT + '/busqueda.png' });
  await w.fill('#threadSearch', '');
  await w.keyboard.press('Escape');

  // 1 + 11. QR, carpetas y Tailscale en la tarjeta ESTE PC
  await w.click('#btnMcp'); await sleep(300);
  await w.check('[data-act=lan]');
  await w.waitForSelector('.qr img', { timeout: 10000 }).then(() => ok(true, 'QR de emparejamiento al abrir a la red'), () => ok(false, 'QR'));
  const card = await w.$eval('#mcpList', (e) => e.innerText);
  ok(/docs/.test(card) && /search_docs/.test(card), 'carpetas para la IA visibles y herramientas de documentos activas');
  ok(/Instala Tailscale|Tailscale está|ACTIVAR HTTPS/.test(card), 'sección FUERA DE CASA (Tailscale)');
  await w.screenshot({ path: SHOT + '/pc-mcp.png', fullPage: true });
  const info = await w.evaluate(() => window.neuraDesktop.bridge());

  // 12. claves en disco
  await sleep(500);
  const disk = fs.readFileSync(path.join(UD, 'neura-datos.json'), 'utf8');
  const kr = await w.evaluate(() => window.neuraDesktop.secure());
  ok(kr ? !disk.includes('clave-secreta') : true, `claves en disco ${kr ? 'cifradas con ' + kr : 'sin llavero en este Linux de prueba (se guardan como antes)'}`);

  await app.close();
  // persistencia tras reiniciar
  const app2 = await launch(); const w2 = await app2.firstWindow();
  await w2.waitForSelector('#log .msg', { timeout: 15000 });
  await w2.click('#btnThreads'); await sleep(300);
  ok((await w2.$$('#threadList .chatItem')).length >= 2, 'tras reiniciar siguen los hilos');
  await app2.close();
    console.log(failures ? `FALLOS: ${failures}` : 'TODO OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
