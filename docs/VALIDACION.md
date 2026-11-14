# Validación real de Neura (testers)

Las pruebas automáticas (`bash test/e2e/run.sh`) usan servidores simulados y los SDK oficiales de OpenAI y Anthropic. Esta guía cubre lo que **solo se puede comprobar con equipos, cuentas y herramientas reales**.

No incluyas claves, tokens ni contenido privado en los registros.

## Qué probar, en este orden

| # | Prueba | Qué comprobar |
|---|---|---|
| 1 | **Ollama real** (Neura para PC, cuenta nueva) | Detecta que falta Ollama y enlaza el instalador. Tras instalarlo, «Ya lo he instalado». Muestra memoria y espacio libre. La descarga muestra progreso y **CANCELAR** la detiene sin anunciar que está instalada. Al terminar, la prueba dice cuánto tardó. La primera conversación funciona. |
| 2 | **Un proveedor real** (p. ej. Gemini o Groq) | Configuración guiada. Un modelo concreto y `auto`. Respuesta con streaming. Una clave mal escrita muestra «La clave API no es válida» y salta a otra IA. |
| 3 | **Una herramienta real con el Gateway**: empezad solo por una (recomendado: **Continue** o **Cline**) | Conversación, streaming, una tarea que use herramientas (leer o editar un archivo) y cancelar a mitad. Un nombre de modelo inventado debe dar error. |
| 4 | **Dos clientes a la vez** | Dos herramientas, o dos ventanas, preguntando a la vez por el Gateway: no se mezclan las respuestas. |
| 5 | **Beta limitada** | Problemas reales de configuración, rendimiento y comprensión de los controles. |
| 6 | **Importar historial real** | Usa una cuenta de prueba sin datos privados. Exportación de ChatGPT (.zip) y de Claude: compara títulos y mensajes con el original (también conversaciones con respuestas regeneradas, mensajes vacíos y adjuntos), comprueba el aviso de adjuntos omitidos y que reimportar no duplique. Gemini (Takeout, JSON) es experimental: anota si el formato real no se lee bien. |
| 7 | **Imágenes con ComfyUI o Forge reales** | `/imagen` con el modelo que tengas: tiempo, calidad y que GUARDAR guarde el archivo. Anota tarjeta gráfica y modelo. |
| 8 | **Consumo y tope** | Con una IA de pago y su precio: que el gasto estimado se parezca al de su panel de facturación y que el tope corte al llegar. |
| 9 | **Diagnóstico** | PROBAR TODAS MIS IAs con tus claves reales: que los motivos de fallo se entiendan. |

## Plantilla de registro (una fila por prueba)

| Fecha | Commit de Neura | Sistema | Cliente externo y versión | Proveedor / modelo | Escenario | Resultado (OK / fallo) | Notas (sin claves) |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

El commit aparece en GitHub (pestaña *Commits*) o con `git log -1 --format=%h`.

## Estado de las integraciones del Gateway

| Integración | Estado |
|---|---|
| SDK oficial de OpenAI (`openai` 7.57.0) | **Probada** (`test/e2e/sdk.mjs`): modelos, texto, streaming, herramientas, modelo desconocido y corte a mitad |
| SDK oficial de Anthropic (`@anthropic-ai/sdk` 1.8.0) | **Probada** (`test/e2e/sdk.mjs`): texto, herramientas, `tool_result`, streaming con herramientas, modelo desconocido, corte a mitad y token incorrecto |
| Continue, Cline / Roo Code, Aider, Open WebUI, Claude Code | **Configuración de ejemplo**: pendiente de validar con la herramienta real |

Cuando una herramienta pase la prueba 3, se cambia aquí a «Probada», con su versión y el commit.
