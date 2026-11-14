# Traducción de la interfaz de Neura

Neura es una app de chat que reúne varias IAs (gratuitas de internet y locales en el PC), para principiantes y profesionales. Tono: claro, cercano, sin jerga innecesaria; frases cortas.

**Entrada:** `tools/i18n/es.json` — un array JSON con los textos en español de la interfaz (botones, avisos, ayudas, plantillas, instrucciones que se envían a la IA).

**Salida:** un objeto JSON `{ "texto en español": "traducción", … }` con **exactamente las mismas claves**, todas, en el mismo orden, guardado en `tools/i18n/<idioma>.json` (UTF-8, JSON válido). Comprueba al final con `node -e "JSON.parse(require('fs').readFileSync('tools/i18n/<idioma>.json','utf8'))"` y que el número de claves es el mismo que en es.json.

## Reglas
1. Traduce el sentido, natural para un nativo; no palabra por palabra.
2. **Mayúsculas:** si el original está en MAYÚSCULAS (botones), la traducción también (en chino no aplica).
3. Conserva exactamente: emojis y símbolos (✦ ⬡ 🔒 ⚙ ≡ ▸ → · « » …), números, signos al principio o al final (p. ej. «: », « · », «(», «…»), espacios significativos dentro, nombres de marcas y productos (Neura, Gemini, Groq, OpenRouter, Ollama, ComfyUI, Forge, SearXNG, Brave Search, ChatGPT, Claude, Anthropic, OpenAI, NVIDIA, Tailscale, MCP, API, PDF, PIN, IBAN, URL…), términos técnicos en código (`/imagen`, `auto`, `max_tokens`, rutas, nombres de archivo) y marcadores como `[completa: …]`, `[DNI]`, `[IBAN]`, `**Rol:**` (traduce la palabra, conserva los `**`).
4. Fragmentos: muchos textos son trozos de una frase con partes variables antes o después (números, nombres). Tradúcelos de forma que funcionen al pegarlos con esas partes; conserva los espacios y signos de los extremos.
5. Textos que son instrucciones para una IA (prompts, habilidades, plantillas): tradúcelos completos y bien, manteniendo la estructura (listas, saltos de línea `\n`, Markdown).
6. Si un texto no se debe traducir (un nombre propio, un modelo como `qwen3:4b`), pon el mismo texto.

## Glosario (usa siempre estos términos)
| Español | English | 中文 | Русский |
|---|---|---|---|
| AUTO-SALTO | AUTO-SWITCH | 自动切换 | АВТОПЕРЕХОД |
| CONSEJO (varias IAs a la vez) | COUNCIL | 议会 | СОВЕТ |
| PRIVADO (hilo) | PRIVATE | 私密 | ЛИЧНОЕ |
| SOLO GRATIS | FREE ONLY | 仅免费 | ТОЛЬКО БЕСПЛАТНЫЕ |
| HABILIDAD / HABILIDADES (skills) | SKILL / SKILLS | 技能 | НАВЫК / НАВЫКИ |
| HILO / HILOS (conversaciones) | THREAD / THREADS | 对话 | ДИАЛОГ / ДИАЛОГИ |
| PROYECTO | PROJECT | 项目 | ПРОЕКТ |
| puente | bridge | 桥接 | мост |
| ESTE PC | THIS PC | 本机 | ЭТОТ ПК |
| IA local | local AI | 本地 AI | локальная ИИ |
| tope de gasto | spending cap | 消费上限 | лимит расходов |
| límite diario | daily limit | 每日限额 | дневной лимит |
| cuota (gratuita) | (free) quota | （免费）额度 | (бесплатная) квота |
| PLANTILLAS PRO | PRO TEMPLATES | 专业模板 | ПРО-ШАБЛОНЫ |
| ESTRUCTURAR | STRUCTURE | 结构化 | СТРУКТУРИРОВАТЬ |
| COMPROBAR | CHECK | 核查 | ПРОВЕРИТЬ |
| Gateway | Gateway | Gateway | Gateway |
| token | token | token | токен |
| IA / IAs | AI / AIs | AI | ИИ |
| ENVIAR | SEND | 发送 | ОТПРАВИТЬ |
| PARAR | STOP | 停止 | СТОП |
