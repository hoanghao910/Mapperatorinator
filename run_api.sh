#!/bin/bash
# Launch the Mapperatorinator generation API (Part 1: audio -> clean .osu).
# Other projects (game_content_tools) POST jobs here and poll for the .osu.
#
#   ./run_api.sh [HOST] [PORT]
#
# Defaults: 127.0.0.1:8770  (local only). Use 0.0.0.0 to expose on the LAN.
# (8000 is taken by the hooktheory web backend, so this defaults to 8770.)
# Env: MAPP_DEVICE (default mps), MAPP_CONFIG (default v32-mini).
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"   # inference.py reads some configs relative to cwd

HOST="${1:-127.0.0.1}"; PORT="${2:-8770}"
if [ -x "$REPO/.venv/bin/python" ]; then PY="$REPO/.venv/bin/python"; else PY=python3; fi
export PYTORCH_ENABLE_MPS_FALLBACK=1

echo "Mapperatorinator API → http://$HOST:$PORT  (docs: /docs)  device=${MAPP_DEVICE:-mps}"
# One worker only: the model is single-instance and MPS runs one job at a time.
exec "$PY" -m uvicorn api.server:app --host "$HOST" --port "$PORT" --workers 1
