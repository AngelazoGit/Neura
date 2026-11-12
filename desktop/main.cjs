// NEURA DESKTOP — la misma app de app/ en una ventana de PC, con:
//  · datos guardados en disco (hilos, IAs y servidores MCP) en la carpeta de usuario,
//  · peticiones hechas desde el PC (sin CORS), como en la app nativa del móvil,
//  · el puente MCP (bridge/server.mjs) integrado: expone Ollama/LM Studio y guarda
//    los hilos para que el móvil y la web los compartan.
const { app, BrowserWindow, ipcMain, shell, net, dialog } = require('electron');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
const cfg = { port: 8787, lan: false, ...readJSON(CFG) };
if (!cfg.token) cfg.token = randomBytes(18).toString('base64url');
writeAtomic(CFG, JSON.stringify(cfg, null, 2));

// ---------- puente MCP integrado ----------
let bridge = null;
const state = { port: cfg.port, error: null };

function launch(port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: {
        ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port),
        HOST: cfg.lan ? '0.0.0.0' : '127.0.0.1', NEURA_TOKEN: cfg.token,
        NEURA_DATA: DATA, NEURA_CONFIG: path.join(DATA, 'puente.json'),
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
    if (typeof r !== 'string') { bridge = r; Object.assign(state, { port, error: null }); return; }
    if (!r.includes('EADDRINUSE')) { state.error = 'El puente no arrancó: ' + r.trim().split('\n').pop(); return; }
  }
  state.error = `Puertos ${cfg.port}-${cfg.port + 9} ocupados`;
}
function stopBridge() { if (bridge) { bridge.removeAllListeners('exit'); bridge.kill(); bridge = null; } }

const lanIPs = () => Object.values(os.networkInterfaces()).flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
const bridgeInfo = () => ({ port: state.port, token: cfg.token, lan: cfg.lan, ips: lanIPs(), error: state.error });

// ---------- IPC ----------
let backedUp = false;
ipcMain.on('store-load', (e) => { try { e.returnValue = fs.readFileSync(STORE, 'utf8'); } catch { e.returnValue = null; } });
ipcMain.handle('store-save', (_e, text) => {
  // Una copia de seguridad por sesión, por si algo sale mal.
  if (!backedUp && fs.existsSync(STORE)) { fs.copyFileSync(STORE, STORE.replace(/\.json$/, '.bak.json')); backedUp = true; }
  writeAtomic(STORE, String(text));
});
ipcMain.on('bridge-info', (e) => { e.returnValue = bridgeInfo(); });
ipcMain.handle('set-lan', async (_e, lan) => {
  cfg.lan = !!lan; writeAtomic(CFG, JSON.stringify(cfg, null, 2));
  await startBridge();
  return bridgeInfo();
});

const pending = new Map();
ipcMain.handle('http', async (_e, id, { url, method, headers, body }) => {
  if (!/^https?:\/\//i.test(url)) return { error: 'URL no permitida' };
  const ctl = new AbortController();
  pending.set(id, ctl);
  try {
    const r = await net.fetch(url, { method, headers, body, signal: ctl.signal });
    return { status: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  } catch (err) {
    return ctl.signal.aborted ? { aborted: true } : { error: err.cause?.code || err.message };
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
  await startBridge();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  if (state.error) dialog.showMessageBox({ type: 'warning', message: 'Puente MCP', detail: state.error });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', stopBridge);
