#!/bin/bash
# Clean the generated demo data wired into the webui.
#
# Today's generation fixes (mania 5K + mania_ln.py long-note polish) only change
# the GENERATED CHARTS (*.osu) and their MaiMod analysis (*.maimod.json). The
# derived audio JSON (peaks / BH / demo_data / analysis) and the source audio
# (*.mp3) are audio-derived, NOT generation-derived — so by default we leave
# those alone and only clear the stale charts + analysis.
#
# Nothing is destroyed by default: matched files are MOVED into a timestamped
# archive under public/fixtures/_archive/<ts>/ (mirroring their path), so an old
# vs. new compare is always possible and a clean is fully reversible.
#
# Usage:
#   ./clean_fixtures.sh                 # archive stale charts + maimod (default)
#   ./clean_fixtures.sh --all           # also archive derived JSON (keeps only *.mp3)
#   ./clean_fixtures.sh --list          # dry run: show generated vs. source, no changes
#   ./clean_fixtures.sh --delete        # DELETE matched files instead of archiving
#   ./clean_fixtures.sh --restore <ts>  # move an archive snapshot back into place
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIX="$HERE/public/fixtures"
ARCHIVE_ROOT="$FIX/_archive"

MODE="charts"     # charts | all
ACTION="archive"  # archive | delete | list
RESTORE_TS=""
ONLY=""           # optional filename substring filter (e.g. beat_it)

while [ $# -gt 0 ]; do
  case "$1" in
    --all)     MODE="all" ;;
    --charts)  MODE="charts" ;;
    --only)    ONLY="${2:-}"; shift ;;
    --list)    ACTION="list" ;;
    --delete)  ACTION="delete" ;;
    --restore) ACTION="restore"; RESTORE_TS="${2:-}"; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

[ -d "$FIX" ] || { echo "no fixtures dir at $FIX" >&2; exit 1; }

# ── restore ──────────────────────────────────────────────────────────────────
if [ "$ACTION" = "restore" ]; then
  SNAP="$ARCHIVE_ROOT/$RESTORE_TS"
  [ -n "$RESTORE_TS" ] && [ -d "$SNAP" ] || { echo "no archive snapshot: $SNAP" >&2; exit 1; }
  echo "restoring $SNAP -> $FIX"
  (cd "$SNAP" && find . -type f -print0) | while IFS= read -r -d '' rel; do
    dst="$FIX/${rel#./}"; mkdir -p "$(dirname "$dst")"; mv "$SNAP/${rel#./}" "$dst"
    echo "  restored ${rel#./}"
  done
  find "$SNAP" -type d -empty -delete 2>/dev/null || true
  echo "done."
  exit 0
fi

# ── select the files to clean ────────────────────────────────────────────────
# charts mode: generated charts + MaiMod analysis only.
# all mode:    everything under fixtures EXCEPT source audio (*.mp3) and archives.
select_files() {
  if [ "$MODE" = "all" ]; then
    find "$FIX" -type f -not -path "$ARCHIVE_ROOT/*" -not -iname '*.mp3'
  else
    find "$FIX" -type f -not -path "$ARCHIVE_ROOT/*" \
      \( -iname '*.osu' -o -iname '*.maimod.json' \)
  fi
}

# bash 3.2 (macOS) has no mapfile — read line-by-line (fixture paths have no spaces).
FILES=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -n "$ONLY" ] && case "$f" in *"$ONLY"*) : ;; *) continue ;; esac
  FILES+=("$f")
done < <(select_files | sort)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "nothing to clean (mode=$MODE) — fixtures already clean."
  exit 0
fi

echo "mode=$MODE  action=$ACTION  matched ${#FILES[@]} file(s):"
for f in "${FILES[@]}"; do echo "  ${f#$FIX/}"; done

if [ "$ACTION" = "list" ]; then
  echo ""
  echo "source (kept): $(find "$FIX" -type f -iname '*.mp3' -not -path "$ARCHIVE_ROOT/*" | wc -l | tr -d ' ') audio file(s)"
  exit 0
fi

# ── archive or delete ────────────────────────────────────────────────────────
if [ "$ACTION" = "delete" ]; then
  for f in "${FILES[@]}"; do rm -f "$f"; done
  echo "deleted ${#FILES[@]} file(s)."
else
  TS="$(date +%Y%m%d-%H%M%S)"
  SNAP="$ARCHIVE_ROOT/$TS"
  for f in "${FILES[@]}"; do
    rel="${f#$FIX/}"; dst="$SNAP/$rel"; mkdir -p "$(dirname "$dst")"; mv "$f" "$dst"
  done
  echo "archived ${#FILES[@]} file(s) -> ${SNAP#$HERE/}"
  echo "restore with:  ./clean_fixtures.sh --restore $TS"
fi
