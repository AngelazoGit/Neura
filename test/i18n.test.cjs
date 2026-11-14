// Cada texto de la interfaz tiene traducción en inglés, chino y ruso (si se añade uno nuevo, hay que traducirlo:
// node tools/i18n-extract.mjs > tools/i18n/es.json, traducir y node tools/i18n-build.mjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
const win = {};
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'app/i18n.js'), 'utf8'), { window: win });
let source;
try { source = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools/i18n-extract.mjs')], { encoding: 'utf8' })); } catch { source = null; }

for (const lang of ['en', 'zh', 'ru']) {
  test(`interfaz traducida al completo: ${lang}`, { skip: !source && 'sin acorn para extraer los textos' }, () => {
    const d = win.NEURA_I18N?.[lang] || {};
    const missing = source.filter((k) => !d[k]);
    assert.deepEqual(missing.slice(0, 20), [], `${missing.length} textos sin traducir en ${lang}`);
  });
  test(`las traducciones conservan emojis y marcadores: ${lang}`, () => {
    const d = win.NEURA_I18N?.[lang] || {};
    const bad = Object.entries(d).filter(([k, v]) => {
      const lead = k.match(/^\p{Extended_Pictographic}/u)?.[0];
      return (lead && !v.includes(lead)) || (/\*\*/.test(k) && !/\*\*/.test(v)) || (/\/imagen/.test(k) && !/\/imagen/.test(v));
    }).map(([k]) => k);
    assert.deepEqual(bad.slice(0, 20), [], `${bad.length} traducciones pierden emojis o marcadores`);
  });
}
