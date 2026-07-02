# Web UI Plan — Visualize / Analyze / Modify osu! data

Deep-dive of the two existing desktop UIs (`web-ui.py`, `mai_mod_ui.py`) and a
plan to build a **web-based** UI for **visualizing, analyzing, and modifying**
beatmap data, reusing their functions and UI elements.

---

## A. How the two existing UIs are built (the shared "builder" pattern)

Both are the **same skeleton**: a Flask server wrapped in a pywebview native
window, with a browser fallback. They differ only in the form and how they
launch the model.

```
 Flask app  ──serves──►  template/*.html + static/*.js,*.css   (the UI)
     │
     ├─ GET  /                 render form (+ CSRF token, descriptor JSON)
     ├─ POST /validate_paths   compile_args() → autofill metadata from .osu
     ├─ POST /start_inference  launch a run, return job_id
     ├─ GET  /stream_output    Server-Sent Events: live console → browser
     ├─ POST /cancel_inference  terminate the run
     ├─ POST /open_folder       native file-manager (desktop only)
     └─ Api class (pywebview)   native file/folder pickers (desktop only)
```

**Key build facts (with refs):**

| Concern | web-ui.py (generation) | mai_mod_ui.py (analysis) |
|---|---|---|
| Run launch | `mp.Process(_inference_worker)` + a **persistent** `InferenceClient` server kept warm across runs (`web-ui.py:543-555`) | `subprocess.Popen([py, "mai_mod.py", "raw_output=true", ...])` (one-shot) |
| Live output | `_QueueWriter` → `mp.Queue` → SSE generator, splits on `\r` for tqdm % (`web-ui.py:350-401, 563-644`) | stdout pipe → SSE, regex-parsed on client |
| Form | 60+ fields auto-coerced into `InferenceConfig` (`web-ui.py:457-523`); descriptor multiselect from JSON | single field: `beatmap_path` |
| Cancel | `cancelled_jobs` set + `proc.terminate()` / `taskkill` (`web-ui.py:647-671`) | SIGTERM |
| Security | CSRF token, `hmac.compare_digest`, localhost-only, port 5000+ (`web-ui.py:153-187, 838`) | same |
| Native bridge | `Api` class: `browse_file/folder/image`, `save_file`, `set_window_title` — **pywebview only** (`web-ui.py:191-282`) | same |
| Frontend | vanilla JS + jQuery, no framework; i18n; 3-state descriptor checkboxes; conditional fields by gamemode/model | smaller; renders findings as collapsible category list |

**Neither UI has any beatmap renderer, playfield, timeline, or note editor.**
They are *launchers*: form → run → stream logs → open output folder.

---

## B. What's reusable vs. what must be built new

### Lift wholesale (works in a plain browser, no pywebview)
1. **SSE streaming pattern** — `start → /stream_output (EventSource) → end`, with
   tqdm-% progress parsing. Generic; reuse verbatim for any long task (generate,
   analyze). `web-ui.py:563-644`, `app.js:1243-1370`.
2. **CSRF token** — `secrets.token_urlsafe` + `hmac.compare_digest` before_request
   guard. `web-ui.py:153-187`.
3. **Job-card progress UI** — per-run card, progress bar, cancel, warning capture,
   output link. `app.js:1023-1130`.
4. **i18n system** — `data-i18n*` attributes + JSON locale files. `static/i18n.js`.
5. **Form widgets + dark theme CSS** (framework-free): 3-state checkbox, styled
   select, collapsible dropdown, flash messages, path-input group, conditional
   fields by gamemode/model. `static/style.css`, `app.js:185-232, 577-750`.
6. **Config export/import** — JSON round-trip of the whole form. `app.js:754-926`.
7. **`/validate_paths`** — `compile_args()` autofill of audio/metadata from a `.osu`.
   `web-ui.py:775-819`. Reusable as-is.

### Replace (pywebview-bound → web equivalents)
- `Api.browse_*` native pickers → `<input type="file">` + **upload** (the Part 1
  API already has `POST /jobs/upload`).
- `set_window_title` → `document.title`.
- `/open_folder`, `/open_log_file` native open → in-browser download / inline view
  (or keep, if the UI only ever runs on the same Mac).

### Build new (the actual product — nothing to reuse)
- **Beatmap renderer**: playfield (x/y 512×384) + scrolling timeline synced to audio.
- **Analysis overlay**: findings painted on timeline/playfield by severity.
- **Editor surface**: edit timing points / hit objects / metadata and write `.osu`.

---

## C. The biggest opportunity — mai_mod already computes structured analysis, then throws it away

`mai_mod.py` builds rich **`Suggestion`** objects, then **flattens them to Rich-markup
text strings** for the console. A visualizer wants the structured form, not text.

**`Suggestion` (mai_mod.py:54-71)** — already carries everything a visualizer needs:

| field | meaning |
|---|---|
| `time` / `timestamp_time` | ms position (editor-linkable) |
| `combo_index` | which hit object |
| `group_str` / `previous_group_str` | "Circle #3", "Slider Repeat #2" |
| `event` / `event_str` | **actual** value in the map |
| `expected_event` / `expected_event_str` | **model-predicted** value |
| `surprisal` | severity score (filtered ≥ 20) |
| `context_type` | TIMING / KIAI / GD / MAP / SV … |
| category | Compose / Rhythm / Sliders / Hit Sounds / Timing / Scroll Speeds / Kiai |

**Action:** add a `json_output` mode to `mai_mod.py` that emits `list[Suggestion]`
as JSON (alongside the existing `raw_output` text), and expose it through an API
endpoint. This single change turns the analysis engine into a data source the new
UI can render directly — no regex-scraping of console text.

---

## D. Proposed architecture for the new web UI

Keep the two-part split. The new UI is a **frontend + a thin analysis API in this
repo** (analysis needs `.venv` + the model), and it reuses the existing Part 1
generation API.

```
        New Web UI (browser, framework TBD)
        ├─ Visualize: canvas playfield + timeline (NEW)
        ├─ Analyze:   findings overlay              ──►  POST /analyze   (NEW, this repo)
        ├─ Modify:    timing/object/metadata editor ──►  osu_timing.py + .osu writer
        └─ Generate:  reuse existing form patterns   ──►  Part 1 API  :8770 (existing)
```

**Backend (this repo, alongside `api/server.py`):**
- `POST /analyze` (path or upload) → runs `mai_mod` analysis → returns the
  `Suggestion` JSON. Warm the model like `Engine` already does (`api/engine.py`).
  Long runs stream via the SSE pattern from `web-ui.py`.
- Reuse the existing job queue/store (`api/store.py`) so analysis jobs batch too.
- `POST /save_osu` → write modified `.osu` (timing via `osu_timing.py`, objects via
  a small serializer).

**Frontend (new):**
- Parse `.osu` for rendering. The `slider` package (already a dependency —
  `from slider import Beatmap` in `mai_mod.py`) gives hit objects + timing points;
  or parse client-side.
- Render playfield + timeline; overlay `Suggestion`s (color by `surprisal`, show
  actual→expected). Click a finding → seek timeline + highlight the object.
- Editor: drag timing points / nudge objects / edit metadata form (reuse the
  3-state checkbox, conditional-field, validation widgets), then `POST /save_osu`.

---

## E. Suggested phased build

1. **Phase 0 — structured analysis** (small, high-leverage): add `json_output` to
   `mai_mod.py`; add `POST /analyze` to the API; verify the JSON shape end-to-end.
2. **Phase 1 — visualize**: read-only renderer (playfield + audio-synced timeline)
   from a `.osu`. No editing yet.
3. **Phase 2 — analyze overlay**: paint `/analyze` findings on the timeline;
   finding list ↔ object linking; severity coloring.
4. **Phase 3 — modify**: timing-point + metadata editing → `/save_osu`; then
   hit-object editing.
5. **Phase 4 — generate tab**: fold in the existing generation form (reuse widgets)
   calling Part 1 `:8770`, so one UI does all four.

---

## Status (built so far — 2026-06-16)

- **Decisions made**: frontend = React/Vite SPA; v1 = Phase 0–2 (analysis JSON →
  renderer → findings overlay). Analysis perf deferred-then-solved (see below).
- **Phase 0 ✅** `mai_mod.py json_output` + `MaiModConfig` fields; warm
  `api/analyze_engine.py` (bf16). Fixed a real upstream bug: `ai_mod` never passed
  `out_context` → `_get_viable_template` crashed for every model (this path had
  never run in this checkout). Verified on a real run (25 findings).
- **Perf note**: MaiMod analysis is `fp32` ≈ 40 min/song but `bf16` ≈ 100 s/song on
  MPS — engine defaults to bf16. Requires the v30 model (861 MB, now downloaded).
- **Phase 1 ✅ / Phase 2 ✅** — `webui/` React app: playfield + audio-synced timeline,
  findings overlay colored by severity, grouped findings list, click-to-seek.
  Runs at `http://localhost:5180` with a bundled demo (no backend needed). Verified
  via headless-Chrome screenshot.
- **Deferred**: wire `POST /analyze` into `api/server.py` (engine exists); Phase 3
  modify; Phase 4 generate tab.

## F. Resolved decisions
- **Frontend stack**: lift the existing vanilla-JS + jQuery code directly (fastest
  reuse, but a stateful canvas editor gets unwieldy), or start fresh in a modern
  framework (React/Svelte — better for the editor, loses copy-paste reuse but the
  *patterns* and CSS still port).
- **Where analysis runs**: extend this repo's API (recommended — analysis needs the
  model + `.venv`) vs. a standalone service.
- **v1 scope**: visualize-only first, or visualize+analyze together.
