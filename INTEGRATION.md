# Mapperatorinator → Game Content Workflow — Integration Guide

How the AI map generator (Mapperatorinator) fits into the rhythm-game content
platform at `~/Works/SourceCode/game_content_tools` (MagicTiles / TilesHop /
BeatBlader / DancingBallz).

> **Status:** the pipeline is split in two repos by responsibility:
> **Part 1 (this repo, Mapperatorinator)** = audio → timing-corrected `.osu`;
> **Part 2 (`game_content_tools`)** = `.osu` (+analysis) → your game formats.
> Both halves are built and verified. The *canonical MIDI path* into
> `midi_to_chart.py` is designed and ready to build (see [§7](#7-canonical-midi-path-planned)).
>
> The clean handoff between the two parts is a **standard `.osu` file** —
> portable, inspectable, and already understood by the converter.

---

## 1. What this gives you

From a song (full or cut), produce a playable chart that is **musically aware**:

| Signal | Source | Lands in |
|--------|--------|----------|
| Note rhythm + layout | Mapperatorinator v32-mini (diffusion) | all formats |
| **Song structure / mood timing** | SongFormer (real sections) | BH meta lane 9 |
| **Strong (accent) notes** | Demucs drums stem, snare/kick onsets | BH + MT3 `variant` |
| Beat grid / tempo | librosa | analysis.json |

This replaces the old crude heuristics (fake 8-beat "structure", top-25% strong).

---

## 2. One-time machine setup

Already done on this machine; recorded here for a fresh setup.

**Mapperatorinator env** — a dedicated venv is required (system python's
`transformers 5.x` breaks the model; pin **4.57.3**):
```bash
cd ~/Works/Workspace/Mapperatorinator
python3 -m venv .venv
.venv/bin/python -m pip install torch torchaudio
.venv/bin/python -m pip install -r requirements.txt   # drop pywebview/pyqtwebengine (GUI-only)
.venv/bin/python -m pip install librosa               # used by the converter
```
Models (`OliBomby/Mapperatorinator-v32-mini`, `osu-diffusion-v2`) auto-download
on first run, then cache.

**Analysis models:**
- SongFormer runs in its own venv: `/Users/haonguyen/SongFormer/.venv/bin/python`
  (py3.10 / torch 2.4). Override with `$SONGFORMER_PYTHON`.
- Demucs runs under **system python3** (`demucs 4.0.1`).

---

## 3. The pipeline

```
 audio (full or cut .mp3)
    │
    │  ┌──────────────── PART 1 — Mapperatorinator (this repo) ───────────────┐
    └─►│ run_generate.sh                                                       │
       │   inference.py  → raw .osu   →  osu_timing.py  → <slug>_fixed.osu     │
       │   [.venv, MPS]                  (auto double-time / simplify fix)     │
       └───────────────────────────────────┬──────────────────────────────────┘
                                            │  handoff = a clean .osu
    ┌──(A)── analyze.py ─► <audio>.analysis.json  (structure + accents + beats)
    │        [game_content_tools/scripts, system python3 + SongFormer venv]
    │                                       │
    │  ┌────────────── PART 2 — game_content_tools ──────────┐
    └─►│ osu_to_json.py  <slug>_fixed.osu (+analysis)         │
       │    → BH + MT3 JSON   (enriched with structure+accents)│
       │ midi_to_chart / master_converter / song_uploader …   │
       └──────────────────────────────────────────────────────┘
```

**Part 1** (audio → clean `.osu`) lives here. **Part 2** (`.osu` → game content)
lives in `game_content_tools/scripts`, next to the rest of the format/upload chain.

> Part 1 can also run **as an HTTP service** so Part 2 calls it across the
> environment boundary (no shared `.venv`) and batches many songs through a
> persistent queue — see **[API.md](API.md)** and
> `game_content_tools/scripts/mapperatorinator_client.py`. The CLI recipe below
> still works for one-off local runs.

Run (A) `analyze.py` once per audio (expensive, reusable). Run Part 1 per
difficulty. Part 1 and (A) are independent — but having the analysis present lets
Part 2 produce enriched maps automatically.

---

## 4. Per-song recipe

```bash
SONG_AUDIO='/Users/haonguyen/Works/Documents/AudioSource/MJ/SmoothCriminal/smooth_criminal_radio_cut.mp3'

# (A) ONCE per audio — semantic analysis (SongFormer + Demucs + librosa)
cd ~/Works/SourceCode/game_content_tools
python3 scripts/analyze.py --audio "$SONG_AUDIO" \
    -o "$SONG_AUDIO.analysis.json" --device mps --stems-dir _cache/stems

# PART 1 — PER difficulty — generate + timing fix  (audio → clean .osu)
cd ~/Works/Workspace/Mapperatorinator
./run_generate.sh "$SONG_AUDIO" "Smooth Criminal" "Michael Jackson" 3.0   # easy
./run_generate.sh "$SONG_AUDIO" "Smooth Criminal" "Michael Jackson" 5.0   # normal
./run_generate.sh "$SONG_AUDIO" "Smooth Criminal" "Michael Jackson" 7.0   # hard
#   → mapperatorinator-output/new/<slug>/<slug>.osu  +  <slug>_fixed.osu

# PART 2 — convert the corrected .osu → enriched BH + MT3 JSON
cd ~/Works/SourceCode/game_content_tools
OUT=~/Works/Workspace/Mapperatorinator/mapperatorinator-output/new/smooth_criminal
python3 scripts/osu_to_json.py "$OUT/smooth_criminal_fixed.osu" \
    --title "Smooth Criminal" --artist "Michael Jackson" \
    --audio "$SONG_AUDIO" --audio-name "$(basename "$SONG_AUDIO")" \
    --analysis "$SONG_AUDIO.analysis.json" --strong-percent 15 \
    --out-dir "$OUT" --slug smooth_criminal
```

Part 1 outputs (per difficulty) in `mapperatorinator-output/new/<slug>/`:
```
<slug>.osu          # raw inference
<slug>_fixed.osu    # timing-corrected — feed this to Part 2
```
Part 2 outputs (one set per `.osu`):
```
<slug>_bh.json   <slug>_mt3.json
```
The JSON shell matches `game_content_tools` charts exactly (same `notes` schema
+ `songMeta`), so they drop straight into that platform.

> **Note:** `mapperatorinator-output/new/` is treated as transient — your own
> workflow moves/ingests these. Keep the durable `analysis.json` next to the
> source audio. Maps are deterministic (`seed=42`) and cheap to regenerate.

---

## 5. The analysis.json contract

The single artifact both the preview path and the (planned) MIDI path consume.
All times in **seconds** (so it cuts/joins exactly like the charts).

```json
{
  "audio": "smooth_criminal_radio_cut.mp3",
  "duration": 93.481,
  "bpm": 117.45,
  "beats": [0.51, 1.02, ...],
  "downbeats": [0.51, 2.55, ...],
  "sections": [
    {"start": 0.0,  "end": 18.0, "label": "intro"},
    {"start": 18.0, "end": 34.2, "label": "verse"},
    {"start": 34.2, "end": 50.5, "label": "chorus"}
  ],
  "accents": [
    {"time": 1.58, "kind": "snare", "strength": 0.91},
    {"time": 2.10, "kind": "kick",  "strength": 0.40}
  ]
}
```

`analyze.py` flags: `--skip-songformer | --skip-accents | --skip-beats`,
`--device`, `--stems-dir`, `--win-size` (SongFormer RAM bound).

---

## 6. Tuning knobs

### Part 1 — timing fix (`osu_timing.py`, this repo)

| Flag | Effect | Default |
|------|--------|---------|
| `--fix auto` | double-time fix only when the tempo looks doubled (see below) | `auto` |
| `--fix double_time` | force-halve every uninherited BPM (e.g. hard came out 235 → 117) | — |
| `--fix simplify` | cluster jittery timing points into stable sections (chaotic BPM) | — |
| `--fix none` | copy timing through unchanged | — |
| `--ref-bpm N` | reference tempo for `auto`; else read from a sibling `<audio>.analysis.json` | (auto) |
| `--dt-threshold N` | `auto` halves when BPM > this and no ref-bpm | `180` |

`auto` logic: with a reference BPM (explicit `--ref-bpm` or the analysis.json next
to the audio), it halves when `BPM/2 ≈ ref` (±8%); without one, it halves when
`BPM > dt-threshold`. `simplify` is never automatic — pass it explicitly.

`run_generate.sh` runs this as Stage 2 and passes `--audio` so `auto` can find the
analysis BPM. Override per run with the 5th arg:
```bash
./run_generate.sh <audio> "Title" "Artist" 7.0 double_time   # force DT on a hard diff
```

### Part 2 — enrichment (`osu_to_json.py`, game_content_tools)

| Flag | Effect | Default |
|------|--------|---------|
| `--analysis FILE` | use real structure + drum accents | off |
| `--strong-percent N` | **TARGET mode**: flag top N% of notes by accent strength; self-calibrates per song (consistent density across tracks) | off |
| `--strong-threshold F` | ABSOLUTE mode: min accent strength; varies per song (`0.15`=20% on Smooth Criminal but 36% on Dirty Diana) | `0.12` |
| `--formats bh,mt3` | which formats to emit | both |

Re-convert / re-tune any existing `.osu` (no regeneration needed):
```bash
python3 scripts/osu_to_json.py <file_fixed.osu> \
  --title "..." --artist "..." --audio-name "<audio>.mp3" \
  --analysis "<audio>.analysis.json" --strong-percent 15 \
  --out-dir <dir> --slug <slug>
```

---

## 7. Canonical MIDI path (planned)

Makes Mapperatorinator a first-class **source** in `game_content_tools` (all 4
game formats + Firebase/Sheets upload), reusing its mature rules instead of the
preview converter's.

```
.osu + analysis.json
   │  osu_to_master_midi.py   ← TO BUILD (the one new glue script)
   ▼
multi-lane source MIDI:
   • ch0 pitch 96+(lane-1)              ← .osu notes
   • velocity > 95.25 = STRONG          ← drum accents  (platform's strong rule)
   • low-pitch (≤16) color-change notes ← SongFormer sections (platform's mood rule)
   • note duration = long               ← .osu slider lengths
   │
   ▼
midi_to_chart.py → MT3 / BH      (long-note escalation, zigzag, mood collapse)
master_converter.py → DB / BB
song_uploader.py → Firebase / Sheets   (only on explicit request)
```

Why MIDI-first: your platform is MIDI-first, and the two missing signals map
*natively* onto MIDI — strong=velocity, mood=low-pitch events — so one authoring
script unlocks all four games + upload instead of re-implementing rules in JSON.

The **JSON preview path (§4) stays** as the quick-look output (hybrid model).

---

## 8. Cutting / joining songs

`cut_join_song.py` (now in `game_content_tools/scripts`) picks segments of a
chart JSON and joins them back-to-back (times shifted, no gaps), BH and MT3:
```bash
python3 scripts/cut_join_song.py INPUT.json 19.4:50 90:120 200:230 -o OUT.json
```
Cut the audio with the same segments (ffmpeg `atrim`+`concat`) to stay in sync.
The `analysis.json` timeline cuts the same way (future: a matching analysis-cut
helper so structure/accents follow the cut). See `cut_join_song_NOTE.md`.

---

## 9. Tools reference

| File | Repo | Part | Purpose |
|------|------|------|---------|
| `run_generate.sh` | Mapperatorinator | 1 | audio → raw .osu → timing-fixed .osu (one command) |
| `osu_timing.py` | Mapperatorinator | 1 | fix .osu timing (auto/double_time/simplify) |
| `inference.py` | Mapperatorinator | 1 | v32-mini diffusion: audio → raw .osu |
| `scripts/osu_to_json.py` | game_content_tools | 2 | .osu (+analysis) → BH/MT3 JSON |
| `scripts/cut_join_song.py` | game_content_tools | 2 | multi-segment cut & join of chart JSON |
| `scripts/analyze.py` | game_content_tools | A | audio → analysis.json |
| `scripts/songformer_runner.py` | game_content_tools | A | SongFormer subprocess (own env) |
| `scripts/midi_to_chart.py` | game_content_tools | 2 | MIDI → MT3/BH (canonical path target) |
| `scripts/master_converter.py` | game_content_tools | 2 | MT3/BH → DB/BB |
| `scripts/song_uploader.py` | game_content_tools | 2 | Firebase + Sheets publish |

---

## 10. Gotchas

- **Use `.venv`**, never system python, for Mapperatorinator (transformers 5.x
  breaks it; needs pinned 4.57.3).
- First runs download models (Mapperatorinator ~once, Demucs htdemucs ~80MB,
  SongFormer cached). Subsequent runs are offline-fast.
- SongFormer default window (420s) can OOM — `analyze.py` passes `--win-size 60`.
- `mapperatorinator-output/new/` content is transient (your workflow). Keep
  `analysis.json` durable.
- Don't upload to Firebase/Sheets unless explicitly intended.
