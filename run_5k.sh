#!/bin/bash
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$REPO"
PY="$REPO/.venv/bin/python"; export PYTORCH_ENABLE_MPS_FALLBACK=1
AUDIO='/Users/haonguyen/Works/Documents/AudioSource/MJ/GiveInToMe/new/GiveInToMe_Short.mp3'
OUT=/tmp/mania5k; rm -rf "$OUT"; mkdir -p "$OUT"; : > "$OUT/timings.tsv"
run() {
  local label="$1" diff="$2"; local od="$OUT/$label"; mkdir -p "$od"
  echo "=== $label (★$diff) ==="; local start=$(date +%s)
  $PY inference.py --config-name v32-mini \
    audio_path="$AUDIO" output_path="$od" \
    title="Give In To Me" artist="Michael Jackson" \
    gamemode=3 keycount=5 difficulty="$diff" generate_positions=false \
    seed=42 device=mps > "$od/run.log" 2>&1 || echo "FAILED $label"
  local end=$(date +%s); local osu=$(find "$od" -maxdepth 1 -name '*.osu' | head -1)
  local nobj=$(awk '/^\[HitObjects\]/{f=1;next} f&&NF{c++} END{print c+0}' "$osu" 2>/dev/null)
  printf '%s\t%s\t%s\t%s\n' "$label" "$((end-start))" "$nobj" "$osu" | tee -a "$OUT/timings.tsv"
}
run k5_d2 2.0
run k5_d5 5.0
run k5_d8 8.0
echo "ALL DONE"; cat "$OUT/timings.tsv"
