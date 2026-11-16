# Neura

**English** · [Español](README.md)

All public AIs in a single chat, making use of their free tiers, plus a menu to connect to MCP servers that act as a bridge to the local AI on your computers and servers.

```
neura/
├── app/       The app (HTML/CSS/JS, no build step)
├── android/   Native Android project (Capacitor)
├── ios/       Native iOS project (Capacitor)
├── desktop/   PC app (Windows, macOS, Linux) with Electron and the built-in bridge
├── docs/      Guides (PC + Ollama)
├── assets/    Source images for the icon and splash screen
└── bridge/    neura-bridge: dependency-free MCP server (Node 18+)
```

## Features

1. **One chat with all public AIs.** In **⚙** you add Gemini, Groq, OpenRouter (free models), Cerebras, Mistral, GitHub Models, Hugging Face, Cohere or NVIDIA (Nemotron; mobile and PC apps only, for testing and development) using each one's free key. Optional paid ones: Anthropic, OpenAI, DeepSeek. You pick the model from the dropdown, and the conversation continues even if you switch AIs.
2. **AUTO-SWITCH for free tokens.** If the selected AI runs out of free quota (429), fails or rejects the key, Neura resends the message to the next connected AI.
3. **MCP menu (⬡).** Connect to one or more MCP servers (`neura-bridge` or any other compatible one). Their local models appear in the same dropdown.
4. **Threads (≡).** Multiple saved conversations, with search and export (.md / .json backup). With a bridge connected, threads sync between PC, mobile and web without losing messages.
5. **Smart AUTO-SWITCH.** Remembers which AI ran out of quota and until when (it reads `Retry-After` and each provider's messages), doesn't retry it too early, ranks the others by success rate and speed, and shows this in ⚙ and with ⏳ in the dropdown.
6. **Context memory.** If a thread grows too long for the free AIs, older parts are summarized (with your local AI if you have one) and the summary + recent messages are sent. If an AI replies "context too long", Neura compresses and retries.
7. **⚖ COUNCIL.** Several AIs answer at once and one of them combines the best answer.
8. **Images, PDF, text and voice.** 📎 attaches photos (for AIs with vision), PDFs (text is extracted on the device) and text or code files. 🎤 dictates with Groq's Whisper (free) or the browser's dictation. **READ** reads a reply aloud.
9. **ƒ TOOLS.** AIs (public or local) can use the tools from your MCP servers: search and read documents in folders you share on your PC, with semantic search over them (local RAG with Ollama). Machine status (`system_info`) is only visible to the local AI, so the PC name and internal IPs are not sent to external providers.
10. **QR pairing and away from home.** The PC shows a QR code that connects your phone in one tap, and with Tailscale it works from anywhere.
11. **✦ Skills.** Create reusable procedures with AI, test them, save them with versions and turn them on in a thread: they apply with any AI, including after an AUTO-SWITCH. Import and export in `SKILL.md` format (Agent Skills).
12. **📁 Projects.** Grouped threads with an editable memory that every AI receives, plus a default skill. Skills and projects sync through the bridge.
13. **Guided setup, branches and more.** A wizard to connect your first free AI; ⑂ BRANCH and ✎ EDIT from any message; skill suggestions as you type; PDFs cited by page and scanned ones read with vision; COUNCIL with disagreements flagged; FREE ONLY and 🔒 PRIVATE threads.
14. **For beginners and professionals.** When you start, you choose between AI on your computer (on the PC, no accounts: Neura guides you through installing Ollama and downloads the right model for your memory) or AI on the internet (a per-provider guide to create the free key). **Beginner** mode shows the essentials, tips for good use and skills that teach; **Professional** shows everything.
15. **🔌 Neura Gateway (PC).** Connect your tools to the models and providers you use through Neura, with automatic selection and target and cost controls. OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`) and Anthropic-compatible API (`/v1/messages`), with streaming and tools, tested with both official SDKs. The configurations for Continue, Cline, Aider, Open WebUI and Claude Code are examples not yet validated with each tool (see `docs/VALIDACION.md`). Turn it on in ⬡ → THIS PC.
16. **Protected keys.** On the PC they are encrypted with the system keychain; on mobile and web, optionally with a PIN (AES-256). Keys are never synced.
17. **📊 Usage and spending cap.** In ⚙ → USAGE you see, per AI, today's requests, approximate tokens and spending for today and the month (and, separately, what went through the Gateway). Each AI accepts a **daily limit** of requests (warning at 80% and pause until midnight) and, if paid, its **price per million tokens**. With a **spending cap** in €/day or €/month, once it is reached Neura and the Gateway only use free AIs and your own computers; while a cap is set, paid AIs without a price are not used. Before each paid call, a maximum output is requested from the provider and its maximum cost is reserved; on the PC, the app and the Gateway reserve against a single balance in the bridge (`/neura/budget/reserve` and `/settle`, only from the same computer). You set the prices and input is estimated, so the actual bill comes from each provider.
18. **🩺 Diagnostics.** In ⚙ → DIAGNOSTICS, "TEST ALL MY AIs" sends a minimal request to each one (or to each model) and explains why each one fails: quota exhausted, key, retired model, computer offline…
19. **🎓 Learning path.** In beginner mode, 8 short challenges (give context, ask for a format, check an answer, compare AIs, work with a file…) that you complete by using Neura, with an example to try and a tip when you complete them.
20. **Import your history.** ≡ → IMPORT accepts, besides Neura backups, the official export from **ChatGPT** and **Claude** (`conversations.json`, also inside the .zip) and, experimentally, **Gemini** activity from Google Takeout in JSON (one thread per day). Re-importing does not create duplicates.
21. **🧭 Routing by task and votes.** Neura recognizes whether you are asking for code, a summary, reasoning or writing, and uses the AI you assign to that type, or the one you voted for most with **👍 BEST** in the COUNCIL (⚙ → ROUTING BY TASK, professional mode).
22. **Export to PDF.** ≡ → PDF: on the PC it is saved directly; on the web it opens the print dialog ("Save as PDF"); on mobile, a page ready to open and print.
23. **🖼 Free images on your PC.** With ComfyUI or Forge/AUTOMATIC1111 on the PC, type `/imagen` and what you want to see (also from a paired phone). A line `Evitar: …` is used as the negative prompt. The built-in **Image prompt** skill helps you write it.
24. **🌐 Web search with sources.** With a search engine in ⚙ (SearXNG, free and able to run on your PC, or Brave Search with a free key), **🌐 WEB** appears in the toolbar: Neura searches before asking, the AI receives the numbered results and answers citing [1], [2]…, and the message shows the links. Works with any AI, including local ones. A paired phone can use the PC's search engine. Searching is never private (SearXNG forwards the query to internet search engines), so 🔒 PRIVATE threads do not search. Results are marked as untrusted content and, when they are in the question, the AI gets no tools. It shows what was searched and warns if the answer cites a number that is not among the sources or cites none (it does not check that the source supports the claim).
25. **🔍 Where did my data go?** In ≡, the thread log shows what was sent to each destination (AIs, search engine, dictation, images), when, with which attachments, and whether it went to the internet or stayed on your computer. It is stored only on that device.
26. **📦 Batch tasks.** In ✦ SKILLS → **BATCH**: apply a skill to several files, or to a long document split into parts. Before sending anything, it checks the text of all files for sensitive data, with a single warning for the whole batch. Each one is answered separately, with AUTO-SWITCH, FREE ONLY and your spending cap; STOP halts it and CONTINUE resumes where it left off. The results stay in a thread you can export.
27. **🛡 Sensitive data.** Before sending to an internet AI, Neura detects on your device Spanish ID numbers (DNI/NIE), IBANs, cards, phone numbers, emails, passwords and API keys (validated to avoid false alarms) and lets you hide them, send them only to your local AI (the thread becomes 🔒 PRIVATE) or send them anyway.
28. **Help while you use AI.** Below the last reply, one-tap adjustments (Shorter, Simpler, With examples, As a table, More formal, Continue). **🔎 CHECK** on each reply reviews it with sources if you have a search engine. As you type, hints without AI (audience, format, tone) and a warning if you ask about something recent without 🌐 WEB. **ⓘ** explains why that AI answered and **?** explains each term (glossary in ⚙).
29. **✨ Professional prompts.** **STRUCTURE** turns what you write into a well-built prompt (role, goal, context, task, format and quality criteria), with [complete: …] gaps for whatever is missing. **PRO TEMPLATES** (email, summary, report, proposal, minutes, decision, explain, social media, project plan, review text or code, translation): fill in a few fields and the prompt is generated; they can be saved as a skill. Open them with the ✨ button next to the text box.
30. **🌐 Languages.** The interface is in Spanish, English, Chinese and Russian (⚙ → LANGUAGE). A new device starts in the system language; existing users stay in Spanish. The default instructions ask the AIs to reply in that language. Your messages and the replies are never translated.

Model names change often: press **SCAN MODELS** on each AI to fetch the current list. Keys are stored only on the device.

## MCP bridge for local AI

```bash
cd neura/bridge
cp config.example.json config.json   # edit backends and token
NEURA_TOKEN=un-secreto-largo node server.mjs
```

Works with Ollama, LM Studio, llama.cpp, vLLM or any OpenAI-compatible API. Exposes the MCP tools `list_models`, `chat` (with streaming, images and `tools: true` so the local model can use the file tools), `system_info`, `web_search` (the search engine configured in the PC app, or `"search"` in `config.json`), `image_generate` and `threads_sync` (saves threads to `~/.neura-bridge/hilos.json`, or to `NEURA_DATA`; turn it off with `"sync": false` in `config.json`).

If you share folders (`"folders": ["/ruta/a/documentos"]` in `config.json` or `NEURA_FOLDERS`), it adds **read-only** tools: `list_dir`, `search_files`, `read_file` and `search_docs` (semantic search with Ollama embeddings: `ollama pull nomic-embed-text`; without that model it searches by keywords). It never leaves the shared folders (it blocks `..`, absolute paths, hidden folders and symbolic links pointing outside). On startup it shows your network URL (e.g. `http://192.168.1.20:8787/mcp`): paste it into the app's ⬡ menu along with the token.

**Neura Gateway:** the bridge also serves `/v1/models`, `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic).
- **Its own token** (`NEURA_GATEWAY_TOKEN`, as `Authorization: Bearer` or `x-api-key`): only valid for `/v1/*` and gives no access to threads, files or settings. The bridge token does not work on `/v1/*`.
- **Disabled** until the PC app turns it on and passes it the user's AIs via `POST /neura/gateway`, only from the same computer and with the bridge token. The Gateway receives the keys in memory and does not create an extra copy on disk.
- **`auto`** tries the AIs in order and pauses the ones that fail: an invalid key pauses that whole provider; a nonexistent model, only that model; quota, for as long as `Retry-After` says. Fixing a target's configuration removes its pause.
- **An unknown model** returns a 404 error without calling any AI, unless "use auto for unknown names" is turned on.
- **If a provider cuts off mid-stream**, the client receives an error (`data: {"error":…}` for OpenAI, `event: error` for Anthropic), never a successful ending.
- **"Only models on this computer"** allows only backends on `127.0.0.1`/`localhost`: neither the internet nor other computers on the network.
- **Usage and spending cap:** counts requests, tokens (as reported by the provider, or an estimate) and spending per target and day in `gateway-uso.json` (62 days). `GET /neura/gateway` (only from the same computer, bridge token) returns it to the app. The cap is a **single balance** for the PC app and the Gateway: each paid call reserves before being sent (`POST /neura/budget/reserve`) and is settled once (`/settle`); checking and reserving is atomic. If the request does not set `max_tokens`, the Gateway sends 4,096.
- **Optional cache:** the exact same request within 10 minutes is answered without calling any AI (header `x-neura-cache: hit`). It is cleared when the configuration changes.

**Images (`image_generate`):** generates with **ComfyUI** (`http://127.0.0.1:8188`; a basic workflow with the first model in `models/checkpoints`, or your own in API format with `%PROMPT%`, `%NEGATIVE%`, `%SEED%`, `%WIDTH%`, `%HEIGHT%`, `%STEPS%`) or **Forge / AUTOMATIC1111 / SD.Next** with `--api` (`http://127.0.0.1:7860`). Configure them with `"images": [{ "id", "type": "comfyui" | "a1111", "url", "workflow"?, "checkpoint"? }]` in `config.json` or `NEURA_IMAGES`. The image never leaves the computer.

Variables: `PORT`, `HOST`, `NEURA_TOKEN`, `OLLAMA_URL`, `NEURA_CONFIG`, `NEURA_DATA`, `NEURA_FOLDERS`, `NEURA_EMBED_MODEL`, `NEURA_IMAGES`.

The bridge always requires a token, even on `127.0.0.1` (otherwise any website open on that computer could read your threads). If you don't set one, it generates a random one on each startup and shows it on screen. Set your own with `NEURA_TOKEN` so it doesn't change.

Bridge security tests: `node --test bridge/test.mjs`.

If a public AI blocks calls from the browser (CORS), add it as a bridge backend (it accepts `url` + `apiKey`) and use it through the bridge.

## PC app (Windows, macOS, Linux)

`desktop/` packages `app/` with Electron. It saves threads and settings to a file on disk, makes requests without CORS and starts the MCP bridge automatically, which appears in **⬡** as **THIS PC** with the Ollama models. With **OPEN TO MY NETWORK**, your phone connects to the PC and shares its threads.

```bash
npm run pc              # open in development mode (first time: cd desktop && npm install)
npm run pc:instalador   # builds the installer for your system in desktop/dist/
```

On every push to `main`, GitHub Actions builds the installer and portable version for Windows (`.exe`), macOS (`.dmg` / `.zip`) and Linux (`.deb` / `.AppImage`). Pushing a `version-X.Y.Z` branch (or a `vX.Y.Z` tag) publishes all of them, together with the Android APK, in **[Releases](https://github.com/AngelazoGit/neura/releases/latest)**.

**Full guide (installation, data, sync and Ollama installation):** [docs/ESCRITORIO-Y-OLLAMA.md](docs/ESCRITORIO-Y-OLLAMA.md)

## Native app (Android and iOS) with Capacitor

The project already includes the `android/` (Android Studio) and `ios/` (Xcode) folders, with Neura's icons and splash screen. The web app lives in `app/`; Capacitor copies it into each native project.

Advantage of the native version: requests go out through the phone's network (CapacitorHttp), so **there are no CORS blocks** with any provider and you can connect the MCP bridge over `http://` on your local network without tunnels or HTTPS.

**Setup (once)**
```bash
cd neura
npm install
```

**Every time you change something in `app/`**
```bash
npx cap sync
```

### Android (Windows, Mac or Linux)
1. Install [Android Studio](https://developer.android.com/studio) (it includes the SDK and Java).
2. `npx cap open android` → wait for Gradle to sync → ▶ Run with your phone connected via USB (USB debugging on) or an emulator.
3. Test APK without opening Android Studio: `npm run apk` → `android/app/build/outputs/apk/debug/app-debug.apk` (install it on your phone).
4. For Google Play: Android Studio → *Build → Generate Signed App Bundle* (.aab) and upload it to Google Play Console (Google developer account).

### iOS (requires a Mac)
1. Install Xcode from the App Store.
2. `npx cap open ios` → in *Signing & Capabilities* choose your team (Apple ID) → ▶ Run on your iPhone.
3. For the App Store: Apple Developer account → *Product → Archive* → *Distribute App*.
   The first time you connect an MCP bridge, iOS will ask for **local network** permission: allow it.

### Icons and splash screen
The source images are in `assets/`. If you change them: `npm run assets`.

### App identifier
`com.neura.app` (in `capacitor.config.json`). Change it to your own (e.g. `com.tuempresa.neura`) **before** publishing to the stores; it cannot be changed afterwards.

## Web app (free, no app stores)

The `app/` folder is published automatically to a separate public repository, `AngelazoGit/neura-web`, with GitHub Pages. The source code, the bridge and the native projects stay in this repository.

**Link:** https://angelazogit.github.io/neura-web/

**Update the website** after changing something in `app/` and committing:
```bash
npm run deploy:web
```

**Install on your phone from the link**
- **iPhone:** open it in Safari → Share → *Add to Home Screen*.
- **Android:** open it in Chrome → ⋮ menu → *Install app*.

**Differences from the native version:** some AIs block calls from the browser (CORS), and to use the MCP bridge from the web it needs HTTPS (`tailscale serve 8787` or `cloudflared tunnel --url http://localhost:8787`). The native version does not have these limitations.

## Security

- The bridge never starts without a token, not even on `127.0.0.1`: without `NEURA_TOKEN` it generates a random one. In the PC app, **⬡ → THIS PC → REGENERATE** creates a new one if you lose your phone or the QR code leaks.
- Attachments (images and PDF text) are stored separately, in IndexedDB, with their original bytes; the app state only stores references. If storage fills up, a persistent warning appears with **EXPORT BACKUP**.
- The app makes no third-party requests when it opens (fonts included in `app/fonts`, OFL license) and has a CSP policy that blocks injected scripts.
- API keys are stored only on the device and are never synced. On the PC they are encrypted with the system keychain (DPAPI on Windows, Keychain on macOS, libsecret/kwallet on Linux). On mobile and web you can encrypt them with a PIN in **⚙ → KEY SECURITY** (AES-256-GCM, PBKDF2). On Android they are excluded from backups.
- The bridge's file tools are read-only and never leave the folders you share. Only tools from your PC's bridge, from computers paired by QR and from servers you authorize in ⬡ are used without asking; the name a server declares does not count.
- **FREE ONLY** (⚙) prevents using paid AIs or AIs with unknown cost, and **🔒 PRIVATE** (per thread) limits replies to your own computers. Both check the bridge's actual backend (the bridge reports whether it is local; it can be forced with `"local": true/false` in `config.json`), and the bridge refuses to send a private thread to an external backend. Private threads only sync with your own computers and voice dictation is not used in them.
- PDF reading happens on the device itself with pdf.js (Apache-2.0, `app/vendor/`).
