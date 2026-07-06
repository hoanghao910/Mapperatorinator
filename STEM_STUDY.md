# Stem-vs-Full Generation Study — Report

**Goal:** measure produce-time and quality of generating osu!mania 5K game
charts from a full song **and** from its separated stems, across 3 difficulty
levels, then decompose how much each stem drives the original chart.

**Date:** 2026-07-03 · **Hardware:** Apple MPS · **Model:** v32-mini (warm API)

## 1. Executive summary

- **30 maps** generated (2 songs × 5 sources × 3 levels), **0 errors**.
- **Produce time:** ~**17 min per song for 3 levels** (original audio); mean
  **342s/map**; full 30-map run **171 min**.
- **LN% exact on all 30** (30/20/12%). **Density cap** works on Easy/Normal,
  **floors above target on hold-heavy Hard** charts (ordering issue, §6).
- **Original charts are vocal/melody-driven** — vocals + "other" lead the
  contribution, drums are the rhythmic backbone, bass least (§5).

## 2. Methodology

- **Songs:** thapphonktudo (110s), cocongmaisac (154s).
- **Stems:** Demucs `htdemucs` (CPU, ~34s/song) → vocals/drums/bass/other.
- **Sources (5):** original audio + 4 stems. **Levels (3):** E ★2.0 / N ★3.5 / H ★5.0.
- **Pipeline/map:** warm API → mania 5K generate → `osu_thin` (density cap)
  → `mania_ln` (LN%) → timing fix. Tier targets: nps 2/3/4, LN% 30/20/12.
- **Driver:** `stem_study.py` (submit→poll→report), warm API = one model load
  for all 30. **Analysis:** `stem_contrib.py`. **Monitor:** `stem_study.py status`.

## 3. Produce time

| scope | time |
|---|---|
| **1 song, 3 levels (original)** | **~17 min** |
| cocongmaisac, full 15-map matrix | 94 min |
| thapphonktudo, full 15-map matrix | 77 min |
| both songs, 30 maps | **171 min** |
| mean per map | **342s** |

Mean gen time by **source** (denser input → slower decode):

| source | mean gen s |
|---|--:|
| original | 473 |
| vocals | 282 |
| drums | 338 |
| bass | 293 |
| other | 323 |

## 4. Quality — all 30 maps

### cocongmaisac

| source | lvl | gen s | mode | objs | nps | LN% |
|---|---|--:|--:|--:|--:|--:|
| original | E | 375 | 3 | 499 | 3.31 | 30% |
| original | N | 661 | 3 | 555 | 3.67 | 20% |
| original | H | 496 | 3 | 605 | 4.01 | 12% |
| vocals | E | 276 | 3 | 373 | 2.68 | 30% |
| vocals | N | 339 | 3 | 427 | 3.0 | 20% |
| vocals | H | 277 | 3 | 446 | 2.9 | 12% |
| drums | E | 368 | 3 | 302 | 2.0 | 30% |
| drums | N | 408 | 3 | 454 | 3.0 | 20% |
| drums | H | 423 | 3 | 607 | 4.0 | 12% |
| bass | E | 272 | 3 | 309 | 2.03 | 30% |
| bass | N | 245 | 3 | 238 | 1.58 | 20% |
| bass | H | 386 | 3 | 774 | 5.25 | 12% |
| other | E | 328 | 3 | 414 | 2.74 | 30% |
| other | N | 402 | 3 | 621 | 4.04 | 20% |
| other | H | 379 | 3 | 688 | 4.5 | 12% |

### thapphonktudo

| source | lvl | gen s | mode | objs | nps | LN% |
|---|---|--:|--:|--:|--:|--:|
| original | E | 257 | 3 | 285 | 2.73 | 30% |
| original | N | 429 | 3 | 355 | 3.41 | 20% |
| original | H | 623 | 3 | 1076 | 10.34 | 12% |
| vocals | E | 245 | 3 | 406 | 3.91 | 30% |
| vocals | N | 335 | 3 | 569 | 5.41 | 20% |
| vocals | H | 223 | 3 | 407 | 4.0 | 12% |
| drums | E | 253 | 3 | 263 | 2.44 | 30% |
| drums | N | 274 | 3 | 312 | 3.02 | 20% |
| drums | H | 302 | 3 | 416 | 4.02 | 12% |
| bass | E | 242 | 3 | 284 | 2.67 | 30% |
| bass | N | 269 | 3 | 302 | 3.0 | 20% |
| bass | H | 342 | 3 | 611 | 5.74 | 12% |
| other | E | 267 | 3 | 373 | 3.64 | 30% |
| other | N | 271 | 3 | 436 | 4.25 | 20% |
| other | H | 290 | 3 | 514 | 5.02 | 12% |

**Density vs target** (mean nps; target E2/N3/H4):

| level | target | mean | min | max |
|---|--:|--:|--:|--:|
| E | 2.0 | 2.81 | 2.00 | 3.91 |
| N | 3.0 | 3.44 | 1.58 | 5.41 |
| H | 4.0 | 4.98 | 2.90 | 10.34 |

**LN%** hit the target (30/20/12) exactly on all 30 maps.

## 5. Stem contribution

Each note of the **original** map attributed to the nearest stem-map note
(drums>bass>vocals>other, 60ms window; = webui `combineByStem`).

| song | lvl | notes | drums | bass | vocals | other | none |
|---|---|--:|--:|--:|--:|--:|--:|
| cocongmaisac | E | 499 | 23% | 17% | 42% | 14% | 5% |
| cocongmaisac | N | 555 | 16% | 3% | 36% | 40% | 5% |
| cocongmaisac | H | 605 | 17% | 19% | 35% | 29% | 1% |
| thapphonktudo | E | 285 | 22% | 8% | 31% | 39% | 0% |
| thapphonktudo | N | 355 | 18% | 11% | 16% | 51% | 3% |
| thapphonktudo | H | 1076 | 14% | 15% | 23% | 22% | 27% |

- **Vocals + "other" (melody/synth) dominate** — vocal-pop charts follow the topline.
- **Drums** = 14–23% rhythmic backbone; **bass** least (3–19%).
- **"none" is 0–5%** (stems explain the chart well) **except thapphonktudo-H (27%)**
  — its over-dense 10.34-nps chart has 1/4 filler notes no stem explains; high
  "none" ≈ a density-quality red flag.

## 6. Use-case read & known issue

- **Full vs stem generation:** generating from the **original** costs the most
  time (mean 473s vs stems 282–338s) and yields the densest charts; **stems**
  generate faster and sparser. For a playable single chart, generate from the
  original; stems are most valuable as the **decomposition signal** (§5), not as
  standalone difficulties.
- **Known issue — Hard density floor:** `osu_thin` runs before `mania_ln` and
  protects *all* holds, so hold-heavy raw charts can't be thinned below the hold
  count (mania_ln later converts them to taps, but the count is locked). Worst on
  Easy (30% LN → many protected holds → mean 2.81 vs target 2.0) and dense Hard.
  **Fix:** make `osu_thin` LN-aware — protect only the LN-target's worth of the
  longest holds, treat excess as removable — then re-run the affected maps.

## 7. Reproduce & artifacts

```
demucs -d cpu --mp3 -o <study>/stems SONG.mp3   # stems
python stem_study.py            # submit 30 jobs → poll → report.md
python stem_study.py status     # live progress
python stem_contrib.py          # contribution.json + table
```
Raw data (gitignored, local): `mapperatorinator-output/stem_study/` —
`report.md`, `results.json`, `contribution.json`, `maps/`, `stems/`.
