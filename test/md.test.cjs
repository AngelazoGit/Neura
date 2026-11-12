// node --test test/md.test.cjs — el Markdown de las respuestas no debe poder inyectar HTML ni enlaces peligrosos.
const test = require('node:test');
const assert = require('node:assert/strict');
global.window = {};
require('../app/md.js');
const md = window.NeuraMD.render;

test('escapa HTML y no enlaza javascript:', () => {
  const out = md('<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1))');
  assert.ok(!/<script|<img|href="javascript/i.test(out));
});
test('listas, tablas, código y enlaces http', () => {
  const out = md('- a\n  - b\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n```js\nx<y\n```\n[ok](https://e.com/?a=1&b=2)');
  assert.match(out, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/);
  assert.match(out, /<td class="ar">2<\/td>/);
  assert.match(out, /<pre><code data-lang="js">x&lt;y<\/code><\/pre>/);
  assert.match(out, /href="https:\/\/e\.com\/\?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"/);
});
