// Genera app/i18n.js con los diccionarios de tools/i18n/{en,zh,ru}.json (claves: textos en español de la interfaz).
// Uso: node tools/i18n-build.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const dir = new URL('./i18n/', import.meta.url);
const out = {};
for (const l of ['en', 'zh', 'ru']) {
  const f = new URL(`${l}.json`, dir);
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, 'utf8'));
  // Solo traducciones reales (no vacías); se quitan espacios sobrantes en los extremos de las claves.
  out[l] = Object.fromEntries(Object.entries(d).filter(([k, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k.trim(), v]));
}
writeFileSync(new URL('../app/i18n.js', import.meta.url), `// Generado por tools/i18n-build.mjs: no editar a mano.\nwindow.NEURA_I18N = ${JSON.stringify(out)};\n`);
console.log(Object.entries(out).map(([l, d]) => `${l}: ${Object.keys(d).length}`).join(' · '));
