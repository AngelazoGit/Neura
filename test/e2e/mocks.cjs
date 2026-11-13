// Servidores simulados: IA compatible OpenAI (puerto 5601) y Ollama (11434).
const http = require('http');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = {};
const log = [];

function body(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }); }
const textOf = (c) => (typeof c === 'string' ? c : (c || []).filter((p) => p.type === 'text').map((p) => p.text).join(' '));

async function sse(res, pieces, extra = []) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const p of pieces) { res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`); await sleep(150); }
  for (const e of extra) res.write(`data: ${JSON.stringify(e)}\n\n`);
  res.end('data: [DONE]\n\n');
}
async function reply(res, stream, text) {
  if (stream) return sse(res, text.match(/.{1,6}/gs));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
}

const openai = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const raw = await body(req);
  if (req.url.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: ['models/gemini-flash-latest', 'models/text-embedding-004', 'models/imagen-4.0-generate', 'models/gemini-tts', 'think', 'rapido'].map((id) => ({ id })) })); }
  if (req.url.endsWith('/audio/transcriptions')) {
    const s = raw.toString('latin1');
    log.push({ stt: true, model: /name="model"\r\n\r\n([^\r]+)/.exec(s)?.[1], bytes: raw.length });
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: 'hola dictado' }));
  }
  const j = JSON.parse(raw.toString() || '{}');
  calls[j.model] = (calls[j.model] || 0) + 1;
  log.push({ model: j.model, n: j.messages.length, tools: !!j.tools, stream: j.stream, system: j.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)) });
  const last = j.messages[j.messages.length - 1];
  const q = textOf(last.content);
  log.at(-1).q = q;
  log.at(-1).size = JSON.stringify(j.messages).length;
  log.at(-1).all = JSON.stringify(j.messages);
  if (/Crea una habilidad para|Extrae el procedimiento reutilizable/.test(q)) return reply(res, j.stream, '```markdown\n---\nname: apuntes-de-estudio\ndescription: Resume apuntes y genera preguntas de repaso. Usar al estudiar.\n---\n\n# Apuntes de estudio\n\n1. Resume los conceptos.\n2. Genera 5 preguntas con respuesta.\n```');
  const sk = /Habilidad activa: «([^»]+)» \(v([^)]+)\)/.exec(j.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'));
  if (sk && j.model !== 'cuota') return reply(res, j.stream, `Aplicando ${sk[1]} v${sk[2]} con ${j.model}: ${q.slice(0, 30)}`);
  if (/Conversación a resumir/.test(q)) return reply(res, j.stream, 'RESUMEN: el usuario habló de números largos.');
  if (/Respuestas de varias IAs/.test(q)) return reply(res, j.stream, 'SÍNTESIS FINAL combinada');
  switch (j.model) {
    case 'gemini-2.5-flash':
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ error: { code: 404, message: 'models/gemini-2.5-flash is no longer available to new users. Please update your code to use a newer model for the latest features and improvements.', status: 'NOT_FOUND' } }]));
    case 'think': return reply(res, j.stream, '<think>The user wants a greeting in Spanish. I will answer briefly.</think>¡Hola! Solo en español.');
    case 'cuota':
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests per minute. Please try again in 1m30s.' } }));
    case 'ctx': {
      const size = JSON.stringify(j.messages).length;
      if (size > 3000) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: `This model's maximum context length is 1000 tokens (got ${size})` } })); }
      return reply(res, j.stream, `ctx ok (${size})`);
    }
    case 'tools': {
      if (last.role === 'tool') return reply(res, j.stream, `El archivo dice: ${last.content.slice(0, 200)}`);
      const tool = (j.tools || []).find((t) => t.function.name === 'read_file');
      if (!tool) return reply(res, j.stream, 'sin herramientas');
      const call = { index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'docs/nota.txt' }) } };
      if (!j.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] })); }
      return sse(res, [], [{ choices: [{ delta: { tool_calls: [call] } }] }]);
    }
    case 'vision': {
      const img = Array.isArray(last.content) && last.content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/jpeg'));
      return reply(res, j.stream, `IMAGEN:${img ? 'sí' : 'no'} PDF:${/Factura numero 4242/.test(q) ? 'sí' : 'no'}`);
    }
    case 'tabla': return reply(res, j.stream, '## Tabla\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n- uno\n- dos');
    case 'ciega': {
      if (Array.isArray(last.content)) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Image input is not supported for this model.' } })); }
      return reply(res, j.stream, 'ciega responde texto');
    }
    case 'gemini-pro-latest':
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota. Please retry in 40s.', status: 'RESOURCE_EXHAUSTED' } }]));
    case 'gemini-4-hydrogen':
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify([{ error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }]));
    case 'gemini-flash-latest': return reply(res, j.stream, 'Respuesta del modelo vigente.');
    default: return reply(res, j.stream, `Hola desde ${j.model}: ${q.slice(0, 40)}`);
  }
});

const ollamaModels = ['qwen3:4b'];
const ollama = http.createServer(async (req, res) => {
  const raw = await body(req);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/api/tags') return res.end(JSON.stringify({ models: ollamaModels.map((name) => ({ name })) }));
  if (req.url === '/v1/chat/completions') {
    // API compatible con OpenAI que el Ollama real también ofrece (la usa Neura Gateway).
    const j = JSON.parse(raw);
    const q = textOf(j.messages[j.messages.length - 1].content);
    calls['ollama-v1'] = (calls['ollama-v1'] || 0) + 1;
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: `local dice: ${q.slice(0, 30)}` }, finish_reason: 'stop' }] }));
  }
  if (req.url === '/api/pull') {
    // Descarga simulada: progreso por trozos y, al final, el modelo queda disponible.
    const { model } = JSON.parse(raw);
    res.setHeader('content-type', 'application/x-ndjson');
    res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
    for (let done = 0; done <= 100; done += 25) { res.write(JSON.stringify({ status: 'downloading', total: 100, completed: done }) + '\n'); await sleep(150); }
    ollamaModels.push(model);
    return res.end(JSON.stringify({ status: 'success' }) + '\n');
  }
  if (req.url === '/api/embed') {
    const j = JSON.parse(raw);
    const vec = (s) => { const v = new Array(26).fill(0); for (const ch of s.toLowerCase()) { const k = ch.charCodeAt(0) - 97; if (k >= 0 && k < 26) v[k]++; } return v; };
    return res.end(JSON.stringify({ embeddings: [].concat(j.input).map(vec) }));
  }
  const j = JSON.parse(raw);
  const q = textOf(j.messages[j.messages.length - 1].content);
  calls['ollama'] = (calls['ollama'] || 0) + 1;
  log.push({ ollama: true, stream: j.stream, q: q.slice(0, 60) });
  const skO = /Habilidad activa: «([^»]+)» \(v([^)]+)\)/.exec(j.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).join('\n'));
  const text = /Conversación a resumir/.test(q) ? 'RESUMEN LOCAL: se habló de números largos.' : skO ? `Aplicando ${skO[1]} v${skO[2]} con ollama: ${q.slice(0, 30)}` : `local dice: ${q.slice(0, 30)}`;
  if (j.stream) {
    res.setHeader('content-type', 'application/x-ndjson');
    for (const p of text.match(/.{1,5}/gs)) { res.write(JSON.stringify({ message: { role: 'assistant', content: p }, done: false }) + '\n'); await sleep(120); }
    return res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
  }
  res.end(JSON.stringify({ message: { role: 'assistant', content: text }, done: true }));
});

module.exports = {
  start: () => Promise.all([new Promise((r) => openai.listen(5601, r)), new Promise((r) => ollama.listen(11434, r))]),
  // Para simular un equipo sin Ollama instalado y su instalación posterior.
  stopOllama: () => new Promise((r) => { ollama.closeAllConnections?.(); ollama.close(() => r()); }),
  startOllama: () => new Promise((r) => ollama.listen(11434, r)),
  calls, log, ollamaModels,
};
