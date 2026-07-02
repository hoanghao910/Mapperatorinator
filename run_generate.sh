#!/bin/bash
# PART 1 of the pipeline — audio -> clean .osu (generation + timing fix).
# Everything about your game's JSON/MIDI formats lives in game_content_tools.
#
#   Stage 1: inference.py (v32-mini, MPS)   ->  raw .osu beatmap
#   Stage 2: osu_timing.py                  ->  timing-corrected .osu
#
# Usage:
#   ./run_generate.sh AUDIO.mp3 "Title" "Artist" [DIFFICULTY] [FIX] [OUT_DIR]
#
#   DIFFICULTY  star rating 1.0-10.0          (default 5.0)
#   FIX         auto|double_time|simplify|none for Stage 2 (default auto)
#   OUT_DIR     output dir                     (default mapperatorinator-output/new/<slug>)
#
# Output: <slug>.osu (raw) and <slug>_fixed.osu (timing-corrected).
# Hand <slug>_fixed.osu to game_content_tools' converter for BH/MT3/MIDI.
set -e

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

AUDIO="$1"; TITLE="$2"; ARTIST="$3"
DIFF="${4:-5.0}"; FIX="${5:-auto}"

if [ -z "$AUDIO" ] || [ -z "$TITLE" ] || [ -z "$ARTIST" ]; then
    echo "usage: $0 AUDIO.mp3 \"Title\" \"Artist\" [DIFFICULTY=5.0] [FIX=auto] [OUT_DIR]"; exit 1
fi
[ -f "$AUDIO" ] || { echo "audio not found: $AUDIO"; exit 1; }

SLUG=$(echo "$TITLE" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_//; s/_$//')
OUT_DIR="${6:-$REPO/mapperatorinator-output/new/$SLUG}"
mkdir -p "$OUT_DIR"

# Prefer the project venv (pinned deps); fall back to system python3.
if [ -x "$REPO/.venv/bin/python" ]; then PY="$REPO/.venv/bin/python"; else PY=python3; fi
export PYTORCH_ENABLE_MPS_FALLBACK=1

echo "============================================="
echo " Mapperatorinator — Part 1 (audio -> .osu)"
echo "   song : $ARTIST - $TITLE  (★$DIFF)"
echo "   audio: $AUDIO"
echo "   out  : $OUT_DIR"
echo "   fix  : $FIX"
echo "============================================="

# derive the LN tier (hold_note_ratio + LN target) from the star rating.
read HNR LNT TIER < <($PY -c "import mania_ln,sys; t=mania_ln.tier_for(float(sys.argv[1])); print(t['hold_note_ratio'], t['ln_target'], t['name'])" "$DIFF")
echo "   mode : osu!mania 5K  ·  LN tier: $TIER (hold_note_ratio=$HNR, target LN=$LNT)"

echo; echo "── Stage 1: inference (raw .osu) ──"
# osu!mania, 5 keys — matches the game's 5-lane format. Positions are irrelevant
# in mania (columns, not x,y), so generate_positions=false skips the diffusion pass.
$PY inference.py --config-name v32-mini \
    audio_path="$AUDIO" \
    output_path="$OUT_DIR" \
    difficulty="$DIFF" \
    title="$TITLE" \
    artist="$ARTIST" \
    gamemode=3 \
    keycount=5 \
    hold_note_ratio="$HNR" \
    generate_positions=false \
    seed=42 \
    device=mps

RAW=$(find "$OUT_DIR" -maxdepth 1 -name "*.osu" ! -name "*_fixed.osu" | head -1)
[ -n "$RAW" ] || { echo "❌ no .osu produced — check inference output"; exit 1; }
# Normalise to <slug>.osu so downstream paths are predictable.
OSU="$OUT_DIR/$SLUG.osu"
[ "$RAW" = "$OSU" ] || mv "$RAW" "$OSU"
echo "   ✅ raw .osu: $OSU"

echo; echo "── Stage 1.5: mania long notes ($TIER tier, target LN $LNT) ──"
# hold_note_ratio only turns LNs on; this pass sets the exact per-tier LN% by
# converting the most-sustained taps to holds (HPSS harmonic energy).
$PY mania_ln.py "$OSU" --audio "$AUDIO" --target "$LNT" -o "$OSU"

echo; echo "── Stage 2: timing fix (corrected .osu) ──"
# auto detection prefers a sibling <audio>.analysis.json bpm if present.
$PY osu_timing.py "$OSU" -o "$OUT_DIR/${SLUG}_fixed.osu" --fix "$FIX" --audio "$AUDIO"

echo; echo "✅ DONE. Part 1 outputs in: $OUT_DIR"
echo "   next: convert ${SLUG}_fixed.osu in game_content_tools"
ls -1 "$OUT_DIR"/*.osu
