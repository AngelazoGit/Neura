// Consumo y gasto: panel por IA (app y Gateway), límite diario por proveedor y tope de gasto en €.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [
    { id: 'm', preset: 'groq', name: 'GRATIS', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido'], enabled: true, dailyLimit: 2 },
    // 1.000.000 € por millón de tokens = 1 € por token: el gasto se ve enseguida.
    { id: 'oa', preset: 'openai', name: 'PAGO', kind: 'openai', tier: 'paid', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k2', models: ['caro'], enabled: true, price: { in: 1e6, out: 1e6 } },
    { id: 'ds', preset: 'deepseek', name: 'SINPRECIO', kind: 'openai', tier: 'paid', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k3', models: ['otro'], enabled: false },
  ],
  mcp: [], threads: [], target: 'oa::caro', autoSkip: true, level: 'pro',
}));

(async () => {
  await mocks.start();
  const app = await _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
  const w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('#target option', { state: 'attached' });
  const sendMsg = async (t) => {
    await w.fill('#input', t); await w.click('#send');
    await w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg').length > 0);
  };

  await sendMsg('hola de pago');
  const u = await w.evaluate(() => { const d = S.usage[today()]['oa::caro']; return { ...d, sp: spent() }; });
  ok(u.n === 1 && u.in > 0 && u.out > 0 && Math.abs(u.eur - (u.in + u.out)) < 1e-6, `cuenta peticiones, tokens aproximados y gasto según el precio · ${u.in}+${u.out} tokens = ${u.eur} €`);
  await w.click('#btnAis');
  const panel = await w.textContent('#usagePanel');
  ok(/CONSUMO/.test(panel) && /PAGO/.test(panel) && /Gasto de hoy/.test(panel), 'el panel de consumo muestra cada IA y el gasto de hoy y del mes');
  await w.evaluate(() => { S.providers.find((p) => p.id === 'ds').enabled = true; renderProviders(); });
  ok(/SINPRECIO: de pago sin precio/.test(await w.textContent('#usagePanel')), 'avisa de las IAs de pago sin precio (su gasto no se puede contar)');
  await w.evaluate(() => { S.providers.find((p) => p.id === 'ds').enabled = false; renderProviders(); });
  ok(await w.$eval('#provList [data-pid=oa] input[data-f=priceIn]', (e) => e.value) === '1000000' && !(await w.$('#provList [data-pid=m] input[data-f=priceIn]')), 'el precio se pone en la tarjeta de las IAs de pago (no en las gratuitas)');

  // Tope de gasto: por debajo, la de pago se usa; al llegar, solo gratuitas.
  await w.fill('#budgetDay', String(Math.ceil(u.eur) + 100000)); await w.$eval('#budgetDay', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  ok(await w.evaluate(() => S.budget.day > 0 && !overBudget() && allowed(findT('oa::caro'))), 'con gasto por debajo del tope, la IA de pago sigue disponible');
  await w.fill('#budgetDay', '1'); await w.$eval('#budgetDay', (e) => e.dispatchEvent(new Event('change', { bubbles: true })));
  ok(/TOPE ALCANZADO/.test(await w.textContent('#usagePanel')), 'el panel avisa de que se alcanzó el tope');
  await w.keyboard.press('Escape');
  const before = mocks.calls.caro || 0;
  await sendMsg('otra con tope');
  const last = await w.$$eval('#log .reply', (r) => r.map((x) => x.innerText).join('\n'));
  ok((mocks.calls.caro || 0) === before && /tope de gasto/.test(last) && /Hola desde rapido/.test(last), 'con el tope alcanzado no se usa la de pago: contesta una gratuita y se explica por qué');

  // Límite diario del proveedor gratuito: 2 peticiones (la de antes cuenta).
  await w.evaluate(() => { S.budget = {}; S.target = 'm::rapido'; save(); renderTargets(); });
  await sendMsg('segunda gratis');
  const h = await w.evaluate(() => ({ used: provToday(S.providers[0]), reason: S.health['m::rapido']?.reason, cool: cooling('m::rapido') }));
  ok(h.used === 2 && h.reason === 'LÍMITE' && h.cool, JSON.stringify(h) + ' · ' + 'al llegar al límite diario que pones, Neura deja de usarla hasta mañana');
  const rapido = mocks.calls.rapido;
  await sendMsg('tercera');
  ok(mocks.calls.rapido === rapido && /LÍMITE DIARIO/.test(await w.$$eval('#log .reply', (r) => r.map((x) => x.innerText).join('\n'))), '…y AUTO-SALTO pasa a otra IA avisando del límite');

  // Gateway: su consumo aparece aparte.
  await w.evaluate(() => { S.health = {}; S.gateway = { enabled: true }; save(); });
  await w.waitForTimeout(800);
  const b = await w.evaluate(() => window.neuraDesktop.bridge());
  const r = await fetch(`http://127.0.0.1:${b.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${b.gatewayToken}` }, body: JSON.stringify({ model: 'gratis/rapido', messages: [{ role: 'user', content: 'desde otra herramienta' }] }) });
  ok(r.status === 200, 'petición por el Gateway');
  await w.waitForTimeout(300);
  await w.click('#btnAis');
  await w.waitForFunction(() => /POR EL GATEWAY/.test(document.querySelector('#usagePanel').textContent), null, { timeout: 5000 })
    .then(() => ok(true, 'el panel muestra aparte lo que ha pasado por el Gateway'), () => ok(false, 'consumo del Gateway en el panel'));
  ok(/gratis\/rapido/.test(await w.textContent('#usagePanel')), '…por destino');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
