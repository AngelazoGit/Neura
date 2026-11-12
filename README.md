# Neura

Todas las IAs públicas en un solo chat, aprovechando sus niveles gratuitos, más un menú para conectarte a servidores MCP que hacen de puente con la IA local de tus ordenadores y servidores.

```
neura/
├── app/       La app (HTML/CSS/JS, sin build)
├── android/   Proyecto nativo Android (Capacitor)
├── ios/       Proyecto nativo iOS (Capacitor)
├── assets/    Fuentes del icono y la pantalla de arranque
└── bridge/    neura-bridge: servidor MCP sin dependencias (Node 18+)
```

## Funciones

1. **Un solo chat con todas las IAs públicas.** En **⚙** añades Gemini, Groq, OpenRouter (modelos gratis), Cerebras, Mistral, GitHub Models, Hugging Face o Cohere con la clave gratuita de cada una. Opcionales de pago: Anthropic, OpenAI, DeepSeek. Eliges el modelo en el desplegable y la conversación continúa aunque cambies de IA.
2. **AUTO-SALTO para tokens gratis.** Si la IA elegida agota su cuota gratuita (429), falla o rechaza la clave, Neura reenvía el mensaje a la siguiente IA conectada.
3. **Menú MCP (⬡).** Conecta con uno o varios servidores MCP (`neura-bridge` u otro compatible). Sus modelos locales aparecen en el mismo desplegable.

Los nombres de modelo cambian a menudo: pulsa **ESCANEAR MODELOS** en cada IA para traer la lista actual. Las claves se guardan solo en el dispositivo.

## Puente MCP para IA local

```bash
cd neura/bridge
cp config.example.json config.json   # edita backends y token
NEURA_TOKEN=un-secreto-largo node server.mjs
```

Funciona con Ollama, LM Studio, llama.cpp, vLLM o cualquier API compatible con OpenAI. Expone las herramientas MCP `list_models`, `chat` y `system_info`. Al arrancar muestra la URL de tu red (p. ej. `http://192.168.1.20:8787/mcp`): pégala en el menú ⬡ de la app junto con el token.

Variables: `PORT`, `HOST`, `NEURA_TOKEN`, `OLLAMA_URL`, `NEURA_CONFIG`.

Si el puente escucha en la red y no defines token, genera uno aleatorio en cada arranque y lo muestra en pantalla. Fija el tuyo con `NEURA_TOKEN` para que no cambie.

Tests de seguridad del puente: `node --test bridge/test.mjs`.

Si alguna IA pública bloquea las llamadas desde el navegador (CORS), añádela como backend del puente (admite `url` + `apiKey`) y úsala a través de él.

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

- El puente nunca arranca abierto en la red: sin `NEURA_TOKEN` genera un token aleatorio.
- La app no hace peticiones a terceros al abrirse (fuentes incluidas en `app/fonts`, licencia OFL) y tiene una política CSP que bloquea scripts inyectados.
- Las claves API se guardan en el almacenamiento local de la app, sin cifrar. En Android quedan fuera de las copias de seguridad.
