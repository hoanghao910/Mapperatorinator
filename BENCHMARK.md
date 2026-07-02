# Mapperatorinator — Production Benchmark Report

**Scope:** v32 vs v32-mini, standard vs mania, positions on/off — evaluated for scalable / quality / speed.
**Hardware:** Mac, MPS (CPU-fallback bottlenecked). **Model:** v32-mini unless noted. **Star target:** ★5.0 unless noted.
**Test clips:** Give In To Me (82s), Beat It (86s), Smooth Criminal (94s) — all Michael Jackson.

> All "full song" figures are normalized to a **4.5-min (270s) track**.
> Scaling basis: test clip ≈ 1.37 min → ×3.3; fixed model-load overhead ~14s, generation scales ~linearly with duration.
> **Times are per 1 song × 1 difficulty.** A full 3-difficulty set = ~3× (see §4).

---

## 1. Measured data (82s clip → full 4.5-min song)

| Config | 82s clip | Objects | Est. full song (1 diff) |
|---|---|---|---|
| Standard, positions ON | 152s | 224 | ~7.5–8 min |
| Standard, positions OFF | 133s | 224 | ~7 min |
| Mania ★2 (Easy) | 166s | 445 | ~8–9 min |
| Mania ★5 (Normal) | 227s | 635 | ~12 min |
| Mania ★8 (Hard) | 231s | 662 | ~12 min |

**Positions true vs false:** disabling positions saves only **~13%** (~19s/clip). The diffusion x,y-placement
stage is just ~12s (batched, not autoregressive); object count is identical (224). The heavy cost is the
**autoregressive map decode (~85–90s)**, which doesn't change. → For a lane-based game, disabling positions is
**not** the main speed lever.

**Mania vs standard:** mania is **slower**, not faster (~12 vs ~7 min/song) because mania ★5 is ~3× denser
(635 vs 224 objects) and adds an extra **SV (slider-velocity) stage** (~35–40s).

---

## 2. v32 vs v32-mini (3-track A/B)

| Track | v32-mini | v32 | v32 slower |
|---|---|---|---|
| Give In To Me | 144s | 273s | 1.90× |
| Beat It | 212s | 335s | 1.58× |
| Smooth Criminal | 255s | 382s | 1.50× |
| **Avg** | | | **~1.66×** |

- Real speedup of mini is **~1.6×**, not the 3.9× parameter ratio (short clips are overhead-bound; the shared
  fixed cost dominates).
- **v32's one consistent quality edge:** tighter density control (nps band 3.4–4.0 across all tracks) vs mini,
  which over-maps busy tracks and under-maps sparse ones (2.73–4.79). The earlier "v32 uses fewer red lines"
  claim did **not** generalize across tracks — dropped.
- **Recommendation:** v32-mini as batch default; v32 for sparse/dynamic tracks where density control matters.

---

## 3. Mania quality (4K, v32-mini)

| Metric | ★2 | ★5 | ★8 |
|---|---|---|---|
| Objects | 445 | 635 | 662 |
| Median gap | 230ms | ~200ms | 115ms |
| Long notes (LN) | 0% | 3% | 0% |
| Column balance (c1/c2/c3/c4) | 24/26/26/24% | 24/26/25/25% | 25/25/26/24% |

- **Excellent column balance** — all 4 columns ~25% each → playable, hand-balanced charts.
- **Accurate rhythm/onsets** — core strength.
- **Long notes:** 0–3% here **only because `hold_note_ratio` was unset** (UNK fallback) — *not* a model limit.
  Enabling the ratio unlocks LNs, and 5K produces them unprompted (see §6).
- **Difficulty saturates above ★5** (★5 ≈ ★8 in object count) — reliable Easy/Normal/Hard, weak Insane/Expert.

---

## 4. Full 3-difficulty set (per song)

Each difficulty is a separate inference run (timing + map + sv regenerated each time).

| | Per 1 difficulty | Full E/N/H set |
|---|---|---|
| Mania ★2 (Easy) | ~8–9 min | |
| Mania ★5 (Normal) | ~12 min | |
| Mania ★8 (Hard) | ~12 min | |
| **Total per song** | | **~32–33 min** |

> Efficiency note: each difficulty currently re-runs the **timing stage (~34s)** redundantly — timing is
> identical across difficulties of the same song. Reusing one timing pass across all 3 would save ~68s/song.

---

## 5. Evaluation

### Scalable
- **Volume (1 diff/song):** ~5–8 songs/hr on one Mac → **~120–190/day** unattended.
- **Volume (3 diffs/song):** ~2 songs/hr → **~45 full E/N/H sets/day**.
- Queue/API scales linearly; CUDA GPU adds ~3–4×; parallel workers multiply.
- **Difficulty tiers:** ✅ one `difficulty` param yields a real Easy→Hard spread, but **saturates above ★5**.

### Quality (vs manual)
- **~80% — strong first draft.** Rhythm and column balance are near-manual.
- **Gaps to finish (the "polish pass"):**
  1. **Long notes (LNs) — mostly a config issue, now largely fixable.** LN = hold note — press-and-hold a key
     for a duration (osu! `type 128`), vs a "tap"/"rice" note hit once. The 0–3% LN in 4K was the **UNK
     fallback** (no `hold_note_ratio` passed). Setting `hold_note_ratio` unlocks LNs; keycount=5 even produces
     them unprompted. **But the ratio is an ON/OFF switch, not a precise dial** (see §6) — exact per-tier LN%
     still needs an audio-signal post-process.
  2. **Pattern ergonomics unverified.** Column *balance* is good, but jacks/rolls/trills need a hands-on
     playability check.
  3. **High-difficulty calibration.** Density saturates above ★5, so Insane/Expert tiers need manual tightening.
- Needs **one human polish pass** before final; not a replacement for a top mapper on ranked maps.

### Speed

**AI generation time:**
- **Best-cut (~90–120s — what a mapper actually maps):** mania ★5 ≈ **4–5.5 min/difficulty**; 3-diff set ≈
  **12–15 min**. *(near-measured — the test clips are 82–94s, i.e. best-cut length)*
- **Full 4.5-min song (AI can afford this; manual usually can't):** ≈ **12 min/difficulty**; 3-diff set ≈
  **32–33 min**. *(extrapolated ×3.3)*
- Standard mode is faster than mania (≈ 7 min/diff full song).

**vs manual (like-for-like, same ~90–120s best-cut):**
- Manual ≈ **1–2 hrs per difficulty** → 3-diff E/N/H set ≈ **3–6 hrs**. ⚠️ estimate, not benchmarked here.
- AI ≈ 4–5.5 min/diff → **~12–30× faster to a *draft*** (before the human polish pass in §Quality; that pass
  narrows the real edge).
- **Bonus beyond the multiplier:** manual is forced to cut to ~90–120s because full-song hand-mapping would be
  4–5× the hours; AI removes that constraint — it can map the **full song** for ~12 min/diff. So the practical
  win is both *faster per cut* **and** *full-length coverage manual can't afford*.
- **Real speed levers** (not disabling positions): (1) CUDA GPU vs MPS → ~3–4×; (2) v32-mini vs v32 → ~1.6×;
  (3) lower difficulty (★2 ~26% faster than ★5); (4) parallel batch/queue; (5) reuse timing across difficulties.

---

## 6. Mania: long notes (`hold_note_ratio`) & keycount

### `hold_note_ratio` is an ON/OFF switch, not a dial
The all-tap output was the UNK fallback (no ratio passed). Setting `hold_note_ratio` unlocks LNs, but
calibration (5K, ★5 fixed, seed fixed) shows the realized LN% does **not** track the value:

| `hold_note_ratio` | Realized LN% | Objects |
|---|---|---|
| 0.0 | **0%** (guaranteed pure rice) | 724 |
| 0.2 | 32% | 431 |
| 0.4 | 15% | 748 |
| 0.6 | 42% | 805 |

- `0.0` → **reliably 0% LN** (clean pure-rice switch). ✅
- Any value `>0` → LNs appear in a **~15–42%** band, but **non-monotonic** (0.2 gave more than 0.4). The number
  is not a controllable target.
- **Definition:** the training metric is `hold_note_count / total_note_count`, quantized to 10% buckets, used as
  a soft conditioning token — hence imprecise. `None` → UNK → all-tap prior.
- **High difficulty suppresses LNs** regardless of request: at ★8 the ~115ms note gaps leave no room to hold, so
  dense charts stay rice-heavy (arguably correct mapping).

### keycount=5 (your 5-lane game) is production-viable
| keycount | column balance | speed (★5, 82s) | LN behavior (unset) |
|---|---|---|---|
| 4K | even (24–26%) | 227s | 0–3% (needs `hold_note_ratio`) |
| **5K (your game)** | **even (18–22%)** | ~250–510s | erratic 17–50% |

5K balance is consistently even across all runs; the earlier ★5 skew (10/14/20/30/26) was a **one-off bad seed**,
not systematic. 5K is ~1.5–2× slower than 4K and slightly under-trained (less 5K data than 4K/7K), but usable.

### Recommended per-difficulty LN scheme (two-stage) — LN% DECREASES with difficulty

Design principle: **on easier levels a hold is *simpler* than a consecutive/multi-tap pattern** (press-and-hold
vs. coordinated bursts), and it also cuts note count. So Easy should be **LN-heavy**, Expert **rice-heavy**.
This is reinforced by physics: dense high-difficulty charts (~115ms gaps at ★8) have **no room to hold**, while
Easy's wide gaps leave plenty of room for long sustains. Both design and density push LN% the same direction.

Because the token can't hit a precise LN%, split **coarse enable (model)** + **precise amount (post-process)**:

| Tier | Star | `hold_note_ratio` (model) | Post-process target LN% | Why |
|---|---|---|---|---|
| **Easy** | ★2 | 0.4 (LNs on) | **~30% (cap 25–30%)** | holds replace hard tap bursts → forgiving |
| **Normal** | ★3.5 | 0.3 | ~20% | mixed rice + holds |
| **Hard** | ★5 | 0.3 | ~12% | more streams, fewer holds |
| **Expert** | ★7+ | 0.0–0.2 | ~5% | dense streams; holds don't fit (density cap) |

> LN cap: **30% is the ceiling** — above that a chart reads as an "LN-style" chart rather than a general one.
> Easy sits at the cap (25–30%); the rest ramp down.

- **Stage 1 (model):** `hold_note_ratio` high on Easy (enables plenty of holds), low/0 on Expert (pure rice).
  Since the token can't *guarantee* a high LN%, Easy relies on Stage 2 to reach target.
- **Stage 2 (audio post-process):** sustain-based pass (vocal-stem f0 / HPSS energy decay) converts sustained
  sections → holds to hit the exact per-tier target and snaps hold ends to actual note-off times. On Easy this is
  natural — low density means long sustains are available to turn into long notes.
- *Caveat:* LN **release timing** is its own beginner skill, so keep Easy holds long and on obvious sustained
  sounds (vocals/pads), not short quick releases.

---

**TL;DR:** Scales to ~45 full 3-difficulty song-sets/day per machine (**~32–33 min/song for E/N/H, ~12 min/song
for a single difficulty**), covers Easy→Hard (saturates >★5). Quality ~80% — solid rhythm/balance; the earlier
"all-tap" output was just an unset `hold_note_ratio` (fixable — see §6), though hitting a precise per-tier LN%
needs an audio post-process. Still needs a human polish pass (verify patterns, tune hard diffs).
Speed: on a like-for-like ~90–120s best-cut, AI is **~12–30× faster to a draft** than manual (~1–2 hrs/diff,
estimated) — and AI can also map the **full song** (~12 min/diff) which manual can't afford. Mania is slower
than standard; real speedup comes from GPU, not disabling positions.
