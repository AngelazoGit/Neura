'use strict';
// Markdown seguro para las respuestas: todo se escapa y solo se generan etiquetas conocidas
// (código, títulos, listas, citas, tablas, enlaces http/https, negrita, cursiva, tachado).
window.NeuraMD = (() => {
  const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;

  function inline(src) {
    const stash = [];
    const put = (html) => `\u0000${stash.push(html) - 1}\u0000`;
    let s = String(src)
      .replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`))
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => put(link(u, esc(t))))
      .replace(/\bhttps?:\/\/[^\s<>()\u0000]*[^\s<>().,;:!?'"\u0000]/g, (u) => put(link(u, esc(u))));
    s = esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_\n]+)__/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>')
      .replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[i]);
  }

  const RE = {
    fence: /^\s*(```|~~~)\s*([\w+#.-]*)/,
    head: /^(#{1,6})\s+(.*)$/,
    hr: /^\s*([-*_])(\s*\1){2,}\s*$/,
    quote: /^\s*>/,
    item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
    sep: /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,
  };
  const isTable = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && RE.sep.test(lines[i + 1]);
  const startsBlock = (lines, i) => RE.fence.test(lines[i]) || RE.head.test(lines[i]) || RE.hr.test(lines[i])
    || RE.quote.test(lines[i]) || RE.item.test(lines[i]) || isTable(lines, i);

  function buildList(items, a, b) {
    const base = items[a].ind, ord = items[a].ord;
    let html = ord ? `<ol${items[a].start > 1 ? ` start="${items[a].start}"` : ''}>` : '<ul>';
    for (let k = a; k < b;) {
      let j = k + 1;
      while (j < b && items[j].ind > base) j++;
      html += `<li>${inline(items[k].text).replace(/\n/g, '<br>')}${j > k + 1 ? buildList(items, k + 1, j) : ''}</li>`;
      k = j;
    }
    return html + (ord ? '</ol>' : '</ul>');
  }

  function render(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0, m;
    while (i < lines.length) {
      const l = lines[i];
      if ((m = l.match(RE.fence))) {
        const buf = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) buf.push(lines[i]);
        i++;
        out.push(`<pre><code${m[2] ? ` data-lang="${esc(m[2])}"` : ''}>${esc(buf.join('\n'))}</code></pre>`);
      } else if (!l.trim()) i++;
      else if ((m = l.match(RE.head))) { out.push(`<b class="h h${m[1].length}">${inline(m[2])}</b>`); i++; }
      else if (RE.hr.test(l)) { out.push('<hr>'); i++; }
      else if (RE.quote.test(l)) {
        const buf = [];
        while (i < lines.length && RE.quote.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
      } else if (isTable(lines, i)) {
        const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const head = cells(l);
        const al = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? ' class="ac"' : c.endsWith(':') ? ' class="ar"' : ''));
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|') && lines[i].trim(); i++) rows.push(cells(lines[i]));
        out.push(`<div class="tbl"><table><thead><tr>${head.map((c, k) => `<th${al[k] || ''}>${inline(c)}</th>`).join('')}</tr></thead>`
          + `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td${al[k] || ''}>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      } else if (RE.item.test(l)) {
        const items = [];
        while (i < lines.length) {
          const it = lines[i].match(RE.item);
          if (it) { items.push({ ind: it[1].replace(/\t/g, '    ').length, ord: /\d/.test(it[2]), start: parseInt(it[2], 10) || 1, text: it[3] }); i++; }
          else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) items[items.length - 1].text += '\n' + lines[i++].trim();
          else break;
        }
        out.push(buildList(items, 0, items.length));
      } else {
        const buf = [];
        while (i < lines.length && lines[i].trim() && !(buf.length && startsBlock(lines, i))) buf.push(inline(lines[i++]));
        out.push(`<p>${buf.join('<br>')}</p>`);
      }
    }
    return out.join('');
  }
  return { render };
})();
