#!/bin/bash
# A/B benchmark: v32 vs v32-mini across 3 tracks. Raw inference only (no timing fix).
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"
PY="$REPO/.venv/bin/python"
export PYTORCH_ENABLE_MPS_FALLBACK=1

OUT=/tmp/ab3
rm -rf "$OUT"; mkdir -p "$OUT"

declare -a TRACKS=(
  "give|/Users/haonguyen/Works/Documents/AudioSource/MJ/GiveInToMe/new/GiveInToMe_Short.mp3|Give In To Me|Michael Jackson"
  "beat|/Users/haonguyen/Works/Documents/AudioSource/MJ/new/BeatIt_short.ogg|Beat It|Michael Jackson"
  "smooth|/Users/haonguyen/Works/Documents/AudioSource/MJ/SmoothCriminal/smooth_criminal_radio_cut.mp3|Smooth Criminal|Michael Jackson"
)

: > "$OUT/timings.tsv"
for cfg in v32-mini v32; do
  for t in "${TRACKS[@]}"; do
    IFS='|' read -r key audio title artist <<< "$t"
    od="$OUT/$cfg/$key"; mkdir -p "$od"
    echo "=== $cfg / $key ==="
    start=$(date +%s)
    $PY inference.py --config-name "$cfg" \
        audio_path="$audio" \
        output_path="$od" \
        difficulty=5.0 \
        title="$title" \
        artist="$artist" \
        generate_positions=true \
        seed=42 \
        device=mps > "$od/run.log" 2>&1 || echo "FAILED $cfg/$key"
    end=$(date +%s)
    secs=$((end-start))
    osu=$(find "$od" -maxdepth 1 -name "*.osu" | head -1)
    printf '%s\t%s\t%s\t%s\n' "$cfg" "$key" "$secs" "$osu" | tee -a "$OUT/timings.tsv"
  done
done
echo "ALL DONE"
