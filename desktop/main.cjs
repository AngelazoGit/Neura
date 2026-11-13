// NEURA DESKTOP — la misma app de app/ en una ventana de PC, con:
//  · datos guardados en disco (hilos, IAs y servidores MCP) y claves cifradas con el llavero del sistema,
//  · peticiones hechas desde el PC (sin CORS) y con streaming, como en la app nativa del móvil,
//  · el puente MCP (bridge/server.mjs) integrado: expone Ollama/LM Studio, carpetas para la IA
//    y guarda los hilos para que el móvil y la web los compartan,
//  · emparejamiento con el móvil por QR y acceso fuera de casa con Tailscale.
const { app, BrowserWindow, ipcMain, shell, net, dialog, safeStorage, session } = require('electron');
const { spawn, execFile } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const QRCode = require('qrcode');

// Versión portable de Windows: los datos viajan junto al .exe (p. ej. en un USB), en la carpeta Neura-datos.
const PORTABLE = process.env.PORTABLE_EXECUTABLE_DIR;
if (PORTABLE) app.setPath('userData', path.join(PORTABLE, 'Neura-datos'));

if (!app.requestSingleInstanceLock()) app.quit();

const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
const APP_DIR = path.join(RES, 'app');
const BRIDGE = path.join(RES, 'bridge', 'server.mjs');
const DATA = app.getPath('userData');
const STORE = path.join(DATA, 'neura-datos.json');
const CFG = path.join(DATA, 'escritorio.json');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// Token fijo por instalación para que el móvil no tenga que volver a pegarlo.
const cfg = { port: 8787, lan: false, folders: [], ...readJSON(CFG) };
if (!cfg.token) cfg.token = randomBytes(18).toString('base64url');
const saveCfg = () => writeAtomic(CFG, JSON.stringify(cfg, null, 2));
saveCfg();

// ---------- claves cifradas con el llavero del sistema ----------
// En Linux sin llavero (backend "basic_text") el cifrado no protege nada: se guardan tal cual.
function keyring() {
  // En portable no: el llavero va ligado a este PC y las claves no se podrían leer en otro (se usa el PIN).
  if (PORTABLE || !safeStorage.isEncryptionAvailable()) return null;
  const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend?.() : null;
  if (backend === 'basic_text') return null;
  return { win32: 'Windows DPAPI', darwin: 'Llavero de macOS' }[process.platform] || `llavero (${backend})`;
}
const ENC = 'enc:v1:';
function mapSecrets(text, fn) {
  let j;
  try { j = JSON.parse(text); } catch { return text; }
  for (const p of j.providers || []) if (p.apiKey) p.apiKey = fn(p.apiKey);
  for (const m of j.mcp || []) if (m.token && !m.local) m.token = fn(m.token);
  return JSON.stringify(j);
}
const seal = (text) => (keyring() ? mapSecrets(text, (v) => (v.startsWith(ENC) ? v : ENC + safeStorage.encryptString(v).toString('base64'))) : text);
const unseal = (text) => mapSecrets(text, (v) => {
  if (!v.startsWith(ENC)) return v;
  try { return safeStorage.decryptString(Buffer.from(v.slice(ENC.length), 'base64')); } catch { return ''; }
});

// ---------- puente MCP integrado ----------
let bridge = null;
const state = { port: cfg.port, error: null, qr: null, qrTs: null, tailscale: { installed: false } };

function launch(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port),
        HOST: cfg.lan ? '0.0.0.0' : '127.0.0.1', NEURA_TOKEN: cfg.token,
        NEURA_DATA: DATA, NEURA_CONFIG: path.join(DATA, 'puente.json'),
        NEURA_FOLDERS: JSON.stringify(cfg.folders.filter((f) => fs.existsSync(f))),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const done = (ok) => { child.stdout.removeAllListeners('data'); resolve(ok ? child : out); };
    child.stdout.on('data', (d) => { out += d; if (out.includes('Backends')) done(true); });
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', () => { if (bridge === child) bridge = null; done(false); });
  });
}

async function startBridge() {
  stopBridge();
  for (let port = cfg.port; port < cfg.port + 10; port++) {
    const r = await launch(port);
    if (typeof r !== 'string') { bridge = r; Object.assign(state, { port, error: null }); return refreshPairing(); }
    if (!r.includes('EADDRINUSE')) { state.error = 'El puente no arrancó: ' + r.trim().split('\n').pop(); return; }
  }
  state.error = `Puertos ${cfg.port}-${cfg.port + 9} ocupados`;
}
function stopBridge() { if (bridge) { bridge.removeAllListeners('exit'); bridge.kill(); bridge = null; } }

const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address)
  .sort((a, b) => (a.startsWith('100.') ? 1 : 0) - (b.startsWith('100.') ? 1 : 0)); // Tailscale al final

// Enlace de emparejamiento: abre la web que sirve el puente y le pasa URL + token en el #hash (no viaja al servidor).
function pairLink(origin) {
  const data = Buffer.from(JSON.stringify({ u: `${origin}/mcp`, t: cfg.token, n: os.hostname() })).toString('base64url');
  return `${origin}/#pair=${data}`;
}
const qr = (text) => QRCode.toDataURL(text, { margin: 1, width: 300, errorCorrectionLevel: 'M' });
async function refreshPairing() {
  state.tailscale = await tailscaleStatus();
  const ip = lanIPs()[0];
  state.qr = cfg.lan && ip ? await qr(pairLink(`http://${ip}:${state.port}`)) : null;
  state.qrTs = state.tailscale.https ? await qr(pairLink(`https://${state.tailscale.dns}`)) : null;
}
const bridgeInfo = () => ({
  port: state.port, token: cfg.token, lan: cfg.lan, ips: lanIPs(), error: state.error,
  qr: state.qr, qrTs: state.qrTs, tailscale: state.tailscale, folders: cfg.folders,
});

// ---------- Tailscale (fuera de casa) ----------
const TS_BIN = { win32: ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'], darwin: ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'] }[process.platform] || ['tailscale'];
function ts(args) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= TS_BIN.length) return resolve({ missing: true });
      execFile(TS_BIN[i++], args, { timeout: 15000, windowsHide: true }, (err, out, errOut) => {
        if (err?.code === 'ENOENT') return next();
        resolve(err ? { error: String(errOut || err.message).trim().split('\n')[0] } : { out: String(out) });
      });
    };
    next();
  });
}
async function tailscaleStatus() {
  const r = await ts(['status', '--json']);
  if (r.missing) return { installed: false };
  let j = {};
  try { j = JSON.parse(r.out || '{}'); } catch {}
  const running = j.BackendState === 'Running';
  const dns = j.Self?.DNSName?.replace(/\.$/, '');
  const ip = (j.Self?.TailscaleIPs || []).find((x) => x.includes('.'));
  const srv = running ? await ts(['serve', 'status']) : {};
  const https = !!(srv.out && dns && srv.out.includes(`127.0.0.1:${state.port}`));
  return { installed: true, running, dns, ip, https, error: running ? null : r.error || null };
}

// ---------- IPC ----------
let backedUp = false;
ipcMain.on('store-load', (e) => { try { e.returnValue = unseal(fs.readFileSync(STORE, 'utf8')); } catch { e.returnValue = null; } });
ipcMain.handle('store-save', (_e, text) => {
  // Una copia de seguridad por sesión, por si algo sale mal.
  if (!backedUp && fs.existsSync(STORE)) { fs.copyFileSync(STORE, STORE.replace(/\.json$/, '.bak.json')); backedUp = true; }
  writeAtomic(STORE, seal(String(text)));
});
ipcMain.on('keyring', (e) => { e.returnValue = keyring(); });
ipcMain.on('bridge-info', (e) => { e.returnValue = bridgeInfo(); });
ipcMain.handle('set-lan', async (_e, lan) => { cfg.lan = !!lan; saveCfg(); await startBridge(); return bridgeInfo(); });
ipcMain.handle('add-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Carpeta que la IA podrá leer', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return bridgeInfo();
  const dir = r.filePaths[0];
  if (dir === os.homedir() || path.parse(dir).root === dir) return { error: 'Elige una carpeta concreta, no la carpeta de usuario ni el disco entero' };
  if (!cfg.folders.includes(dir)) cfg.folders.push(dir);
  saveCfg(); await startBridge(); return bridgeInfo();
});
ipcMain.handle('remove-folder', async (_e, dir) => { cfg.folders = cfg.folders.filter((f) => f !== dir); saveCfg(); await startBridge(); return bridgeInfo(); });
ipcMain.handle('tailscale', async (_e, on) => {
  const r = await ts(on ? ['serve', '--bg', String(state.port)] : ['serve', '--https=443', 'off']);
  await refreshPairing();
  return r.error ? { error: 'Tailscale: ' + r.error } : bridgeInfo();
});
ipcMain.handle('save-file', async (_e, name, text) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('documents'), String(name).replace(/[\\/:*?"<>|]/g, '_')) });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, String(text));
  return r.filePath;
});

// Peticiones de la app con streaming: cabecera, trozos y fin llegan como eventos.
const pending = new Map();
ipcMain.on('http', async (e, id, { url, method, headers, body }) => {
  const send = (type, data) => { if (!e.sender.isDestroyed()) e.sender.send('http-ev', id, type, data); };
  if (!/^https?:\/\//i.test(url)) return send('error', { message: 'URL no permitida' });
  const ctl = new AbortController();
  pending.set(id, ctl);
  try {
    const r = await net.fetch(url, { method, headers, body, signal: ctl.signal });
    send('head', { status: r.status, headers: Object.fromEntries(r.headers) });
    if (r.body) for await (const chunk of r.body) send('chunk', chunk);
    send('end');
  } catch (err) {
    send('error', { aborted: ctl.signal.aborted, message: err.cause?.code || err.message });
  } finally { pending.delete(id); }
});
ipcMain.on('http-abort', (_e, id) => pending.get(id)?.abort());

// ---------- ventana ----------
let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1100, height: 820, minWidth: 380, minHeight: 500,
    backgroundColor: '#07060a', title: 'Neura', autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // Los enlaces (p. ej. "conseguir clave") se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.loadFile(path.join(APP_DIR, 'index.html'));
}

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  // Solo se conceden el micrófono (dictado) y el portapapeles.
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'clipboard-read']);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => cb(allowed.has(perm) && !(details?.mediaTypes || []).includes('video')));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));
  await startBridge();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (state.error) dialog.showMessageBox({ type: 'warning', message: 'Puente MCP', detail: state.error });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', stopBridge);
