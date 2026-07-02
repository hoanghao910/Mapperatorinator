#!/bin/bash
# Launch the Mai Mod desktop UI (mai_mod_ui.py) — AI modding/analysis of an
# existing .osu (real vs. expected events). Flask + pywebview native window.
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$REPO"
PY="$REPO/.venv/bin/python"; [ -x "$PY" ] || PY=python3
export PYTORCH_ENABLE_MPS_FALLBACK=1
exec "$PY" mai_mod_ui.py
