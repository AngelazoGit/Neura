// Interfaz en varios idiomas: inglés por defecto en un equipo en inglés, cambio a chino, y nunca se traduce el contenido.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path'), os = require('os');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'neura-ud-'));
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
const launch = () => _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD, '--lang=en-US'] });

(async () => {
  await mocks.start();
  // Equipo nuevo en inglés: Neura arranca en inglés.
  let app = await launch(), w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForSelector('.wizard', { timeout: 20000 });
  ok(await w.evaluate(() => S.lang === 'en' && document.documentElement.lang === 'en'), 'en un equipo nuevo en inglés, la interfaz arranca en inglés');
  ok(/SEND/.test(await w.textContent('#send')) && !/ENVIAR/.test(await w.textContent('#send')), 'el botón ENVIAR aparece como SEND');
  ok(!/ESPERANDO ENTRADA|EMPIEZA CON LA IA/.test(await w.textContent('#log')), 'la pantalla inicial está traducida');
  ok(await w.evaluate(() => /Always answer in English/.test(S.instructions)), 'las instrucciones por defecto piden responder en inglés');
  // Una IA y un mensaje en español: el contenido no se traduce.
  await w.evaluate(() => {
    S.providers.push({ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido'], enabled: true });
    S.target = 'm::rapido'; S.wizardDone = true; S.level = 'pro'; save(); renderTargets(); renderLog();
  });
  await w.fill('#input', 'Hola, ¿qué tal? Responde en una tabla');
  await w.click('#send');
  await w.waitForFunction(() => document.querySelector('#send').textContent.includes('SEND') && !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg').length > 1);
  const user = await w.$$eval('#log .msg.user .body', (b) => b.at(-1).innerText);
  const reply = await w.$$eval('#log .reply .txt', (b) => b.at(-1).innerText);
  ok(user === 'Hola, ¿qué tal? Responde en una tabla' && /Hola desde rapido/.test(reply), 'tu mensaje y la respuesta de la IA se quedan tal cual (no se traducen)');
  ok(/Always answer in English/.test(mocks.log.at(-1).system.join(' ')), 'la IA recibe la instrucción de responder en inglés');
  ok(/COPY/.test(await w.$$eval('#log .reply', (r) => r.at(-1).innerText)) && (await w.$$eval('.adjust button', (b) => b.map((x) => x.innerText).join(' '))).match(/Shorter|Simpler/i), 'los botones de la respuesta y los ajustes rápidos están traducidos');
  await w.click('.adjust button >> nth=0');
  await w.waitForFunction(() => !document.querySelector('.reply.pending') && document.querySelectorAll('#log .msg.user').length === 2);
  ok(!/Hazla más corta/.test(mocks.log.at(-1).q), 'el ajuste rápido se pide en el idioma de la interfaz · ' + mocks.log.at(-1).q);
  await w.click('#structBtn'); await w.click('[data-tpl=correo]'); await w.click('[data-tpl=make]');
  const pr = await w.inputValue('#input');
  ok(/\*\*Role:\*\*/.test(pr) && !/Actúa como/.test(pr), 'las Plantillas PRO montan la petición en inglés · ' + pr.slice(0, 60));
  await w.fill('#input', '');
  await w.click('#btnAis');
  const set = await w.textContent('#settings');
  ok(/LEVEL/.test(set) && /FREE ONLY/.test(set) && !/MEMORIA DE CONTEXTO|SEGURIDAD DE LAS CLAVES/.test(set), 'los ajustes están en inglés');
  // Nombres tuyos que coinciden con textos de la app: no se traducen.
  await w.keyboard.press('Escape');
  await w.evaluate(() => {
    S.skills.push({ id: 'u1', name: 'Plan de proyecto', description: 'mía', instructions: 'x', version: 1, updatedAt: 1 });
    S.projects.push({ id: 'p1', name: 'Resumir un documento', memory: '', updatedAt: 1 }); save();
  });
  await w.click('#btnSkills');
  ok((await w.$$eval('#skillList .srv', (b) => b.map((x) => x.innerText))).includes('✦ Plan de proyecto'), 'el nombre de tu habilidad no se traduce aunque coincida con un texto de la app');
  await w.keyboard.press('Escape'); await w.click('#btnThreads');
  ok((await w.$$eval('#projectSel option', (o) => o.map((x) => x.textContent))).includes('📁 Resumir un documento') && /ALL THREADS/.test(await w.textContent('#projectSel')), '…ni el de tu proyecto (las opciones fijas sí)');
  await w.keyboard.press('Escape'); await w.click('#btnAis');
  // Cambio a chino desde ⚙ (recarga la app).
  await Promise.all([w.waitForEvent('load'), w.selectOption('#langSel', 'zh')]);
  await w.waitForSelector('#send');
  ok(await w.evaluate(() => S.lang === 'zh' && /简体中文/.test(S.instructions)), 'al cambiar a chino, la interfaz y las instrucciones por defecto pasan al chino');
  ok(/发送/.test(await w.textContent('#send')), 'el botón de enviar está en chino');
  ok(await w.$$eval('#log .msg.user .body', (b) => b[0].innerText) === 'Hola, ¿qué tal? Responde en una tabla', '…y los mensajes siguen sin traducir');
  await w.click('#btnSkills');
  ok((await w.$$eval('#skillList .srv', (b) => b.map((x) => x.innerText))).includes('✦ Plan de proyecto'), '…ni el nombre de tu habilidad');
  await w.keyboard.press('Escape');
  // Y de vuelta al español: todo vuelve, sin restos de otros idiomas.
  await w.click('#btnAis');
  await Promise.all([w.waitForEvent('load'), w.selectOption('#langSel', 'es')]);
  await w.waitForSelector('#send');
  ok(/ENVIAR/.test(await w.textContent('#send')) && await w.evaluate(() => /Responde siempre en español/.test(S.instructions)) && !/[\u4e00-\u9fff]/.test(await w.textContent('#app')), 'de vuelta al español: interfaz e instrucciones en español, sin restos de chino');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
