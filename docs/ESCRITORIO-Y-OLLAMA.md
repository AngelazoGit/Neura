# Neura en el PC + IA local con Ollama

Esta guía explica cómo instalar **Neura para PC** (Windows, macOS y Linux), dónde guarda tus datos, cómo mantener los mismos hilos en el PC, el móvil y la web, y cómo instalar **Ollama** para usar IA gratis en tu propio ordenador a través del puente MCP.

---

## 1. Qué es Neura para PC

Es la misma app que en el móvil y la web (carpeta `app/`) dentro de una ventana de escritorio, con tres extras:

| | Web | Móvil (Capacitor) | **PC** |
|---|---|---|---|
| Todas las IAs públicas + AUTO-SALTO | ✅ | ✅ | ✅ |
| Hilos (varias conversaciones) | ✅ | ✅ | ✅ |
| Sin bloqueos CORS | ❌ | ✅ | ✅ |
| Datos guardados en un **archivo en disco** | ❌ | ❌ | ✅ |
| **Puente MCP integrado** (Ollama sin terminal) | ❌ | ❌ | ✅ |
| Comparte los hilos con el móvil y la web | vía puente | vía puente | ✅ es el puente |

Al abrir Neura en el PC se arranca solo el puente MCP (`bridge/server.mjs`). En el menú **⬡** aparece **ESTE PC** con los modelos de Ollama que tengas instalados, sin ejecutar nada en la terminal.

---

## 2. Instalar Neura en el PC

### Opción A: descargar Neura (recomendada)

Abre **https://github.com/AngelazoGit/neura/releases/latest** y descarga el archivo de tu sistema:

| Sistema | Instalable | Portable (sin instalar) |
|---|---|---|
| Windows | `Neura-X.Y.Z-Windows-instalador.exe` | `Neura-X.Y.Z-Windows-portable.exe` |
| macOS (Apple Silicon) | `Neura-X.Y.Z-mac-arm64.dmg` | `Neura-X.Y.Z-mac-arm64.zip` |
| Linux | `Neura-X.Y.Z-linux-amd64.deb` | `Neura-X.Y.Z-linux-x86_64.AppImage` |
| Android | `Neura-X.Y.Z-Android.apk` | — |

**Instalable**
- **Windows:** ejecuta el instalador. Crea acceso directo en el menú Inicio y se desinstala desde *Configuración → Aplicaciones*. Como no está firmado, SmartScreen avisará: **Más información → Ejecutar de todas formas**.
- **macOS:** abre el `.dmg` y arrastra Neura a Aplicaciones. La primera vez, **clic derecho → Abrir**. Si dice que "está dañada":
  ```bash
  xattr -cr /Applications/Neura.app
  ```
- **Linux:**
  ```bash
  sudo apt install ./Neura-*-linux-amd64.deb
  ```

**Portable** (no instala nada; puedes llevarlo en un USB)
- **Windows:** copia `Neura-…-Windows-portable.exe` donde quieras y ábrelo. Tus hilos y ajustes se guardan **junto al .exe**, en la carpeta `Neura-datos`. Al llevarlo a otro PC te llevas los hilos.
  - En modo portable las claves API no se cifran con el llavero del PC, porque no podrían leerse en otro equipo. Activa **⚙ → SEGURIDAD → ACTIVAR PIN** para que viajen cifradas.
- **macOS:** descomprime el `.zip` y abre `Neura.app`. Los datos se guardan en tu usuario, como la versión instalable.
- **Linux:** el `.AppImage` ya es portable:
  ```bash
  chmod +x Neura-*.AppImage
  ```

Las versiones también están en **Actions → Compilar app → Artifacts** (14 días, solo con sesión iniciada en GitHub).

> Para que Windows y macOS no muestren avisos hay que firmar los instaladores (certificado de firma de código de Windows y cuenta de Apple Developer).

### Opción B: ejecutarlo desde el código

Necesitas Node 18 o superior.

```bash
cd neura/desktop
npm install
npm start
```

Para generar el instalador de tu sistema: `npm run dist` → aparece en `desktop/dist/`.

---

## 3. Dónde se guardan tus datos

Todo queda en la carpeta de usuario de Neura:

| Sistema | Carpeta |
|---|---|
| Windows | `%APPDATA%\Neura\` (portable: carpeta `Neura-datos` junto al .exe) |
| macOS | `~/Library/Application Support/Neura/` |
| Linux | `~/.config/Neura/` |

| Archivo | Contenido |
|---|---|
| `neura-datos.json` | Tus hilos, IAs, claves API y servidores MCP |
| `neura-datos.bak.json` | Copia de seguridad que se hace cada vez que abres la app |
| `hilos.json` | Los hilos que guarda el puente para compartirlos con el móvil y la web |
| `escritorio.json` | Puerto, token del puente, si está abierto a tu red y carpetas compartidas con la IA |
| `indice.json` | Índice de búsqueda de tus documentos (para `search_docs`) |
| `puente.json` | *(opcional)* Backends de IA del puente, mismo formato que `bridge/config.example.json` |

- **Copia de seguridad o cambio de PC:** copia esta carpeta entera.
- **Las claves API se guardan cifradas con el llavero del sistema** (Windows DPAPI, Llavero de macOS, o libsecret/kwallet en Linux). En ⚙ → SEGURIDAD verás cuál se usa. En un Linux sin llavero se guardan sin cifrar: no compartas ese archivo.
- Las escrituras son atómicas: un cierre inesperado no deja el archivo a medias.

---

## 4. Hilos: no perder nunca una conversación

- Pulsa **≡** para ver tus hilos, abrir uno anterior o empezar uno **+ NUEVO HILO**.
- Cada hilo guarda su conversación completa. Puedes cambiar de IA a mitad de un hilo y la nueva IA recibe todo el contexto.
- Si ya usabas Neura, tu chat anterior se convierte en el primer hilo automáticamente.

### Mismos hilos en el PC, el móvil y la web

Los hilos se sincronizan a través del puente MCP: cualquier dispositivo conectado al mismo puente ve los mismos hilos.

1. En el PC, abre **⬡** → tarjeta **ESTE PC** → marca **ABRIR A MI RED**.
2. Aparece un **código QR**:
   - **Sin instalar nada:** escanéalo con la cámara del móvil. Se abre Neura en el navegador ya conectada a tu PC.
   - **Con la app instalada:** **⬡ → 📷 ESCANEAR QR DE MI PC** (Android). En iPhone, o si prefieres, pega la URL y el **TOKEN** que aparecen bajo el QR.
3. Abre **≡** en el móvil: aparecen los hilos del PC. Lo que escribas en un dispositivo aparece en el otro al abrir **≡**, al volver a la app o, como mucho, al cabo de un minuto.

Detalles:
- La casilla **SINCRONIZAR HILOS** de cada servidor la activa o desactiva.
- Si borras un hilo, se borra también en los demás dispositivos.
- Si escribes en dos dispositivos a la vez en el mismo hilo, no se pierde ningún mensaje: se unen y se ordenan por hora.
- La web publicada en GitHub Pages (https) solo puede conectar con el puente por https (ver el README: `tailscale serve` o `cloudflared`). La app nativa del móvil se conecta por `http://` en tu red sin problemas.
- El firewall de Windows preguntará si permites que Neura acepte conexiones: acepta en **redes privadas**.

### Fuera de casa (Tailscale)

[Tailscale](https://tailscale.com/download) crea una red privada gratuita entre tus dispositivos, sin abrir puertos del router.

1. Instálalo en el PC y en el móvil, e inicia sesión con la misma cuenta en ambos.
2. En Neura para PC: **⬡ → ESTE PC → FUERA DE CASA**:
   - Con **ABRIR A MI RED** activado, la app instalada del móvil puede conectarse a `http://100.x.y.z:8787/mcp` (la IP de Tailscale que aparece).
   - **ACTIVAR HTTPS CON TAILSCALE** publica el puente en `https://tu-pc.tu-red.ts.net/` (solo dentro de tu red Tailscale) y muestra un segundo QR. Así funciona también la web de GitHub Pages, que exige https.

> Para activar HTTPS, tu red Tailscale debe tener HTTPS habilitado (Tailscale lo propone la primera vez).

---

## 4 bis. Funciones del chat

| Función | Cómo se usa |
|---|---|
| **Instrucciones para todas las IAs** | ⚙ → INSTRUCCIONES. Por defecto: responder solo en español y de forma concisa. Se envían en cada mensaje; puedes cambiarlas (tono, longitud, idioma) o dejarlas vacías. |
| **Modelos retirados** | Si un proveedor retira un modelo (p. ej. Gemini 2.5), Neura lo marca como "ya no disponible", pasa a otra IA y descarga la lista de modelos vigente. Gemini usa por defecto los alias `gemini-flash-latest` y `gemini-flash-lite-latest`, que siempre apuntan al modelo actual. |
| **✦ HABILIDADES** | Procedimientos reutilizables ("resume mis apuntes y haz preguntas", "redacta con mi estilo"…). **+ CREAR CON IA** redacta un borrador a partir de lo que describes; lo revisas, lo **PRUEBAS** con un texto de ejemplo y lo **GUARDAS**. **USAR EN ESTE HILO** la activa: se aplica con cualquier IA, también tras un AUTO-SALTO, y cada respuesta indica la habilidad y versión usadas. Al editarla sube de versión y la anterior se guarda: en EDITAR puedes cargar una versión anterior y guardarla como nueva. **✦ HABILIDAD** en una respuesta crea una a partir de ella. Se importan y exportan como `SKILL.md` (formato Agent Skills). Son solo texto: no dan permisos ni ejecutan nada. |
| **Primera configuración** | Si aún no tienes ninguna IA, la pantalla de inicio te guía: elige una IA gratuita, abre su página para crear la clave, pégala y pulsa **CONECTAR Y PROBAR** (descarga los modelos y comprueba que responde). |
| **Sugerencias de habilidades** | Mientras escribes, si el mensaje encaja con una de tus habilidades, aparece «✦ ¿Usar la habilidad…?». **USAR** la activa en el hilo; **NO** deja de sugerirla en ese hilo. Nunca se activan solas. |
| **📁 Proyectos** | En **≡**, el desplegable de arriba → **+ NUEVO PROYECTO**. Cada proyecto tiene una **memoria** (datos, contexto y preferencias que reciben todas las IAs en sus hilos) y una **habilidad por defecto** para sus hilos nuevos. Los hilos se filtran por proyecto. Habilidades y proyectos se sincronizan con tus otros dispositivos a través del puente. |
| **⑂ RAMA y ✎ EDITAR** | **⑂ RAMA** en cualquier mensaje crea un hilo nuevo con la conversación hasta ese punto, para probar otra IA u otra habilidad sin perder el original. **✎ EDITAR** en un mensaje tuyo abre una rama justo antes de él con el texto listo para cambiarlo. |
| **PDF** | El texto se envía marcado por páginas y la IA cita «(pág. N)». Si el PDF es escaneado (sin texto), sus primeras 5 páginas se envían como imágenes a una IA con visión. |
| **Capacidades** | Si un modelo rechaza imágenes, Neura lo recuerda («sin imágenes» en ⚙) y no le envía más fotos, aunque lo sigue usando para texto. Con ƒ HERRAMIENTAS, da preferencia a los modelos que sí las aceptan. |
| **SOLO GRATIS** | ⚙ → GASTO. Neura solo usa IAs del nivel gratuito (en OpenRouter, modelos `:free`) y tus equipos. Las de pago o de coste desconocido salen con ⛔ y no se usan en AUTO-SALTO, CONSEJO, resúmenes ni dictado. En un puente solo cuentan como gratis sus backends locales; uno que reenvíe a una API externa no. |
| **🔒 PRIVADO** | Casilla en la barra, para cada hilo. Solo responden tus equipos: el puente de este PC o los servidores marcados en ⬡ como **ES UN EQUIPO MÍO** (los emparejados por QR lo están). Ningún dato del hilo sale a IAs externas: los backends del puente que no son locales (en tu equipo o tu red privada) quedan excluidos, y el propio puente lo comprueba. Los hilos privados solo se sincronizan con tus equipos y el dictado se desactiva en ellos. |
| **AUTO-SALTO inteligente** | Si una IA agota su cuota, Neura sabe hasta cuándo (⏳ en el desplegable y en ⚙) y no la vuelve a probar antes de tiempo. Las demás se ordenan por éxito y velocidad. **REINTENTAR YA** en ⚙ borra la espera. |
| **Memoria de contexto** | ⚙ → MEMORIA DE CONTEXTO (6000 tokens por defecto). Al pasar ese tamaño, lo antiguo se resume (🗜 VER RESUMEN en el chat). Con Ollama, el resumen lo hace tu IA local y no gasta cuota. |
| **⚖ CONSEJO** | Actívalo en la barra. Responden 3 IAs de proveedores distintos (o las que elijas en ⚙) y la IA elegida escribe la síntesis, que termina con **⚠️ Desacuerdos y puntos a comprobar**. |
| **📎 Adjuntar** | Fotos (para modelos con visión, p. ej. Gemini), PDF (el texto se extrae en tu dispositivo) y archivos de texto o código. También puedes arrastrarlos o pegarlos. |
| **🎤 Dictar** | Con una clave de **Groq** (gratis) usa Whisper. Sin ella, el dictado del navegador si existe. |
| **LEER** | Lee la respuesta en voz alta con las voces del sistema. |
| **ƒ HERRAMIENTAS** | Deja que la IA use las herramientas de tus servidores MCP (ver apartado 5.5). |
| **Buscar / exportar** | En **≡**: buscador, **EXPORTAR ESTE HILO (.md)**, **COPIA DE TODOS (.json)** e **IMPORTAR**. |
| **PIN** | En el móvil y la web: ⚙ → SEGURIDAD DE LAS CLAVES → ACTIVAR PIN. Te lo pedirá al abrir. Si lo olvidas, se borran las claves (no los hilos). |

---

## 5. Instalar Ollama (IA gratis en tu ordenador)

[Ollama](https://ollama.com) descarga y ejecuta modelos de IA abiertos en tu equipo. No necesita cuenta, no tiene límites de uso y tus conversaciones no salen del PC.

### 5.1 Instalación

**Windows 10/11**
1. Descarga `OllamaSetup.exe` desde https://ollama.com/download e instálalo.
2. Queda funcionando en segundo plano (icono de la llama en la bandeja).

**macOS 12 o superior**
1. Descarga Ollama desde https://ollama.com/download, ábrelo y muévelo a Aplicaciones.
2. Ábrelo una vez: queda en la barra de menú.

**Linux**
```bash
curl -fsSL https://ollama.com/install.sh | sh
```
Se instala como servicio (`systemctl status ollama`).

Comprueba la instalación en una terminal (PowerShell en Windows):
```bash
ollama --version
```

### 5.2 Elegir un modelo para tu PC

Regla rápida: el modelo tiene que caber en la RAM (o en la memoria de la tarjeta gráfica) con margen.

| Tu equipo | Modelo | Descarga aprox. | Para qué |
|---|---|---|---|
| 8 GB RAM, sin gráfica | `llama3.2:3b` | 2 GB | Chat rápido y respuestas cortas |
| 8 GB RAM | `qwen3:4b` | 2,5 GB | Chat y razonamiento ligero, buen español |
| 8–16 GB RAM | `gemma3:4b` | 3,3 GB | Chat general y resúmenes |
| 16 GB RAM o gráfica de 8 GB | `qwen3:8b` | 5 GB | **Mejor equilibrio** calidad/velocidad |
| 16 GB RAM | `llama3.1:8b` | 5 GB | Generalista |
| 16 GB RAM, para programar | `qwen2.5-coder:7b` | 4,7 GB | Código |
| 32 GB RAM o gráfica de 12 GB+ | `gemma3:12b` | 8 GB | Más calidad, más lento |

Los modelos se renuevan a menudo: en https://ollama.com/library están los actuales. Con poca RAM, elige siempre el más pequeño.

### 5.3 Descargar y probar un modelo

```bash
ollama pull qwen3:4b
```

```bash
ollama run qwen3:4b "Hola, preséntate en una frase"
```

Para ver los modelos instalados:
```bash
ollama list
```

Para borrar uno y liberar espacio:
```bash
ollama rm qwen3:4b
```

### 5.4 Usarlo en Neura

- **Neura para PC:** abre **⬡** → **ESTE PC** → **RECONECTAR**. El modelo aparece en el desplegable como `⬡ ESTE PC / ollama/qwen3:4b`. Elígelo y escribe.
- **Móvil:** conéctalo a tu PC como en el apartado 4 y tendrás los modelos de tu PC en el móvil.
- **AUTO-SALTO:** si una IA pública agota su cuota gratuita, Neura puede pasar a tu IA local, que nunca se agota.

El puente detecta también **LM Studio** (`http://127.0.0.1:1234/v1`) si lo tienes abierto con el servidor local activado.

### 5.5 Que la IA lea tus documentos (carpetas + RAG local)

1. En Neura para PC: **⬡ → ESTE PC → 📁 CARPETAS PARA LA IA → + AÑADIR CARPETA** (p. ej. `Documentos/Facturas`).
2. Descarga el modelo de búsqueda semántica (pequeño, ~270 MB):
   ```bash
   ollama pull nomic-embed-text
   ```
3. Activa **ƒ HERRAMIENTAS** en la barra y pregunta, por ejemplo: "¿cuánto pagué de luz en marzo según mis facturas?".

La IA puede listar, buscar por nombre o contenido, leer archivos de texto y hacer búsqueda semántica (`search_docs`). Todo es **solo lectura** y nunca sale de las carpetas que elijas. Funciona tanto con IAs públicas (el fragmento leído se envía a ese proveedor) como con tu IA local (no sale nada del PC). Para que un modelo local use herramientas, elige uno que las soporte: `qwen3`, `llama3.1` o `llama3.2`.

> Cualquiera que tenga el token del puente puede leer esas carpetas. No compartas el token y no añadas carpetas con datos que no quieras exponer.

---

## 6. IA en otro ordenador o servidor (opcional)

Para usar la IA de otra máquina (p. ej. un PC con buena gráfica), instala allí Ollama y el puente sin la app:

```bash
git clone https://github.com/AngelazoGit/neura.git
```

```bash
cd neura/bridge && cp config.example.json config.json
```

Edita `config.json` (token y backends) y arranca:

```bash
NEURA_TOKEN=un-secreto-largo node server.mjs
```

En Windows (PowerShell):

```bash
$env:NEURA_TOKEN="un-secreto-largo"; node server.mjs
```

Después, añade su URL y token en **⬡** de Neura. Cada puente guarda sus propios hilos: para tener los hilos en todos tus dispositivos, conéctalos todos al **mismo** puente (desactiva **SINCRONIZAR HILOS** en los demás si no lo necesitas).

Si Ollama está en una máquina y el puente en otra, haz que Ollama escuche en la red con la variable `OLLAMA_HOST=0.0.0.0` y reinícialo:
- **Windows:** Configuración → "Editar las variables de entorno" → nueva variable `OLLAMA_HOST` = `0.0.0.0` → cierra y vuelve a abrir Ollama.
- **macOS:**
  ```bash
  launchctl setenv OLLAMA_HOST "0.0.0.0"
  ```
- **Linux:** `sudo systemctl edit ollama` → añade `[Service]` y `Environment="OLLAMA_HOST=0.0.0.0"` → `sudo systemctl restart ollama`.

En `config.json` del puente, apunta el backend a esa máquina: `{ "id": "ollama", "type": "ollama", "url": "http://IP-DE-OLLAMA:11434" }`.

---

## 7. Problemas frecuentes

| Síntoma | Solución |
|---|---|
| **ESTE PC** sale con `ollama ○` (apagado) | Abre Ollama (Windows/macOS) o ejecuta `ollama serve` y pulsa **RECONECTAR** |
| No aparece ningún modelo de Ollama | No hay modelos descargados: `ollama pull qwen3:4b` |
| La respuesta tarda mucho | Modelo demasiado grande para tu equipo: prueba `llama3.2:3b` |
| Aviso "Puertos 8787-8796 ocupados" | Hay otro puente abierto: ciérralo o cambia `port` en `escritorio.json` |
| Perdí el móvil o se filtró el QR | ⬡ → ESTE PC → **REGENERAR** token: los dispositivos con el antiguo dejan de entrar; vuelve a emparejar los tuyos con el QR nuevo |
| Aviso «No se ha podido guardar» | El almacenamiento del navegador está lleno: pulsa **EXPORTAR COPIA** para no perder nada y borra hilos antiguos con imágenes |
| El móvil no conecta con el PC | Mismo Wi-Fi, **ABRIR A MI RED** activado, permite Neura en el firewall y revisa el token |
| En iPhone no conecta | Acepta el permiso de **red local** que pide iOS la primera vez |
| La búsqueda en documentos dice "keyword" | Falta el modelo de embeddings: `ollama pull nomic-embed-text` |
| El dictado no funciona | Añade Groq en ⚙ (gratis) y permite el micrófono |
| ⏳ en una IA con la clave ya corregida | ⚙ → **REINTENTAR YA** en esa IA (cambiar la clave también lo reinicia) |
| Quiero reiniciar Neura de cero | Cierra la app y borra la carpeta de datos (apartado 3); haz antes una copia |
