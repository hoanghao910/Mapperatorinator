# Mapperatorinator Web UI — Visualize / Analyze

A browser SPA (React + Vite + TypeScript) that **visualizes** an osu! beatmap and
**overlays MaiMod analysis** (per-object "real vs. expected" findings with
severity). This is the new web UI replacing the role of the two pywebview desktop
apps for inspection — see `../WEBUI_PLAN.md` for the full plan.

Built v1 = **Phase 0–2**: structured analysis JSON, the renderer, and the findings
overlay. Modify (Phase 3) and a Generate tab (Phase 4) are not built yet.

## Run

```bash
cd webui
npm install        # first time
npm run dev        # http://localhost:5180
```

It ships **bundled demos** (Dirty Diana, Beat It — each a `.osu` + matching audio +
a real `maimod.json`), picked from the **`demo` dropdown** in the topbar, so it works
with no backend. Demo audio must be the exact file the chart was generated from
(same cut), or notes desync from the music. Use the top-right buttons to load your
own **Beatmap (.osu)**, **Audio**, and **Analysis (.json)**.

## Two modes (top nav)

- **Analyze** — the beatmap visualizer below (lane view + findings).
- **Pipeline Demo** — an interactive version of the slide deck (`src/pipeline/`),
  on the real Beat It clip assets (`public/fixtures/pipeline/`):
  - **① Audio · Stems** — stem-row layout: Original + Demucs Vocals/Drums/Bass/Other,
    each a waveform you can solo (`StemsView`).
  - **② Gameplay · 5-lane** — BH (Tiles-Hop) 5-lane falling-note field synced to the
    clip; gold tiles = accent-driven strong notes (`GameplayBHView`).
  - **③ Difficulties · Merge** — same stem-row layout: Easy/Normal/Hard density rows +
    a Merged row; type a pattern (`E N H N E`) and drag the seams to set each
    section's range, snapped to song sections (`MergeView`).

## What it does (Analyze mode)

- **Lane view** (`src/components/LaneView.tsx`) — **portrait, 5-lane falling-note**
  play column (matches the BH game format). osu! x-position maps to a lane
  (`src/lib/lanes.ts`), notes fall to a judgment line, hold notes (sliders) are bars,
  scroll speed is adjustable. Findings overlay as colored boxes on the note (or a
  dashed cross-lane line for non-positional timing findings).
- _(`src/components/Playfield.tsx` is an unused osu!standard 512×384 renderer kept for
  reference — not wired into the UI.)_
- **Timeline** (`src/components/Timeline.tsx`) — full-song bar: object density ticks,
  finding markers (height ∝ importance, color by severity), playhead. Click to seek;
  click a marker to select.
- **Findings panel** (`src/components/FindingsPanel.tsx`) — findings grouped by
  category, sorted by importance, severity filter. Click a finding → seek + highlight
  it on the playfield and timeline.
- Audio playback drives everything (`requestAnimationFrame` reads `audio.currentTime`).

Severity mirrors mai_mod: importance (= surprisal/10) ≥100 red "likely issue", ≥10
yellow "notable", else blue "subjective" (`src/lib/severity.ts`).

## Data contract

The analysis JSON is produced by `mai_mod.py json_output=true` (see
`../api/analyze_engine.py`, the warm bf16 engine, ~100 s/song). Shape:

```jsonc
{
  "mode": 0, "title": "...", "artist": "...", "version": "...",
  "count": 25, "categories": ["Compose", "Rhythm", ...],
  "suggestions": [{
    "category": "Compose", "time": 3881, "timestamp_time": 3881, "combo_index": 2,
    "surprisal": 29.2, "importance": 3, "context_type": "map",
    "group_type": "circle", "group_str": "Circle", "previous_group_str": "Slider End",
    "x": 87, "y": 23,
    "actual":   { "type": "pos_y", "value": 23, "str": "y:92" },
    "expected": { "type": "pos_y", "value": 22, "str": "y:88" },
    "explanation": "Expected position y:88 instead of y:92."
  }]
}
```

The TypeScript mirror is `src/types.ts` (`Analysis`/`Finding`).

## Wiring the live `/analyze` (deferred)

Today the panel reads a static `maimod.json`. To make it live, add `POST /analyze`
to `../api/server.py` using the warm `AnalyzeEngine`, and fetch it through the Vite
proxy (`/api` → `http://127.0.0.1:8770`, already configured in `vite.config.ts`).
Because analysis is ~100 s/song, a light queued job (like the generation queue) fits
better than a blocking request.

## Layout

```
src/
  App.tsx              shell: load .osu/audio/json, transport, wiring
  types.ts             Beatmap + Analysis/Finding types
  osu/parseOsu.ts      .osu parser (std): timing, slider end times, objects
  lib/osuMath.ts       CS radius, AR preempt, mm:ss:mmm
  lib/severity.ts      importance → color/tier/label
  lib/text.ts          strip Rich markup
  components/Playfield.tsx · Timeline.tsx · FindingsPanel.tsx
public/fixtures/       bundled demo (.osu, .mp3, .maimod.json)
```
