#!/bin/bash
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$REPO"
PY="$REPO/.venv/bin/python"; export PYTORCH_ENABLE_MPS_FALLBACK=1
AUDIO='/Users/haonguyen/Works/Documents/AudioSource/MJ/GiveInToMe/new/GiveInToMe_Short.mp3'
OUT=/tmp/lncal; rm -rf "$OUT"; mkdir -p "$OUT"; : > "$OUT/timings.tsv"
run() { # label diff ratio
  local label="$1" diff="$2" ratio="$3"; local od="$OUT/$label"; mkdir -p "$od"
  echo "=== $label (★$diff, ratio=$ratio) ==="; local start=$(date +%s)
  $PY inference.py --config-name v32-mini \
    audio_path="$AUDIO" output_path="$od" \
    title="Give In To Me" artist="Michael Jackson" \
    gamemode=3 keycount=5 difficulty="$diff" hold_note_ratio="$ratio" \
    generate_positions=false seed=42 device=mps > "$od/run.log" 2>&1 || echo "FAILED $label"
  local end=$(date +%s); local osu=$(find "$od" -maxdepth 1 -name '*.osu' | head -1)
  local ln=$(awk '/^\[HitObjects\]/{f=1;next} f&&NF{n++;split($0,a,",");if(a[4]==128)h++} END{printf "%d\t%.0f",n,100*h/n}' "$osu" 2>/dev/null)
  printf '%s\tdiff=%s\tratio=%s\t%ss\tobj+LN%%=%s\n' "$label" "$diff" "$ratio" "$((end-start))" "$ln" | tee -a "$OUT/timings.tsv"
}
run easy 2.0 0.1
run normal 5.0 0.2
run hard 8.0 0.3
echo "ALL DONE"; cat "$OUT/timings.tsv"
