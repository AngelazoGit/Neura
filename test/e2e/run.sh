#!/usr/bin/env bash
# Baterías de punta a punta de Neura (app de PC real con Electron, web en Chromium y servidores simulados).
# Requisitos (una vez):
#   npm --prefix desktop ci
#   npm i --no-save playwright openai @anthropic-ai/sdk && npx playwright install chromium
#   En Linux sin pantalla: xvfb (xvfb-run)
# Uso, desde la raíz del repositorio:  bash test/e2e/run.sh
# Usa los puertos 5601 (IA simulada), 11434 (Ollama simulado) y 8787-8799 (puentes): ciérralos antes.
set -u
cd "$(dirname "$0")"
export NODE_PATH="${NODE_PATH:-$(npm root)}:$(cd ../.. && npm root)"
XV=""; if [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null; then XV="xvfb-run -a"; fi
fail=0
for t in adjuntos web; do echo "== $t"; node "$t.cjs" || fail=1; done
for t in inicio consumo aprender gateway desktop gemini v111 skills proj fase2 revision token idbdesk; do echo "== $t"; $XV node "$t.cjs" || fail=1; done
echo "== sdk (clientes reales)"; if [ -d ../../node_modules/openai ] && [ -d ../../node_modules/@anthropic-ai/sdk ]; then node sdk.mjs || fail=1; else echo "omitido: npm i --no-save openai @anthropic-ai/sdk"; fi
echo "== puente y Markdown"; (cd ../.. && node --test --test-timeout=30000 bridge/test.mjs test/md.test.cjs) || fail=1
[ $fail = 0 ] && echo "TODAS LAS BATERÍAS OK" || echo "HAY FALLOS"
exit $fail
