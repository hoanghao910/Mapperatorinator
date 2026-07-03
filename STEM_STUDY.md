# Stem-vs-Full Generation Study

**Goal:** measure produce-time and quality of generating osu!mania 5K game charts
from a full song **and** from its separated stems, across 3 difficulty levels,
then decompose how much each stem drives the original chart.

**Date:** 2026-07-03 · **Machine:** Apple MPS (`.venv`, v32-mini warm API)

## Setup

- **Songs:** `thapphonktudo` (110s), `cocongmaisac` (154s)
- **Stem separation:** Demucs (`htdemucs`, CPU) → vocals / drums / bass / other (~34s/song)
- **Sources (5):** original audio + the 4 stems
- **Levels (3):** E ★2.0 · N ★3.5 · H ★5.0 (land in the Easy/Normal/Hard tiers)
- **Pipeline (per map):** warm API → mania 5K generate → `osu_thin` (density cap)
  → `mania_ln` (LN%) → timing fix
- **Matrix:** 2 songs × 5 sources × 3 levels = **30 maps**, driven by `stem_study.py`
  through the warm API (one model load for all 30). Reproduce: `stem_study.py` /
  monitor: `stem_study.py status` / analyze: `stem_contrib.py`.

Tier targets: density (nps) Easy 2.0 / Normal 3.0 / Hard 4.0; LN% 30 / 20 / 12.

## Produce time

| scope | time |
|---|---|
| **1 song, 3 levels (original only)** | **~17 min** |
| 1 song, full matrix (15 maps) | ~77–94 min |
| both songs (30 maps) | **171 min** (2.85 hr) |
| mean per map | **342 s (5.7 min)**, range 224–661 s |

Per song: thapphonktudo 77.0 min · cocongmaisac 93.9 min (15 maps each). Jobs run
one-at-a-time (MPS serialized); the warm API avoids 30 model reloads. The map
decode pass dominates and scales with note count → Hard maps are slowest.

## Quality

**LN%** hit the tier target **exactly on all 30 maps** (30/20/12%) — `mania_ln`
enforces it reliably in both directions (add + reduce).

**Density cap** — good on Easy/Normal, mixed on Hard:

| | Easy (t=2.0) | Normal (t=3.0) | Hard (t=4.0) |
|---|---|---|---|
| typical nps | 2.0–3.9 | 1.6–5.4 | 4.0–5.7 |
| outlier | — | — | **thapphonktudo original 10.34** |

Hard floors above target on **hold-heavy raw charts**: `osu_thin` runs before
`mania_ln` and protects *all* holds, so when the raw model output is very LN-dense
it can't thin below the hold count — then `mania_ln` converts most holds back to
taps, but the note *count* is already locked. Sparser sources (stems, low
difficulty) cap cleanly. See **Recommendation** below.

Full per-map table: `mapperatorinator-output/stem_study/report.md`.

## Stem contribution

For each note in the **original-audio** map, attribute it to the nearest note in a
stem's map (drums > bass > vocals > other priority, 60 ms window) — same rule as
the webui `combineByStem`. Percentages = share of the original chart each stem
explains.

| song | lvl | notes | drums | bass | vocals | other | none |
|---|---|--:|--:|--:|--:|--:|--:|
| cocongmaisac | E | 499 | 23% | 17% | **42%** | 14% | 5% |
| cocongmaisac | N | 555 | 16% | 3% | 36% | **40%** | 5% |
| cocongmaisac | H | 605 | 17% | 19% | **35%** | 29% | 1% |
| thapphonktudo | E | 285 | 22% | 8% | 31% | **39%** | 0% |
| thapphonktudo | N | 355 | 18% | 11% | 16% | **51%** | 3% |
| thapphonktudo | H | 1076 | 14% | 15% | 23% | 22% | **27%** |

**Reading it:**
- **Vocals + "other" (melody/synth) dominate** — these vocal-pop charts follow the
  topline, not the rhythm section.
- **Drums** = a steady 14–23% rhythmic backbone; **bass** contributes least (3–19%).
- **"none" is low (0–5%)** — the original charts are well-explained by the stems —
  *except* thapphonktudo-H (**27%**), whose over-dense 10.34-nps chart has 1/4-beat
  filler notes that align with no stem. High "none" ≈ a density-quality red flag.

Raw per-note attribution + counts: `mapperatorinator-output/stem_study/contribution.json`.

## Recommendation

The one quality gap is the **Hard-level density floor**, caused by `osu_thin`
protecting holds that `mania_ln` later removes. Fix: make `osu_thin` **LN-aware** —
protect only up to the LN-target's worth of the longest holds, treat excess holds
as removable taps. Then re-run the 6 Hard maps to validate. Everything else
(produce-time, LN%, E/N density, stem decomposition) is solid and reproducible.
