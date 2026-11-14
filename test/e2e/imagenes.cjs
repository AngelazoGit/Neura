// Imágenes gratis en el PC (/imagen con Forge/AUTOMATIC1111 o ComfyUI a través del puente) y diagnóstico de todas las IAs.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const PNG = fs.readFileSync(path.join(__dirname, 'fixtures/foto.png'));
fs.writeFileSync(path.join(UD, 'puente.json'), JSON.stringify({
  backends: [{ id: 'ollama', type: 'ollama', url: 'http://127.0.0.1:11434' }],
  images: [{ id: 'forge', type: 'a1111', url: 'http://127.0.0.1:5603' }],
}));
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [
    { id: 'm', preset: 'groq', name: 'BUENA', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido', 'cuota'], enabled: true },
    { id: 'c', preset: 'cerebras', name: 'AGOTADA', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['cuota'], enabled: true },
    { id: 'n', preset: 'mistral', name: 'SINCLAVE', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: '', models: ['rapido'], enabled: true },
  ],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true, level: 'pro', wizardDone: true,
}));
const seen = [];
const forge = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/sdapi/v1/sd-models') return res.end('[]');
    if (req.url === '/sdapi/v1/txt2img') { seen.push(JSON.parse(b)); return setTimeout(() => res.end(JSON.stringify({ images: [PNG.toString('base64')], info: '{"sd_model_name":"sdxl"}' })), 300); }
    res.statusCode = 404; res.end('{}');
  });
});

(async () => {
  await mocks.start();
  await new Promise((r) => forge.listen(5603, '127.0.0.1', r));
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => typeof S !== 'undefined' && S.mcp[0]?.status === 'on', null, { timeout: 20000 });
  const idle = () => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg').length > 0, null, { timeout: 20000 });

  // ---- 11. Imágenes en el PC ----
  ok(await w.evaluate(() => S.mcp[0].images.some((i) => i.id === 'forge' && i.online)), 'el puente detecta el generador de imágenes del PC');
  await w.click('#btnMcp');
  ok(/Generador detectado/.test(await w.textContent('#mcpList')) && /🖼 forge/.test(await w.textContent('#mcpList')), '⬡ indica que hay imágenes en este PC y cómo pedirlas');
  await w.keyboard.press('Escape');
  const llm = mocks.log.length;
  await w.fill('#input', '/imagen un faro al atardecer, acuarela\nEvitar: texto, marcas de agua'); await w.click('#send');
  await idle();
  ok(await w.isVisible('#log .reply .files.gen img.thumb') && /Imagen generada en .* con forge · sdxl/.test(await w.textContent('#log')), '/imagen crea la imagen en el PC y la muestra en el chat');
  ok(seen.at(-1)?.prompt === 'un faro al atardecer, acuarela' && seen.at(-1)?.negative_prompt === 'texto, marcas de agua' && mocks.log.length === llm, '«Evitar:» va como prompt negativo y no se usa ninguna IA de texto');
  const out = path.join(UD, 'faro.png');
  await app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: f }); }, out);
  await w.click('[data-saveimg]');
  await w.waitForFunction(() => /GUARDADO/.test(document.querySelector('#toast').textContent));
  ok(fs.existsSync(out) && fs.readFileSync(out).equals(PNG), 'GUARDAR guarda la imagen tal cual en el PC');
  await w.evaluate(async () => { await hydrateFiles(); });
  ok(await w.evaluate(() => !!thread().messages.find((m) => m.files)?.files[0].ref), 'la imagen se guarda en IndexedDB, como los adjuntos');
  await new Promise((r) => forge.close(r));
  await w.fill('#input', '/imagen otra'); await w.click('#send'); await idle();
  ok(/ComfyUI|Forge/.test(await w.$$eval('#log .reply.err', (r) => r.at(-1)?.innerText || '')), 'si el generador está apagado, explica cómo tener uno');

  // ---- 12. Diagnóstico ----
  await w.click('#btnAis'); await w.click('#diagRun');
  await w.waitForFunction(() => /funcionan ahora/.test(document.querySelector('#diagOut')?.textContent || ''), null, { timeout: 30000 });
  const diag = await w.$$eval('#diagOut tr', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('   ' + diag.join('\n   '));
  ok(diag.some((x) => /BUENA \/ rapido ✓/.test(x)), 'una IA que funciona aparece con ✓ y su tiempo');
  ok(diag.some((x) => /AGOTADA \/ cuota ✕ Cuota gratuita agotada/.test(x)), 'una IA agotada aparece con el motivo');
  ok(diag.some((x) => /SINCLAVE ✕ falta la clave API/.test(x)), 'una IA sin clave aparece sin hacer ninguna petición');
  ok(diag.some((x) => /ESTE PC \/ ollama\/qwen3:4b ✓/.test(x)), 'también prueba la IA local del PC');
  ok(!diag.some((x) => /BUENA \/ cuota/.test(x)), 'por defecto prueba un modelo por IA');
  ok(await w.evaluate(() => S.health['c::cuota']?.reason === 'CUOTA'), 'el resultado actualiza AUTO-SALTO (la agotada queda en pausa)');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
