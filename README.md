# Neura

Todas las IAs públicas en un solo chat, aprovechando sus niveles gratuitos, más un menú para conectarte a servidores MCP que hacen de puente con la IA local de tus ordenadores y servidores.

```
neura/
├── app/       La app (HTML/CSS/JS, sin build)
├── android/   Proyecto nativo Android (Capacitor)
├── ios/       Proyecto nativo iOS (Capacitor)
├── desktop/   App para PC (Windows, macOS, Linux) con Electron y el puente integrado
├── docs/      Guías (PC + Ollama)
├── assets/    Fuentes del icono y la pantalla de arranque
└── bridge/    neura-bridge: servidor MCP sin dependencias (Node 18+)
```

## Funciones

1. **Un solo chat con todas las IAs públicas.** En **⚙** añades Gemini, Groq, OpenRouter (modelos gratis), Cerebras, Mistral, GitHub Models, Hugging Face o Cohere con la clave gratuita de cada una. Opcionales de pago: Anthropic, OpenAI, DeepSeek. Eliges el modelo en el desplegable y la conversación continúa aunque cambies de IA.
2. **AUTO-SALTO para tokens gratis.** Si la IA elegida agota su cuota gratuita (429), falla o rechaza la clave, Neura reenvía el mensaje a la siguiente IA conectada.
3. **Menú MCP (⬡).** Conecta con uno o varios servidores MCP (`neura-bridge` u otro compatible). Sus modelos locales aparecen en el mismo desplegable.
4. **Hilos (≡).** Varias conversaciones guardadas, con búsqueda y exportación (.md / copia .json). Con un puente conectado, los hilos se sincronizan entre el PC, el móvil y la web sin perder mensajes.
5. **AUTO-SALTO inteligente.** Recuerda qué IA agotó su cuota y hasta cuándo (lee `Retry-After` y los mensajes de cada proveedor), no la vuelve a intentar antes de tiempo, ordena las demás por tasa de éxito y velocidad, y lo muestra en ⚙ y con ⏳ en el desplegable.
6. **Memoria de contexto.** Si un hilo crece demasiado para las IAs gratuitas, lo antiguo se resume (con tu IA local si la tienes) y se envía resumen + lo reciente. Si una IA responde "contexto demasiado largo", Neura comprime y reintenta.
7. **⚖ CONSEJO.** Varias IAs responden a la vez y una de ellas combina la mejor respuesta.
8. **Imágenes, PDF, texto y voz.** 📎 adjunta fotos (para IAs con visión), PDF (se extrae el texto en el dispositivo) y archivos de texto o código. 🎤 dicta con Whisper de Groq (gratis) o el dictado del navegador. **LEER** lee una respuesta en voz alta.
9. **ƒ HERRAMIENTAS.** Las IAs (públicas o locales) pueden usar las herramientas de tus servidores MCP: buscar y leer documentos de carpetas que compartas en el PC, búsqueda semántica en ellos (RAG local con Ollama). El estado del equipo (`system_info`) solo lo ve la IA local, para no enviar el nombre del PC ni IPs internas a proveedores externos.
10. **Emparejar por QR y fuera de casa.** El PC muestra un QR que conecta el móvil en un toque, y con Tailscale funciona desde cualquier sitio.
11. **✦ Habilidades (skills).** Crea con IA procedimientos reutilizables, pruébalos, guárdalos con versión y actívalos en un hilo: se aplican con cualquier IA, también tras un AUTO-SALTO. Importación y exportación en formato `SKILL.md` (Agent Skills).
12. **📁 Proyectos.** Hilos agrupados con una memoria editable que reciben todas las IAs y una habilidad por defecto. Habilidades y proyectos se sincronizan por el puente.
13. **Configuración guiada, ramas y más.** Asistente para conectar la primera IA gratis; ⑂ RAMA y ✎ EDITAR desde cualquier mensaje; sugerencias de habilidades al escribir; PDF citados por página y escaneados leídos con visión; CONSEJO con desacuerdos señalados; SOLO GRATIS y hilos 🔒 PRIVADOS.
14. **Para principiantes y profesionales.** Al empezar, eliges entre IA en tu equipo (en el PC, sin cuentas: Neura guía la instalación de Ollama y descarga el modelo adecuado a tu memoria) o IA en internet (guía por proveedor para crear la clave gratis). El modo **Principiante** muestra lo esencial, consejos de uso correcto y habilidades que enseñan; el **Profesional**, todo.
15. **Claves protegidas.** En el PC se cifran con el llavero del sistema; en el móvil y la web, opcionalmente con un PIN (AES-256). Las claves nunca se sincronizan.

Los nombres de modelo cambian a menudo: pulsa **ESCANEAR MODELOS** en cada IA para traer la lista actual. Las claves se guardan solo en el dispositivo.

## Puente MCP para IA local

```bash
cd neura/bridge
cp config.example.json config.json   # edita backends y token
NEURA_TOKEN=un-secreto-largo node server.mjs
```

Funciona con Ollama, LM Studio, llama.cpp, vLLM o cualquier API compatible con OpenAI. Expone las herramientas MCP `list_models`, `chat` (con streaming, imágenes y `tools: true` para que el modelo local use las herramientas de archivos), `system_info` y `threads_sync` (guarda los hilos en `~/.neura-bridge/hilos.json`, o en `NEURA_DATA`; desactívalo con `"sync": false` en `config.json`).

Si compartes carpetas (`"folders": ["/ruta/a/documentos"]` en `config.json` o `NEURA_FOLDERS`), añade herramientas de **solo lectura**: `list_dir`, `search_files`, `read_file` y `search_docs` (búsqueda semántica con embeddings de Ollama: `ollama pull nomic-embed-text`; sin ese modelo busca por palabras). Nunca sale de las carpetas compartidas (bloquea `..`, rutas absolutas, carpetas ocultas y enlaces simbólicos que apunten fuera). Al arrancar muestra la URL de tu red (p. ej. `http://192.168.1.20:8787/mcp`): pégala en el menú ⬡ de la app junto con el token.

Variables: `PORT`, `HOST`, `NEURA_TOKEN`, `OLLAMA_URL`, `NEURA_CONFIG`, `NEURA_DATA`, `NEURA_FOLDERS`, `NEURA_EMBED_MODEL`.

El puente siempre exige token, también en `127.0.0.1` (si no, cualquier web abierta en ese equipo podría leer tus hilos). Si no defines uno, genera uno aleatorio en cada arranque y lo muestra en pantalla. Fija el tuyo con `NEURA_TOKEN` para que no cambie.

Tests de seguridad del puente: `node --test bridge/test.mjs`.

Si alguna IA pública bloquea las llamadas desde el navegador (CORS), añádela como backend del puente (admite `url` + `apiKey`) y úsala a través de él.

## App para PC (Windows, macOS, Linux)

`desktop/` empaqueta `app/` con Electron. Guarda los hilos y ajustes en un archivo en disco, hace las peticiones sin CORS y arranca solo el puente MCP, que aparece en **⬡** como **ESTE PC** con los modelos de Ollama. Con **ABRIR A MI RED**, el móvil se conecta al PC y comparte sus hilos.

```bash
npm run pc              # abrir en modo desarrollo (la primera vez: cd desktop && npm install)
npm run pc:instalador   # genera el instalador de tu sistema en desktop/dist/
```

GitHub Actions genera en cada push a `main` el instalador y la versión portable de Windows (`.exe`), macOS (`.dmg` / `.zip`) y Linux (`.deb` / `.AppImage`). Al subir una rama `version-X.Y.Z` (o una etiqueta `vX.Y.Z`) se publican todos, junto con el APK de Android, en **[Releases](https://github.com/AngelazoGit/neura/releases/latest)**.

**Guía completa (instalación, datos, sincronización e instalación de Ollama):** [docs/ESCRITORIO-Y-OLLAMA.md](docs/ESCRITORIO-Y-OLLAMA.md)

## App nativa (Android e iOS) con Capacitor

El proyecto ya incluye las carpetas `android/` (Android Studio) e `ios/` (Xcode), con iconos y pantalla de arranque de Neura. La app web vive en `app/`; Capacitor la copia dentro de cada proyecto nativo.

Ventaja de la versión nativa: las peticiones salen por la red del móvil (CapacitorHttp), así que **no hay bloqueos CORS** con ningún proveedor y puedes conectar el puente MCP por `http://` en tu red local sin túneles ni HTTPS.

**Preparación (una vez)**
```bash
cd neura
npm install
```

**Cada vez que cambies algo en `app/`**
```bash
npx cap sync
```

### Android (Windows, Mac o Linux)
1. Instala [Android Studio](https://developer.android.com/studio) (trae el SDK y Java).
2. `npx cap open android` → espera a que Gradle sincronice → ▶ Run con el móvil conectado por USB (depuración USB activada) o un emulador.
3. APK de prueba sin abrir Android Studio: `npm run apk` → `android/app/build/outputs/apk/debug/app-debug.apk` (instálalo en el móvil).
4. Para Google Play: Android Studio → *Build → Generate Signed App Bundle* (.aab) y súbelo a Google Play Console (cuenta de desarrollador de Google).

### iOS (necesita un Mac)
1. Instala Xcode desde la App Store.
2. `npx cap open ios` → en *Signing & Capabilities* elige tu equipo (Apple ID) → ▶ Run en tu iPhone.
3. Para la App Store: cuenta de Apple Developer → *Product → Archive* → *Distribute App*.
   La primera vez que conectes un puente MCP, iOS pedirá permiso de **red local**: acéptalo.

### Iconos y pantalla de arranque
Las imágenes fuente están en `assets/`. Si las cambias: `npm run assets`.

### Identificador de la app
`com.neura.app` (en `capacitor.config.json`). Cámbialo por uno tuyo (p. ej. `com.tuempresa.neura`) **antes** de publicar en las tiendas; después ya no se puede cambiar.

## Web app (gratis, sin tiendas)

La carpeta `app/` se publica sola en un repositorio público aparte, `AngelazoGit/neura-web`, con GitHub Pages. El código fuente, el puente y los proyectos nativos siguen en este repo privado.

**Enlace:** https://angelazogit.github.io/neura-web/

**Actualizar la web** después de cambiar algo en `app/` y hacer commit:
```bash
npm run deploy:web
```

**Instalar en el móvil desde el enlace**
- **iPhone:** ábrelo en Safari → Compartir → *Añadir a pantalla de inicio*.
- **Android:** ábrelo en Chrome → menú ⋮ → *Instalar app*.

**Diferencias con la versión nativa:** algunas IAs bloquean las llamadas desde el navegador (CORS), y para usar el puente MCP desde la web este necesita HTTPS (`tailscale serve 8787` o `cloudflared tunnel --url http://localhost:8787`). La versión nativa no tiene esas limitaciones.

## Seguridad

- El puente nunca arranca sin token, ni siquiera en `127.0.0.1`: sin `NEURA_TOKEN` genera uno aleatorio. En la app de PC, **⬡ → ESTE PC → REGENERAR** crea uno nuevo si pierdes el móvil o se filtra el QR.
- Los adjuntos (imágenes y textos de PDF) se guardan aparte, en IndexedDB, con sus bytes originales; el estado de la app solo guarda referencias. Si el almacenamiento se llena, aparece un aviso fijo con **EXPORTAR COPIA**.
- La app no hace peticiones a terceros al abrirse (fuentes incluidas en `app/fonts`, licencia OFL) y tiene una política CSP que bloquea scripts inyectados.
- Las claves API se guardan solo en el dispositivo y nunca se sincronizan. En el PC se cifran con el llavero del sistema (DPAPI en Windows, Llavero en macOS, libsecret/kwallet en Linux). En el móvil y la web puedes cifrarlas con un PIN en **⚙ → SEGURIDAD DE LAS CLAVES** (AES-256-GCM, PBKDF2). En Android quedan fuera de las copias de seguridad.
- Las herramientas de archivos del puente son de solo lectura y no salen de las carpetas que compartes. Solo se usan sin preguntar las herramientas del puente de tu PC, de los equipos emparejados por QR y de los servidores que autorices en ⬡; el nombre que declare un servidor no cuenta.
- **SOLO GRATIS** (⚙) impide usar IAs de pago o de coste desconocido, y **🔒 PRIVADO** (por hilo) limita las respuestas a tus propios equipos. Ambas miran el backend real del puente (el puente indica si es local; con `"local": true/false` en `config.json` se puede forzar), y el puente rechaza enviar un hilo privado a un backend externo. Los hilos privados solo se sincronizan con tus equipos y no se dictan por voz.
- La lectura de PDF se hace en el propio dispositivo con pdf.js (Apache-2.0, `app/vendor/`).
