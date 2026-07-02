#!/bin/bash
# Launch the main Mapperatorinator generation desktop UI (web-ui.py).
# Flask + pywebview native window. Falls back to a browser URL if no GUI backend.
#   ./run_ui.sh            # native window
#   MAPP_UI_BROWSER=1 ./run_ui.sh   # print URL, open in your own browser instead
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$REPO"
PY="$REPO/.venv/bin/python"; [ -x "$PY" ] || PY=python3
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec "$PY" web-ui.py
