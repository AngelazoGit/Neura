// Habilidades: crear con IA, probar, guardar, activar, versiones, AUTO-SALTO, importar/exportar, desde respuesta.
const { _electron } = require('playwright'); const fs = require('fs'), path = require('path');
const mocks = require('./mocks.cjs');
const ROOT = path.join(__dirname, '../../desktop');
const UD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'neura-ud-'));
const SHOT = path.join(require('os').tmpdir(), 'neura-shots'); fs.mkdirSync(SHOT, { recursive: true });
let failures = 0; const ok = (c, m) => { console.log(c ? '✓' : '✗', m); if (!c) failures++; };
fs.writeFileSync(path.join(UD, 'neura-datos.json'), JSON.stringify({
  providers: [{ id: 'm', preset: 'groq', name: 'MOCK', kind: 'openai', tier: 'free', baseUrl: 'http://127.0.0.1:5601/v1', apiKey: 'k', models: ['rapido', 'cuota'], enabled: true }],
  mcp: [], threads: [], target: 'm::rapido', autoSkip: true,
}));
const launch = () => _electron.launch({ executablePath: require(ROOT + '/node_modules/electron'), cwd: ROOT, args: [ROOT, '--user-data-dir=' + UD] });
const idle = (w) => w.waitForFunction(() => document.querySelector('#send').textContent.includes('ENVIAR') && !document.querySelector('.reply.pending'), null, { timeout: 20000 });
const send = async (w, t) => { await w.fill('#input', t); await w.click('#send'); await idle(w); };
const setT = (w, k) => w.evaluate((k) => { const s = document.querySelector('#target'); s.value = k; s.dispatchEvent(new Event('change')); }, k);
const lastReply = (w) => w.$$eval('#log .reply:not(.err)', (r) => r.at(-1).innerText);

(async () => {
  await mocks.start();
  let app = await launch(); let w = await app.firstWindow();
  w.on('pageerror', (e) => { console.log('PAGEERROR', e.message); failures++; });
  await w.waitForFunction(() => [...document.querySelectorAll('#target option')].some((o) => o.textContent.includes('ESTE PC')), null, { timeout: 20000 });

  await w.click('#btnSkills'); await w.click('#skNew');
  await w.fill('#skGoal', 'convierte mis apuntes en un resumen y preguntas de repaso');
  await w.click('#skGen');
  await w.waitForSelector('#skInstr', { timeout: 10000 });
  ok((await w.inputValue('#skName')) === 'apuntes de estudio' && /preguntas/.test(await w.inputValue('#skInstr')), 'CREAR CON IA: borrador con nombre, descripción e instrucciones (aunque venga entre ```)');
  await w.fill('#skSample', 'La fotosíntesis convierte luz en energía');
  await w.click('#skTest');
  await w.waitForSelector('#skResult .reply', { timeout: 10000 });
  ok(/Aplicando apuntes de estudio vprueba/.test(await w.$eval('#skResult', (e) => e.innerText)), 'PROBAR: la IA recibe el borrador y responde en el panel, sin tocar el hilo');
  await w.screenshot({ path: SHOT + '/skill-editor.png' });
  await w.click('#skSave');
  await w.click('[data-sk=use]');
  const bar = await w.textContent('#btnSkills');
  ok(bar === '✦ APUNTES DE ESTUDIO · v1', 'la barra muestra la habilidad activa: ' + bar);

  await send(w, 'tema 1: células');
  let r = await lastReply(w);
  ok(/Aplicando apuntes de estudio v1/.test(r) && /✦ apuntes de estudio · v1/.test(r), 'cada respuesta usa la habilidad y lo indica (✦ … · v1)');
  ok(mocks.log.at(-1).system.some((x) => /solo en español/.test(x) && /Habilidad activa/.test(x)), 'instrucciones globales + habilidad en un único mensaje de sistema');

  await setT(w, 'm::cuota');
  await send(w, 'tema 2');
  r = await lastReply(w);
  ok(/Aplicando apuntes de estudio v1 con/.test(r), 'tras un AUTO-SALTO la otra IA sigue aplicando la habilidad');
  await setT(w, 'm::rapido');

  await w.click('#btnSkills'); await w.click('[data-sk=edit]');
  await w.fill('#skInstr', '1. Resume en 3 viñetas.\n2. Haz 3 preguntas.');
  await w.click('#skSave'); await w.keyboard.press('Escape');
  await send(w, 'tema 3');
  const chips = await w.$$eval('#log .chip.skill', (c) => c.map((x) => x.textContent));
  ok(chips.at(-1).endsWith('v2') && chips[0].endsWith('v1'), 'al editar sube a v2; las respuestas antiguas conservan la versión que usaron');

  await w.click('#btnSkills'); await w.click('#skImport');
  await w.setInputFiles('#skFile', path.join(__dirname, 'fixtures/SKILL-redaccion.md'));
  await w.waitForSelector('#skName');
  ok((await w.inputValue('#skName')) === 'redaccion con mi estilo', 'IMPORTAR SKILL.md: entra como borrador para revisarlo antes de guardar');
  await w.click('#skSave');
  ok((await w.$$('#skillList .card')).length === 2, 'biblioteca con 2 habilidades');
  const mdText = await w.evaluate('skillMd(S.skills[0])');
  const back = await w.evaluate((t) => parseSkillMd(t), mdText);
  ok(/^---\nname: apuntes-de-estudio\n/.test(mdText) && back.instructions.includes('3 viñetas'), 'EXPORTAR genera un SKILL.md estándar que se vuelve a importar igual');
  const yaml = await w.evaluate(() => [
    parseSkillMd('---\nname: notas\ndescription: >\n  Resume notas largas\n  y crea preguntas.\n---\n\n# Notas\n1. Paso'),
    parseSkillMd('---\nname: lista\ndescription: |\n  Línea uno\n  Línea dos\n---\ncuerpo'),
    parseSkillMd('---\nname: plano\ndescription: Empieza aquí\n  y sigue en la siguiente línea\n---\ncuerpo'),
  ]);
  ok(yaml[0].description === 'Resume notas largas y crea preguntas.' && yaml[0].instructions.startsWith('# Notas')
    && yaml[1].description === 'Línea uno\nLínea dos' && yaml[2].description === 'Empieza aquí y sigue en la siguiente línea',
    'SKILL.md: descripciones multilínea en YAML (>, | y continuación sangrada)');
  await w.keyboard.press('Escape');

  await w.click('#log .reply:not(.err) [data-skillify]');
  await w.waitForSelector('#skInstr', { timeout: 10000 });
  ok(true, '✦ HABILIDAD en una respuesta crea un borrador a partir de ella');
  await w.click('#skCancel'); await w.keyboard.press('Escape');

  await w.click('#btnThreads'); await w.click('#newThread');
  ok((await w.textContent('#btnSkills')) === '✦ HABILIDADES', 'un hilo nuevo empieza sin habilidad activa');
  await w.screenshot({ path: SHOT + '/skills-bar.png' });
  await app.close();

  app = await launch(); w = await app.firstWindow();
  await w.waitForSelector('#target option', { state: 'attached' });
  await w.click('#btnSkills');
  ok((await w.$$('#skillList .card')).length === 2, 'las habilidades se conservan al reiniciar');
  await app.close();
  console.log(failures ? `FALLOS: ${failures}` : 'TODO OK'); process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
