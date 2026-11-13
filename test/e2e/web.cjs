// Web/móvil: emparejar por enlace del QR, PIN para las claves, exportar/importar y diseño en móvil.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const fs = require('fs'), path = require('path');
const SHOT = path.join(require('os').tmpdir(), 'neura-shots');
let failures = 0;
const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = 'token-de-prueba-123456';

(async () => {
  const data = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-br-'));
  const br = spawn(process.execPath, [path.join(__dirname, '../../bridge/server.mjs')], { env: { ...process.env, PORT: '8790', HOST: '127.0.0.1', NEURA_TOKEN: TOKEN, NEURA_DATA: data, NEURA_CONFIG: '/nonexistent.json' } });
  await new Promise((r) => br.stdout.on('data', (d) => String(d).includes('Backends') && r()));
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });

  // 1. emparejar abriendo el enlace del QR
  const link = `http://127.0.0.1:8790/#pair=${Buffer.from(JSON.stringify({ u: 'http://127.0.0.1:8790/mcp', t: TOKEN, n: 'pc-casa' })).toString('base64url')}`;
  await p.goto(link);
  await p.waitForFunction(() => JSON.parse(localStorage.getItem('neura.v1') || '{}').mcp?.length === 1, null, { timeout: 5000 });
  await p.click('#btnMcp');
  await p.waitForSelector('#mcpList .badge.on', { timeout: 8000 }).then(() => ok(true, 'el enlace del QR empareja y conecta solo con el PC'), () => ok(false, 'pairing'));
  ok(!p.url().includes('#pair'), 'el token no queda en la barra de direcciones');
  ok(/PC-CASA/.test(await p.$eval('#mcpList', (e) => e.innerText)), 'nombre del equipo tomado del enlace');
  await p.keyboard.press('Escape');

  // 12. PIN
  await p.click('#btnAis');
  await p.click('#addProv');
  await p.fill('#provList input[data-f=baseUrl]', 'http://127.0.0.1:5601/v1');
  await p.$eval('#provList input[data-f=baseUrl]', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await p.fill('#provList input[data-f=apiKey]', 'sk-muy-secreta');
  await p.$eval('#provList input[data-f=apiKey]', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  await p.fill('#pinNew', '4321'); await p.click('#vaultOn'); await sleep(1500);
  const raw = await p.evaluate(() => localStorage.getItem('neura.v1'));
  ok(!raw.includes('sk-muy-secreta') && !raw.includes(TOKEN) && /"vault":\{"salt"/.test(raw), 'con PIN, ni la clave ni el token se guardan en claro');
  await p.screenshot({ path: SHOT + '/movil-ajustes.png' });
  await p.reload();
  await p.waitForSelector('#lock:not([hidden])').then(() => ok(true, 'al abrir pide el PIN'), () => ok(false, 'lock'));
  await p.fill('#lockPin', '0000'); await p.click('#lockForm button[type=submit]'); await sleep(1500);
  ok(await p.$('#lock:not([hidden])') !== null && /PIN incorrecto/.test(await p.textContent('#toast')), 'PIN incorrecto → sigue bloqueado');
  await p.fill('#lockPin', '4321'); await p.click('#lockForm button[type=submit]');
  await p.waitForSelector('#lock', { state: 'hidden' });
  ok(await p.evaluate(() => JSON.parse(localStorage.getItem('neura.v1')).mcp[0].token === undefined), 'tras desbloquear, el almacenamiento sigue sin claves en claro');
  await p.click('#btnAis');
  ok((await p.inputValue('#provList input[data-f=apiKey]')) === 'sk-muy-secreta', 'PIN correcto → claves recuperadas');
  await p.keyboard.press('Escape');

  // 3. exportar e importar
  await p.evaluate(() => { localStorage.setItem('x', '1'); });
  await p.click('#btnThreads');
  const dl = p.waitForEvent('download');
  // crea un hilo con contenido a mano para exportarlo
  await p.evaluate(() => { const d = JSON.parse(localStorage.getItem('neura.v1')); });
  await p.keyboard.press('Escape');
  await p.fill('#input', 'mensaje para exportar'); await p.click('#send');
  await p.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR'));
  await p.click('#btnThreads'); await sleep(200);
  await p.click('#exportAll');
  const file = await (await dl).path();
  const exp = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok(exp.app === 'neura' && exp.threads.length === 1 && exp.threads[0].messages[0].content === 'mensaje para exportar', 'exportar todos los hilos a .json');
  const dl2 = p.waitForEvent('download');
  await p.click('#exportMd');
  ok(/# mensaje para exportar/.test(fs.readFileSync(await (await dl2).path(), 'utf8')), 'exportar el hilo a Markdown');
  const p2 = await (await b.newContext()).newPage();
  await p2.goto('http://127.0.0.1:8790/');
  await p2.click('#btnThreads');
  await p2.setInputFiles('#importFile', file); await sleep(500);
  ok((await p2.$$eval('#threadList .chatItem span', (s) => s.map((x) => x.textContent))).includes('mensaje para exportar'), 'importar la copia en otro dispositivo');

  await p.keyboard.press('Escape'); await sleep(500);
  await p.screenshot({ path: SHOT + '/movil-chat.png' });
  await b.close(); br.kill();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
