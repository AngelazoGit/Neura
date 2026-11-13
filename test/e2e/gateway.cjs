// Fase 2: Neura Gateway. Otras herramientas usan Neura (tus IAs, AUTO-SALTO, SOLO GRATIS) como proveedor
// a través de las API compatibles con OpenAI y con Anthropic del puente del PC.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [
    { id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['cuota', 'rapido'], enabled: true },
    { id: 'oa', preset: 'openai', name: 'PAGO', kind: 'openai', tier: 'paid', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k2', models: ['rapido'], enabled: true },
  ],
  mcp: [], threads: [], target: 'm::cuota', autoSkip: true, level: 'pro',
}));

(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('#target option', { state: 'attached' });
  await w.waitForFunction(() => typeof S !== 'undefined' && S.mcp[0]?.status === 'on', null, { timeout: 20000 });
  const b = await w.evaluate(() => window.neuraDesktop.bridge());
  const BASE = `http://127.0.0.1:${b.port}`;
  const api = (p, body, h = { Authorization: `Bearer ${b.token}` }) => fetch(BASE + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...h }, body: body && JSON.stringify(body) });
  const chat = async (model = 'auto') => (await (await api('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hola gateway' }] })).json());
  const ids = async () => (await (await api('/v1/models')).json()).data.map((m) => m.id);

  ok((await api('/v1/models')).status === 404, 'desactivado por defecto');
  await w.click('#btnMcp'); await w.check('[data-act=gw]');
  await w.waitForSelector('.snip', { state: 'attached' });
  const snips = await w.$$eval('.snip', (s) => s.map((x) => x.textContent).join('\n'));
  ok(snips.includes(`${BASE}/v1`) && snips.includes(b.token) && /ANTHROPIC_BASE_URL/.test(snips), 'al activarlo, muestra la configuración para Continue, Cline, Aider, Open WebUI y Claude Code con la URL y el token');
  await w.waitForTimeout(800);

  const list = await ids();
  ok(list[0] === 'auto' && list.includes('mock/rapido') && list.includes('pago/rapido') && list.includes('ollama/qwen3:4b'), '/v1/models: auto, tus IAs de internet y los modelos del PC · ' + list.join(', '));
  const cuota0 = mocks.calls.cuota || 0;
  const r = await chat();
  ok(/Hola desde rapido/.test(r.choices?.[0]?.message?.content) && mocks.calls.cuota === cuota0 + 1, 'con «auto», la elegida en Neura da 429 y contesta la siguiente (AUTO-SALTO)');
  await chat();
  ok(mocks.calls.cuota === cuota0 + 1, 'la que dio 429 queda en pausa para las siguientes peticiones');

  const a = await (await api('/v1/messages', { model: 'claude-sonnet-x', max_tokens: 100, messages: [{ role: 'user', content: 'hola anthropic' }] }, { 'x-api-key': b.token, 'anthropic-version': '2023-06-01' })).json();
  ok(a.type === 'message' && /Hola desde/.test(a.content?.[0]?.text), 'API compatible con Anthropic (/v1/messages, clave en x-api-key)');
  ok((await api('/v1/models', null, { Authorization: 'Bearer falso' })).status === 401, 'sin el token correcto: 401');

  await w.keyboard.press('Escape');
  await w.click('#btnAis'); await w.check('#freeOnly'); await w.keyboard.press('Escape'); await w.waitForTimeout(800);
  ok(!(await ids()).includes('pago/rapido'), 'SOLO GRATIS también se aplica al Gateway (la IA de pago desaparece)');

  await w.click('#btnMcp'); await w.check('[data-act=gwlocal]'); await w.waitForTimeout(800);
  const loc = await ids();
  ok(loc.includes('ollama/qwen3:4b') && !loc.some((x) => x.startsWith('mock/')), 'SOLO MODELOS DE ESTE EQUIPO: solo los del PC');
  ok(/local dice/.test((await chat()).choices?.[0]?.message?.content), '…y responde la IA del equipo');

  await w.uncheck('[data-act=gw]'); await w.waitForTimeout(800);
  ok((await api('/v1/models')).status === 404, 'al desactivarlo deja de responder');
  await w.keyboard.press('Escape');

  await w.evaluate(() => { S.level = 'basic'; save(); });
  await w.click('#btnMcp');
  ok(!(await w.$('[data-act=gw]')), 'en modo principiante la sección del Gateway no aparece');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
