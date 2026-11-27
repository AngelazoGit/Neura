// Extrae los textos visibles de la interfaz (app/index.html y app/app.js) para traducirlos.
// Uso: node tools/i18n-extract.mjs > textos.json   (necesita «acorn»: npm i --no-save acorn)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let acorn;
try { acorn = require('acorn'); } catch { acorn = require('/opt/node-tools/node_modules/acorn'); }
const root = new URL('../app/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const js = readFileSync(new URL('app.js', root), 'utf8');
const out = new Set();
const add = (t) => {
  t = t.replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || !/\p{L}{2}/u.test(t)) return;
  if (/^[a-z][\w-]*$/.test(t) || /^[\w-]+(\.[\w-]+)+$/.test(t) || /^[#.\[]/.test(t)) return; // identificadores, selectores
  if (/^[?&][\w-]+=|^(neura|lib):$|^(AB|Notification)$/.test(t)) return; // trozos de URL y valores internos
  if (/[{}]|=>|;\s*$|;\s*(const|let|var|return|if)\b|https?:\/\/|^\/|^[a-z-]+:[^ ]/.test(t)) return; // código, URLs
  if (/="|^[<>"]|^--|^[a-z]+\/[a-z+.-]+$|^[A-Z][a-z]+(-[A-Z][a-z]+)+$|^(GET|POST|PBKDF2|AES-GCM|SHA-256|NFD|IndexedDB|AbortError|Bearer|Escape|Enter|PK|EUR|USD|JPY|HTTP|use strict)$|^[a-z0-9.]+:\d|^_|^\d/.test(t)) return; // atributos, tipos MIME, cabeceras, constantes
  out.add(t);
};
const fromMarkup = (s) => {
  // Trozos de plantilla que empiezan dentro de una etiqueta (\`">TEXTO\`, \`checked> TEXTO\`) o acaban en una a medias.
  s = s.replace(/^[^<>]*>/, '').replace(/<[^>]*$/, '');
  for (const m of s.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)) add(m[1]);
  for (const part of s.replace(/<[^>]*>/g, '\u0000').split('\u0000')) add(part);
};
fromMarkup(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ''));
// Recorre el árbol del código: literales de texto y partes fijas de las plantillas `…${}…`.
// Se omiten las expresiones regulares y los argumentos de selectores, clases y almacenamiento.
const skipCallee = new Set(['querySelector', 'querySelectorAll', '$', 'getElementById', 'closest', 'getItem', 'setItem', 'toggle', 'contains', 'add', 'remove', 'addEventListener', 'matchMedia', 'createElement', 'getAttribute', 'setAttribute', 'open', 'get', 'require', 'fetch', 'xfetch', 'mcpRpc', 'W', 'startsWith', 'endsWith', 'includes', 'split', 'join', 'padStart', 'replace', 'match', 'test', 'decode', 'encode', 'matches']);
function walk(n, parent) {
  if (!n || typeof n.type !== 'string') return;
  const calleeName = parent?.type === 'CallExpression' && (parent.callee.property?.name || parent.callee.name);
  if (n.type === 'Literal' && typeof n.value === 'string' && !n.regex) { if (!skipCallee.has(calleeName)) fromMarkup(n.value); }
  else if (n.type === 'TemplateElement') fromMarkup(n.value.cooked ?? n.value.raw);
  for (const k of Object.keys(n)) {
    if (k === 'parent') continue;
    const v = n[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, n)); else if (v && typeof v.type === 'string') walk(v, n);
  }
}
walk(acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'script' }));
console.log(JSON.stringify([...out].sort(), null, 0).replace(/","/g, '",\n"'));
