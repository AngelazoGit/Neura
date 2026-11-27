// «Conectar mi cuenta» (OpenRouter, OAuth con PKCE), «Probar sin cuenta» (Pollinations) y PEGAR.
// OpenRouter y Pollinations se simulan: en el PC se redirigen sus direcciones al servidor de pruebas; en la web, con rutas de Playwright.
const { _electron, chromium } = require('playwright'); const { spawn } = require('child_process');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const ROOT = path.join(__dirname, '../../desktop');
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const launch = (UD) => _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD, '--lang=es-ES'] });
const b64url = (b) => b.toString('base64url');

// ---- OpenRouter simulado ----
const OR = { challenge: '', exchanges: [], keyChecks: 0, gens: 0, pollDown: true };
const MODELS = [{ id: 'meta/llama-libre:free' }, { id: 'openai/caro', pricing: { prompt: '0.00001', completion: '0.00003' } }, { id: 'qwen/otro:free' }];
const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };
const handle = (method, url, auth, body) => {
  if (url.startsWith('/poll')) return OR.pollDown ? [503, { error: 'down' }] : [200, { choices: [{ message: { content: 'hola sin cuenta' } }] }];
  if (method === 'POST' && url === '/api/v1/auth/keys') {
    const b = JSON.parse(body || '{}'); OR.exchanges.push(b);
    const good = b.code === 'CODIGO-OK' && b.code_challenge_method === 'S256' && b64url(crypto.createHash('sha256').update(b.code_verifier || '').digest()) === OR.challenge;
    return good ? [200, { key: 'sk-or-v1-PRUEBA' }] : [403, { error: { message: 'Invalid code or verifier' } }];
  }
  if (url === '/api/v1/key') { OR.keyChecks++; return auth === 'Bearer sk-or-v1-PRUEBA' ? [200, { data: { label: 'x' } }] : [401, { error: 'no' }]; }
  if (url === '/api/v1/models') return [200, { data: MODELS }];
  if (url === '/api/v1/chat/completions') { OR.gens++; return [200, { choices: [{ message: { content: 'hola' } }] }]; }
  return [404, {}];
};
const srv = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => { const [c, o] = handle(req.method, req.url, req.headers.authorization, body); json(res, c, o); });
});
const get = (url) => new Promise((ok2) => http.get(url, (r) => { r.resume(); r.on('end', () => ok2(r.statusCode)); }).on('error', () => ok2(0)));

(async () => {
  await new Promise((r) => srv.listen(5607, '127.0.0.1', r));
  const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
  const app = await launch(UD); const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  // Las peticiones del PC salen por el proceso principal: ahí se redirigen a la simulación y se captura el navegador externo.
  await app.evaluate(({ net, shell, clipboard }) => {
    const f = net.fetch.bind(net);
    net.fetch = (u, o) => f(String(u).replace('https://openrouter.ai', 'http://127.0.0.1:5607').replace('https://text.pollinations.ai/openai', 'http://127.0.0.1:5607/poll'), o);
    global.__opened = []; shell.openExternal = async (u) => { global.__opened.push(u); };
    clipboard.writeText('gsk_ClaveDePrueba123');
  });
  await w.waitForSelector('.wizard', { timeout: 20000 });
  ok(/CONECTAR MI CUENTA/.test(await w.textContent('.wizard')) && /sin copiar claves/.test(await w.textContent('.wizard')), 'el asistente ofrece primero «Conectar mi cuenta (sin copiar claves)»');
  ok(/requiere instalar Ollama/.test(await w.textContent('.wizard')) && /Probar sin cuenta \(experimental\)/.test(await w.textContent('.wizard')), '…con «IA en mi ordenador (requiere Ollama)» y «Probar sin cuenta (experimental)» aparte');

  const start = async () => {
    const n = await app.evaluate(() => global.__opened.length);
    await w.click('.wizard [data-oauth=openrouter]');
    await w.waitForFunction(() => true);
    for (let i = 0; i < 50 && (await app.evaluate(() => global.__opened.length)) === n; i++) await w.waitForTimeout(100);
    const u = new URL(await app.evaluate(() => global.__opened.at(-1)));
    OR.challenge = u.searchParams.get('code_challenge');
    return { u, cb: new URL(u.searchParams.get('callback_url')) };
  };

  // ---- Inicio: PKCE S256 y vuelta solo a la interfaz local ----
  let { u, cb } = await start();
  ok(u.origin + u.pathname === 'https://openrouter.ai/auth' && u.searchParams.get('code_challenge_method') === 'S256' && /^[\w-]{43}$/.test(OR.challenge) && !/verifier/.test(u.href), 'abre openrouter.ai/auth en el navegador del sistema, con PKCE S256 y sin el secreto en la dirección');
  ok(cb.protocol === 'http:' && cb.hostname === 'localhost' && cb.pathname === '/callback' && /^[\w-]{32}$/.test(cb.searchParams.get('state')), 'la vuelta es http://localhost:<puerto>/callback con un «state» aleatorio');
  const lan = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;
  const listens = lan && await new Promise((r) => { const c = require('net').connect({ host: lan, port: +cb.port }); c.setTimeout(800); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); c.on('timeout', () => { c.destroy(); r(false); }); });
  ok(!listens, 'el servidor temporal solo escucha en la interfaz local (no en la red)');

  // ---- Vuelta con un «state» que no es el nuestro: no se canjea ni anula la conexión pendiente ----
  await get(`http://127.0.0.1:${cb.port}/callback?state=OTRO&code=CODIGO-OK`);
  await w.waitForFunction(() => /no es válido o ya se usó/.test(document.querySelector('.oauthMsg')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  ok(/no es válido o ya se usó/.test(await w.textContent('.wizard .oauthMsg')) && !OR.exchanges.length && !(await w.evaluate(() => S.providers.length)), 'un «state» ajeno no canjea nada ni crea la IA');
  ok(await w.evaluate(() => !!localStorage.getItem('neura-oauth')), '…ni borra la conexión pendiente (una vuelta ajena no puede cancelar la buena)');
  ok((await get(`http://127.0.0.1:${cb.port}/callback?state=x`)) === 0, 'tras una vuelta, el servidor temporal se cierra');

  // ---- Cancelar (sin código) ----
  ({ cb } = await start());
  await get(`http://127.0.0.1:${cb.port}/callback?state=${cb.searchParams.get('state')}&error=access_denied`);
  await w.waitForFunction(() => /No se completó/.test(document.querySelector('.oauthMsg')?.textContent || ''), null, { timeout: 5000 }).catch(() => {});
  ok(/No se completó/.test(await w.textContent('.wizard .oauthMsg')) && !OR.exchanges.length, 'si cancelas en OpenRouter, Neura lo explica y no intenta canjear nada');

  // ---- Conexión correcta ----
  ({ cb } = await start());
  const st = cb.searchParams.get('state');
  ok(await w.evaluate(() => !!localStorage.getItem('neura-oauth')), 'mientras está pendiente, el secreto se guarda solo en este dispositivo');
  await get(`http://127.0.0.1:${cb.port}/callback?state=${st}?code=CODIGO-OK`); // como si OpenRouter añadiera «?code=» sin mirar nuestro «?state=»
  await w.waitForFunction(() => S.providers.some((p) => p.oauth), null, { timeout: 10000 }).catch(() => {});
  const pr = await w.evaluate(() => { const p = S.providers.find((x) => x.oauth); return p && { key: p.apiKey, models: p.models, free: p.freeOnly, target: S.target, wiz: !!document.querySelector('.wizard'), pend: localStorage.getItem('neura-oauth') }; });
  ok(pr && pr.key === 'sk-or-v1-PRUEBA' && OR.exchanges.length === 1 && OR.keyChecks === 1 && OR.gens === 0, 'canjea el código con el secreto PKCE, comprueba la clave consultando sus datos (sin generar texto)');
  ok(pr && pr.free && pr.models.every((m) => m.endsWith(':free')) && pr.models.length === 2 && pr.target.endsWith(':free') && !pr.wiz && !pr.pend, `queda conectada con solo los modelos gratuitos, elegida y sin restos pendientes · ${pr?.models}`);
  ok(!fs.readFileSync(path.join(UD, 'neura-datos.json'), 'utf8').includes('CODIGO-OK'), 'el código de un solo uso no se guarda en ningún sitio');

  // ---- Repetición del mismo enlace y caducidad ----
  ok((await get(`http://127.0.0.1:${cb.port}/callback?state=${st}&code=CODIGO-OK`)) === 0, 'el mismo enlace no se puede volver a usar (el servidor ya no está)');
  const replay = await w.evaluate(async (s) => { await finishOAuth({ code: 'CODIGO-OK', state: s }); return document.querySelector('.oauthMsg')?.textContent || $('#toast').textContent; }, st);
  ok(/ya se usó/.test(replay) && OR.exchanges.length === 1, 'aunque llegara de nuevo a la app, un «state» ya usado se rechaza');
  const expired = await w.evaluate(async () => { localStorage.setItem('neura-oauth', JSON.stringify({ verifier: 'v', state: 'S1', exp: Date.now() - 1 })); await finishOAuth({ code: 'c', state: 'S1' }); return $('#toast').textContent; });
  ok(/caducado/.test(expired) && OR.exchanges.length === 1, 'pasados 10 minutos la conexión caduca y no se canjea');

  // ---- SOLO GRATIS en la cuenta conectada: ni a mano, ni en AUTO-SALTO, CONSEJO o el Gateway ----
  const fo = await w.evaluate(() => {
    const p = S.providers.find((x) => x.oauth); p.models.push('openai/caro'); save();
    return { t: targets().filter((t) => t.pid === p.id).map((t) => t.model), gw: gatewayPayload().providers.map((x) => x.model) };
  });
  ok(!fo.t.includes('openai/caro') && !fo.gw.includes('openai/caro') && fo.t.length === 2, 'aunque se escriba un modelo de pago a mano, la cuenta conectada solo ofrece los gratuitos (AUTO-SALTO, CONSEJO y Gateway usan esa lista)');
  await w.click('#btnAis');
  ok(/revócala en/.test(await w.textContent('#provList')), 'su tarjeta explica que ✕ borra la clave del dispositivo y cómo revocarla en OpenRouter');
  await w.keyboard.press('Escape');

  // ---- Probar sin cuenta (Pollinations): si falla, se explica y se ofrece conectar la cuenta ----
  await w.evaluate(() => { S.providers = []; S.wizardDone = false; S.active = null; save(); renderTargets(); renderLog(); });
  await w.click('.tryFree summary'); await w.click('#wzTry');
  const poll = await w.evaluate(() => { const p = S.providers.find((x) => x.preset === 'pollinations'); return { key: p?.apiKey, target: S.target }; });
  ok(poll.key === '' && /openai-fast$/.test(poll.target), '«Probar sin cuenta» añade Pollinations sin clave y la deja elegida');
  await w.fill('#input', 'hola'); await w.click('#send');
  await w.waitForSelector('.reply .err, .reply.error, .msg.error', { timeout: 15000 }).catch(() => {});
  await w.waitForFunction(() => !busy, null, { timeout: 15000 }).catch(() => {});
  ok(/Conectar mi cuenta/.test(await w.textContent('#log')), 'si el acceso sin cuenta no responde, lo explica y propone «Conectar mi cuenta» (sin reintentos sin fin)');
  OR.pollDown = false;
  await w.fill('#input', 'otra'); await w.click('#send');
  await w.waitForFunction(() => /hola sin cuenta/.test(document.querySelector('#log').textContent), null, { timeout: 15000 }).catch(() => {});
  ok(/hola sin cuenta/.test(await w.textContent('#log')), 'cuando funciona, responde sin cuenta ni clave');
  const dg = await w.evaluate(async () => { await diagnose(); return document.getElementById('diagOut')?.textContent || ''; }).catch(() => '');
  ok(!/falta la clave/.test(dg), 'el diagnóstico no pide clave a la IA sin cuenta');

  // ---- PEGAR: lee el portapapeles tras pulsar y sugiere el proveedor por el formato ----
  await w.evaluate(() => { S.active = null; S.wizardDone = false; S.providers = []; save(); renderTargets(); renderLog(); });
  await w.click('[data-wz=cloud]');
  await w.click('#wzPaste');
  await w.waitForFunction(() => document.querySelector('#wzApiKey')?.value, null, { timeout: 5000 }).catch(() => {});
  ok(await w.inputValue('#wzApiKey') === 'gsk_ClaveDePrueba123' && await w.inputValue('#wzPreset') === 'groq' && /Parece una clave de Groq/.test(await w.textContent('#wzMsg')), 'PEGAR rellena la clave y sugiere Groq por su formato (gsk_), sin decidir por ti');
  await app.close();

  // ---- Web: la vuelta llega a la propia página y se borra de la barra de direcciones ----
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-br-'));
  const br = spawn(process.execPath, [path.join(__dirname, '../../bridge/server.mjs')], { env: { ...process.env, PORT: '8798', HOST: '127.0.0.1', NEURA_TOKEN: 'x'.repeat(24), NEURA_DATA: data, NEURA_CONFIG: '/nonexistent.json' } });
  await new Promise((r) => br.stdout.on('data', (d) => String(d).includes('Backends') && r()));
  const b = await chromium.launch(); const p = await b.newPage({ locale: 'es-ES' });
  p.on('pageerror', (e) => { console.log('PAGEERROR web', e.message); failures++; });
  OR.exchanges = [];
  await p.route('https://openrouter.ai/**', async (route) => {
    const r = route.request(), url = new URL(r.url());
    if (url.pathname === '/auth') { OR.challenge = url.searchParams.get('code_challenge'); return route.fulfill({ status: 302, headers: { location: url.searchParams.get('callback_url') + '?code=CODIGO-OK' } }); }
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const [c, o] = handle(r.method(), url.pathname, r.headers().authorization, r.postData());
    return route.fulfill({ status: c, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(o) });
  });
  await p.goto('http://127.0.0.1:8798/');
  await p.waitForSelector('.wizard');
  await p.click('.wizard [data-oauth=openrouter]');
  await p.waitForFunction(() => typeof S !== 'undefined' && S.providers.some((x) => x.oauth), null, { timeout: 15000 }).catch(() => {});
  ok(await p.evaluate(() => S.providers.some((x) => x.oauth && x.apiKey === 'sk-or-v1-PRUEBA')) && OR.exchanges.length === 1, 'web: vuelve a la propia página, canjea el código y conecta la cuenta');
  ok(!/code=|state=|oauth=/.test(p.url()), `web: el código y el «state» se borran de la barra de direcciones · ${p.url()}`);
  await b.close(); br.kill(); srv.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
