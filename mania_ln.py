#!/usr/bin/env python3
"""Deterministic long-note (LN) post-process for osu!mania maps.

The model's `hold_note_ratio` token is only an ON/OFF switch — it enables long
notes but can't hit a precise LN%. This pass sets the *exact* per-tier LN% by
converting the most-sustained tap notes into holds, using an audio sustain
signal (HPSS harmonic energy decay) so holds land on genuinely held sounds
(vocals / pads / synths), not transient hits.

Design (see BENCHMARK.md §6): LN% is highest on Easy (a hold is more forgiving
than a tap burst) and decreases with difficulty; dense high-★ charts have no
room to hold, so the target naturally shrinks.

Usage:
    python mania_ln.py MAP.osu --audio SONG.mp3 --difficulty 2.0 [-o OUT.osu]
    python mania_ln.py MAP.osu --audio SONG.mp3 --target 0.30
"""
import argparse
import sys

# ── per-difficulty tier table (BENCHMARK.md §6) ──────────────────────────────
# hold_note_ratio = coarse ON/OFF for the model; ln_target = exact LN fraction
# this post-process enforces. LN% decreases with difficulty; capped at 30%.
_TIERS = [
    # (max_star, name,     hold_note_ratio, ln_target)
    (2.5,  "Easy",   0.4, 0.30),
    (4.0,  "Normal", 0.3, 0.20),
    (5.5,  "Hard",   0.3, 0.12),
    (99.0, "Expert", 0.1, 0.05),
]


def tier_for(difficulty: float) -> dict:
    """Map a star rating to its LN tier settings."""
    for max_star, name, ratio, target in _TIERS:
        if difficulty <= max_star:
            return {"name": name, "hold_note_ratio": ratio, "ln_target": target}
    return {"name": "Expert", "hold_note_ratio": 0.1, "ln_target": 0.05}


# ── .osu parsing helpers ─────────────────────────────────────────────────────
def _split_sections(text: str):
    """Return (preamble_lines, hitobject_lines, section_order) preserving layout."""
    lines = text.splitlines()
    ho_start = ho_end = None
    for i, ln in enumerate(lines):
        if ln.strip() == "[HitObjects]":
            ho_start = i + 1
            break
    if ho_start is None:
        return lines, [], None
    ho_end = len(lines)
    return lines, (ho_start, ho_end), True


def _column(x: int, keycount: int) -> int:
    c = int(x * keycount / 512)
    return max(0, min(keycount - 1, c))


# ── the core pass ────────────────────────────────────────────────────────────
def apply_long_notes(osu_path: str, audio_path: str, target_ratio: float,
                     out_path: str = None, keycount: int = None,
                     min_hold_ms: int = 120, max_hold_ms: int = 1800,
                     end_gap_ms: int = 30, decay_frac: float = 0.4,
                     verbose: bool = True) -> dict:
    """Convert the most-sustained taps into holds to reach `target_ratio` LN%.

    Returns a summary dict. Writes to `out_path` (defaults to overwriting).
    """
    import numpy as np
    import librosa

    with open(osu_path, encoding="utf-8", errors="ignore") as f:
        text = f.read()
    lines, span, ok = _split_sections(text)
    if not ok:
        raise ValueError(f"no [HitObjects] section in {osu_path}")
    ho_start, ho_end = span

    # infer keycount from CircleSize if not given (mania: CS == keycount)
    if keycount is None:
        keycount = 4
        for ln in lines:
            if ln.startswith("CircleSize:"):
                keycount = int(float(ln.split(":", 1)[1]))
                break

    # parse hit objects
    objs = []  # dict per line: idx, x, time, typ, is_hold, col, raw fields
    for i in range(ho_start, ho_end):
        raw = lines[i]
        if not raw.strip():
            continue
        p = raw.split(",")
        if len(p) < 5:
            continue
        x, y, t, typ = int(p[0]), int(p[1]), int(p[2]), int(p[3])
        is_hold = bool(typ & 128)
        objs.append({"line": i, "x": x, "y": y, "t": t, "typ": typ,
                     "hs": p[4], "sample": p[5] if len(p) > 5 else "0:0:0:0:",
                     "is_hold": is_hold, "col": _column(x, keycount)})

    total = len(objs)
    if total == 0:
        raise ValueError("no hit objects")
    existing_holds = sum(1 for o in objs if o["is_hold"])
    want_holds = round(target_ratio * total)
    need = want_holds - existing_holds
    if need <= 0:
        if verbose:
            print(f"[mania_ln] already {existing_holds}/{total} "
                  f"({100*existing_holds/total:.0f}%) LN ≥ target "
                  f"{100*target_ratio:.0f}% — no change")
        if out_path and out_path != osu_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(text)
        return {"total": total, "ln_before": existing_holds,
                "ln_after": existing_holds, "converted": 0,
                "target": target_ratio, "keycount": keycount}

    # audio sustain signal: HPSS harmonic RMS envelope (sustained pitched content)
    y, sr = librosa.load(audio_path, sr=22050, mono=True)
    y_harm = librosa.effects.hpss(y)[0]
    hop = 256
    rms = librosa.feature.rms(y=y_harm, hop_length=hop)[0]
    rms_t = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)

    def frame_at(sec):
        return int(np.searchsorted(rms_t, sec))

    # next note time per column (for clamping hold ends)
    by_col = {}
    for o in sorted(objs, key=lambda z: z["t"]):
        by_col.setdefault(o["col"], []).append(o)
    next_in_col = {}
    for col, arr in by_col.items():
        for j, o in enumerate(arr):
            next_in_col[id(o)] = arr[j + 1]["t"] if j + 1 < len(arr) else None

    # measure sustain for each tap candidate
    cands = []
    for o in objs:
        if o["is_hold"]:
            continue
        t_sec = o["t"] / 1000.0
        f0 = frame_at(t_sec)
        if f0 >= len(rms):
            continue
        peak = max(rms[max(0, f0 - 1):f0 + 2].max(), 1e-6)
        thr = decay_frac * peak
        f = f0
        while f < len(rms) and rms[f] >= thr:
            f += 1
        sustain_sec = max(0.0, rms_t[min(f, len(rms) - 1)] - t_sec)
        sustain_ms = int(sustain_sec * 1000)
        # clamp by next note in column and max hold
        nxt = next_in_col.get(id(o))
        limit = max_hold_ms
        if nxt is not None:
            limit = min(limit, nxt - o["t"] - end_gap_ms)
        end_ms = o["t"] + min(sustain_ms, limit)
        hold_len = end_ms - o["t"]
        if hold_len >= min_hold_ms:
            cands.append((sustain_ms, o, end_ms))

    # pick the longest-sustained candidates up to `need`
    cands.sort(key=lambda z: z[0], reverse=True)
    chosen = cands[:need]
    for _sus, o, end_ms in chosen:
        new_typ = (o["typ"] & ~1) | 128           # circle bit off, hold bit on
        lines[o["line"]] = (f"{o['x']},{o['y']},{o['t']},{new_typ},"
                            f"{o['hs']},{end_ms}:{o['sample']}")

    converted = len(chosen)
    ln_after = existing_holds + converted
    out = out_path or osu_path
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    if verbose:
        print(f"[mania_ln] {keycount}K  total={total}  "
              f"LN {existing_holds}→{ln_after} ({100*ln_after/total:.0f}%, "
              f"target {100*target_ratio:.0f}%)  converted={converted}"
              f"{'  (candidate-limited)' if converted < need else ''}")
    return {"total": total, "ln_before": existing_holds, "ln_after": ln_after,
            "converted": converted, "target": target_ratio, "keycount": keycount}


def main():
    ap = argparse.ArgumentParser(description="osu!mania long-note post-process")
    ap.add_argument("osu")
    ap.add_argument("--audio", required=True)
    ap.add_argument("-o", "--out", default=None, help="output .osu (default: overwrite)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--difficulty", type=float, help="star rating → tier LN target")
    g.add_argument("--target", type=float, help="explicit LN fraction 0..1")
    ap.add_argument("--keycount", type=int, default=None)
    args = ap.parse_args()

    if args.target is not None:
        target = args.target
    else:
        tier = tier_for(args.difficulty)
        target = tier["ln_target"]
        print(f"[mania_ln] ★{args.difficulty} → {tier['name']} tier, "
              f"LN target {100*target:.0f}%")
    apply_long_notes(args.osu, args.audio, target, out_path=args.out,
                     keycount=args.keycount)


if __name__ == "__main__":
    sys.exit(main())
