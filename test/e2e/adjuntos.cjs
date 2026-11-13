// Adjuntos en IndexedDB (web/móvil): migración, guardado interrumpido, almacenamiento lleno, reinicio,
// exportar/importar byte a byte, reintento/consejo/rama con imágenes, PDF escaneado y sincronización entre dispositivos.
const { chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const mocks = require('./mocks.cjs');
const FIX = path.join(__dirname, 'fixtures');
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const JPG = fs.readFileSync(path.join(FIX, 'tabla.jpg'));
const JPG_URL = 'data:image/jpeg;base64,' + JPG.toString('base64');
const PDF_TEXT = '--- pág. 1 ---\nContrato de alquiler, cláusula 7: 650 € al mes.\n\n';
const PORT = 8796, TOKEN = 'token-adjuntos-1234567890', APP = `http://127.0.0.1:${PORT}/`;
const provider = { id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['vision', 'cuota', 'rapido'], enabled: true };
const oldState = { providers: [provider], mcp: [], target: 'm::vision', autoSkip: true, threads: [{ id: 'th1', title: 'antiguo', ts: 1, messages: [
  { id: 'u1', role: 'user', content: 'mira la tabla', ts: 1, files: [{ kind: 'image', name: 'tabla.jpg', data: JPG_URL }, { kind: 'text', name: 'contrato.pdf', text: PDF_TEXT, pdf: true }] },
  { id: 'a1', role: 'assistant', label: 'MOCK / vision', content: 'vista', ts: 2 }] }], active: 'th1' };

// Huella de un adjunto guardado en IndexedDB (bytes reales) desde la página.
const idbHash = (p, ref) => p.evaluate(async (ref) => {
  const v = await blobs.get(ref);
  const buf = typeof v === 'string' ? new TextEncoder().encode(v) : await v.arrayBuffer();
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
}, ref);
const stored = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('neura.v1') || '{}'));
const idle = (p) => p.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'), null, { timeout: 20000 });
const send = async (p, t) => { await p.fill('#input', t); await p.click('#send'); await idle(p); };
const setT = (p, k) => p.evaluate((k) => { const s = document.querySelector('#target'); s.value = k; s.dispatchEvent(new Event('change')); }, k);

(async () => {
  await mocks.start();
  const data = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-br-'));
  const br = spawn(process.execPath, [path.join(__dirname, '../../bridge/server.mjs')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NEURA_TOKEN: TOKEN, NEURA_DATA: data, NEURA_CONFIG: '/nonexistent.json' } });
  await new Promise((r) => br.stdout.on('data', (d) => String(d).includes('Backends') && r()));
  const b = await chromium.launch();
  const watch = (p) => p.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });

  // 1. Migración desde una instalación con imágenes antiguas (dentro del estado)
  let ctx = await b.newContext({ acceptDownloads: true }); let p = await ctx.newPage(); watch(p);
  await p.addInitScript((st) => { if (location.protocol === 'http:' && !sessionStorage.getItem('sembrado')) { localStorage.setItem('neura.v1', JSON.stringify(st)); sessionStorage.setItem('sembrado', '1'); } }, oldState);
  await p.goto(APP);
  await p.waitForFunction(() => { const s = JSON.parse(localStorage.getItem('neura.v1')); return s.threads[0].messages[0].files.every((f) => f.ref && !f.data && !f.text); }, null, { timeout: 10000 })
    .then(() => ok(true, 'migración: los adjuntos antiguos pasan a IndexedDB y el estado solo guarda referencias'), () => ok(false, 'migración'));
  let st = await stored(p);
  const [imgRef, txtRef] = st.threads[0].messages[0].files.map((f) => f.ref);
  ok(await idbHash(p, imgRef) === sha(JPG) && await idbHash(p, txtRef) === sha(Buffer.from(PDF_TEXT)), 'migración: los bytes guardados son idénticos al original (imagen y texto del PDF)');
  ok(JSON.stringify(st).length < 3000, `el estado pesa ahora ${JSON.stringify(st).length} bytes (antes ${JSON.stringify(oldState).length})`);

  // 2. Reinicio: texto y adjuntos conservados
  await p.reload(); await p.waitForSelector('#log .thumb');
  ok(await p.$eval('#log .thumb', (i) => i.src) === JPG_URL, 'tras reiniciar, la imagen se muestra con los mismos bytes');
  await send(p, '¿qué dice?');
  const req = mocks.log.filter((x) => x.model === 'vision').at(-1);
  ok(/cláusula 7/.test(req.all), 'tras reiniciar, la IA recibe el texto del PDF guardado');

  // 3. Reintento (AUTO-SALTO), CONSEJO y rama con imágenes, sin duplicar archivos
  await setT(p, 'm::cuota');
  await p.setInputFiles('#fileIn', path.join(FIX, 'tabla.jpg')); await p.waitForSelector('#attachBar .chip');
  await send(p, 'otra tabla');
  ok(/IMAGEN:sí/.test(await p.$$eval('#log .reply', (r) => r.at(-1).innerText)), 'reintento: tras el 429 otra IA recibe la imagen completa');
  const keys1 = (await p.evaluate(() => blobs.keys())).length;
  await p.check('#council'); await setT(p, 'm::vision');
  await p.setInputFiles('#fileIn', path.join(FIX, 'tabla.jpg')); await p.waitForSelector('#attachBar .chip');
  await send(p, 'consejo con imagen');
  ok((await p.$$eval('#log .council .cgrid .reply', (r) => r.map((x) => x.innerText).join('|'))).includes('IMAGEN:sí'), 'CONSEJO con imagen: los miembros reciben la imagen');
  await p.uncheck('#council');
  const keys2 = (await p.evaluate(() => blobs.keys())).length;
  await p.click('#log .msg.user:last-of-type [data-branch], #log .msg.user [data-branch] >> nth=-1');
  await p.waitForTimeout(500);
  ok((await p.evaluate(() => blobs.keys())).length === keys2 && keys2 === keys1 + 1, 'una rama comparte la imagen con el hilo original (no la duplica)');
  await p.reload(); await p.waitForSelector('#log');
  ok((await p.$$('#log .thumb')).length >= 1 && !(await p.$('#log .chip.off')), 'tras reiniciar, la rama conserva sus imágenes');

  // 4. PDF escaneado: páginas idénticas antes y después de guardar
  await p.click('#btnThreads'); await p.click('#newThread');
  await p.setInputFiles('#fileIn', path.join(FIX, 'escaneado.pdf'));
  await p.waitForFunction(() => [...document.querySelectorAll('#attachBar .chip')].some((c) => /pág\. 1/.test(c.textContent)), null, { timeout: 15000 });
  const before = await p.evaluate(() => attach[0].data);
  await send(p, 'lee el escaneado');
  await p.reload(); await p.waitForSelector('#log .thumb');
  ok(await p.$eval('#log .thumb', (i) => i.src) === before, 'PDF escaneado: la página guardada es idéntica byte a byte tras reiniciar');

  // 5. Exportar e importar: bytes idénticos
  await p.click('#btnThreads');
  const dl = p.waitForEvent('download'); await p.click('#exportAll');
  const file = await (await dl).path();
  const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
  const expImg = exp.threads.flatMap((t) => t.messages.flatMap((m) => m.files || [])).find((f) => f.name === 'tabla.jpg');
  ok(expImg.data === JPG_URL && !JSON.stringify(exp).includes('"ref"'), 'la copia exportada lleva los originales (no referencias de este dispositivo)');
  const ctx2 = await b.newContext(); const q = await ctx2.newPage(); watch(q);
  await q.goto(APP); await q.click('#btnThreads');
  await q.setInputFiles('#importFile', file);
  await q.waitForFunction(() => JSON.parse(localStorage.getItem('neura.v1') || '{}').threads?.some((t) => t.id === 'th1' && t.messages[0].files?.every((f) => f.ref)), null, { timeout: 10000 });
  const st2 = await stored(q);
  const [ir, tr] = st2.threads.find((t) => t.id === 'th1').messages[0].files.map((f) => f.ref);
  ok(await idbHash(q, ir) === sha(JPG) && await idbHash(q, tr) === sha(Buffer.from(PDF_TEXT)), 'importar en otro dispositivo: imagen y texto con bytes idénticos');
  await ctx2.close();

  // 6. Sincronización de una imagen a otro dispositivo
  const pair = `${APP}#pair=${Buffer.from(JSON.stringify({ u: `${APP}mcp`, t: TOKEN, n: 'pc' })).toString('base64url')}`;
  await p.goto('about:blank'); await p.goto(pair); await p.waitForFunction(() => S.mcp[0]?.status === 'on', null, { timeout: 10000 }); await p.waitForTimeout(1500);
  const ctx3 = await b.newContext(); const m = await ctx3.newPage(); watch(m);
  await m.goto(pair);
  await m.waitForFunction(() => S.threads.some((t) => t.id === 'th1' && t.messages[0].files?.[0]?.ref), null, { timeout: 15000 });
  const mr = await m.evaluate(() => S.threads.find((t) => t.id === 'th1').messages[0].files[0].ref);
  ok(await idbHash(m, mr) === sha(JPG), 'sincronización: el otro dispositivo recibe la imagen original y la guarda en su IndexedDB');
  await ctx3.close(); await ctx.close();

  // 7. Guardado interrumpido entre archivo y referencia + almacenamiento lleno: aviso visible y nada se pierde
  ctx = await b.newContext({ acceptDownloads: true }); p = await ctx.newPage(); watch(p);
  await p.addInitScript((st) => {
    if (location.protocol !== 'http:') return;
    if (!localStorage.getItem('neura.v1')) localStorage.setItem('neura.v1', JSON.stringify(st));
    if (sessionStorage.getItem('lleno') !== 'no') {
      const orig = Storage.prototype.setItem;
      Storage.prototype.setItem = function (k, v) { if (k === 'neura.v1') throw new DOMException('Quota exceeded', 'QuotaExceededError'); return orig.call(this, k, v); };
    }
  }, oldState);
  await p.goto(APP);
  await p.waitForSelector('#saveWarn:not([hidden])', { timeout: 10000 }).then(() => ok(true, 'almacenamiento lleno: aparece un aviso fijo «No se ha podido guardar»'), () => ok(false, 'aviso visible'));
  ok(/almacenamiento lleno/.test(await p.textContent('#saveWarn')), 'el aviso explica la causa y ofrece EXPORTAR COPIA');
  await setT(p, 'm::vision');
  await p.setInputFiles('#fileIn', path.join(FIX, 'tabla.jpg')); await p.waitForSelector('#attachBar .chip');
  await send(p, 'mensaje sin poder guardar');
  ok(!(await p.$('#saveWarn[hidden]')), 'el aviso sigue visible: no se finge un guardado completo');
  const dl2 = p.waitForEvent('download'); await p.click('#saveWarnExport');
  const rescue = JSON.parse(fs.readFileSync(await (await dl2).path(), 'utf8'));
  const rescued = rescue.threads.flatMap((t) => t.messages).find((x) => x.content === 'mensaje sin poder guardar');
  ok(rescued && rescued.files[0].data && sha(Buffer.from(rescued.files[0].data.split(',')[1], 'base64')).length === 64, 'EXPORTAR COPIA recupera la conversación no guardada con su imagen');
  // Cierre brusco: el estado guardado sigue siendo el antiguo (con los adjuntos dentro) → nada desaparece
  await p.evaluate(() => sessionStorage.setItem('lleno', 'no'));
  await p.reload(); await p.waitForSelector('#log .thumb');
  st = await stored(p);
  ok(!(await p.$('#log .chip.off')) && (await p.$eval('#log .thumb', (i) => i.src)) === JPG_URL, 'tras el corte, las imágenes siguen ahí (el estado guardado aún las contenía)');
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('neura.v1')).threads[0].messages[0].files.every((f) => f.ref), null, { timeout: 10000 })
    .then(() => ok(true, 'al recuperar espacio, la migración se completa sola'), () => ok(false, 'migración tras corte'));
  const used = new Set((await stored(p)).threads.flatMap((t) => t.messages.flatMap((x) => x.files || [])).map((f) => f.ref));
  await p.reload(); await p.waitForSelector('#log .thumb');
  const keys = await p.evaluate(() => blobs.keys());
  ok(keys.every((k) => used.has(k)), `los archivos huérfanos del corte se limpian (${keys.length} en IndexedDB, todos referenciados)`);

  await b.close(); br.kill();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
