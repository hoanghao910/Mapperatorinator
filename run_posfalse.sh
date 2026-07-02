#!/bin/bash
# Isolate positions cost + mania difficulty scalability. All v32-mini, give-in-to-me clip.
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; cd "$REPO"
PY="$REPO/.venv/bin/python"; export PYTORCH_ENABLE_MPS_FALLBACK=1
AUDIO='/Users/haonguyen/Works/Documents/AudioSource/MJ/GiveInToMe/new/GiveInToMe_Short.mp3'
OUT=/tmp/posfalse; rm -rf "$OUT"; mkdir -p "$OUT"
: > "$OUT/timings.tsv"

run() { # label extra_args...
  local label="$1"; shift
  local od="$OUT/$label"; mkdir -p "$od"
  echo "=== $label ==="
  local start=$(date +%s)
  $PY inference.py --config-name v32-mini \
    audio_path="$AUDIO" output_path="$od" \
    title="Give In To Me" artist="Michael Jackson" \
    seed=42 device=mps "$@" > "$od/run.log" 2>&1 || echo "FAILED $label"
  local end=$(date +%s)
  local osu=$(find "$od" -maxdepth 1 -name '*.osu' | head -1)
  local nobj=$(awk '/^\[HitObjects\]/{f=1;next} f&&NF{c++} END{print c+0}' "$osu" 2>/dev/null)
  printf '%s\t%s\t%s\t%s\n' "$label" "$((end-start))" "$nobj" "$osu" | tee -a "$OUT/timings.tsv"
}

# 1) standard, positions ON vs OFF  (isolate diffusion cost)
run std_posT difficulty=5.0 generate_positions=true
run std_posF difficulty=5.0 generate_positions=false
# 2) mania difficulty sweep (positions irrelevant in mania)
run mania_d2 gamemode=3 keycount=4 difficulty=2.0 generate_positions=false
run mania_d5 gamemode=3 keycount=4 difficulty=5.0 generate_positions=false
run mania_d8 gamemode=3 keycount=4 difficulty=8.0 generate_positions=false
echo "ALL DONE"; cat "$OUT/timings.tsv"
