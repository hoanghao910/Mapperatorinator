#!/usr/bin/env python3
"""Density-cap post-process for generated .osu maps (osu!standard or mania).

The model packs fine subdivisions (1/2, 1/4, 1/8) at higher `difficulty`, which
makes the derived 5-lane game charts far too busy — star rating is a poor proxy
for tap-game density. This pass enforces a target *notes-per-second* by removing
the least-important notes first:

    finest subdivision → coarsest, and off-beat before on-beat.

On-beat notes (the 1/1 pulse) and long notes / holds are never removed, so the
groove and structure survive; only the crowding (bursts, syncopation, 1/4
streams) is thinned. Within the last partial level, removal is spread evenly
(decimated by stride) rather than clustered, so density drops uniformly.

Usage:
    python osu_thin.py MAP.osu --target-nps 3.0 [-o OUT.osu]
    python osu_thin.py MAP.osu --difficulty 5.0            # tier → target nps
    python osu_thin.py MAP.osu --difficulty 5.0 --keep-accents
"""
import argparse
import sys

# ── per-difficulty density tier table ────────────────────────────────────────
# Target notes/s for a casual 5-lane tap game. Tune to taste; --target-nps
# overrides. Density rises with difficulty but stays far below raw osu output.
_TIERS = [
    # (max_star, name,     target_nps)   — "casual" profile, tuned 2026-07-03
    (2.5,  "Easy",   2.0),
    (4.0,  "Normal", 3.0),
    (5.5,  "Hard",   4.0),
    (99.0, "Expert", 5.0),
]


def tier_for(difficulty: float) -> dict:
    """Map a star rating to its density tier (name + target notes/s)."""
    for max_star, name, nps in _TIERS:
        if difficulty <= max_star:
            return {"name": name, "target_nps": nps}
    return {"name": "Expert", "target_nps": 5.0}


# ── .osu parsing helpers ─────────────────────────────────────────────────────
def _hitobject_span(lines):
    for i, ln in enumerate(lines):
        if ln.strip() == "[HitObjects]":
            return i + 1, len(lines)
    return None


def _timing_points(lines):
    """Return sorted [(time, beat_len)] for uninherited points (beat_len > 0)."""
    tps = []
    in_tp = False
    for ln in lines:
        s = ln.strip()
        if s == "[TimingPoints]":
            in_tp = True
            continue
        if in_tp:
            if s.startswith("["):
                break
            if not s:
                continue
            p = s.split(",")
            if len(p) >= 2:
                try:
                    t = float(p[0]); bl = float(p[1])
                except ValueError:
                    continue
                if bl > 0:  # uninherited
                    tps.append((t, bl))
    tps.sort()
    return tps or [(0.0, 500.0)]


def _grid_level(t, tps, tol=0.10):
    """Classify a note time by its beat-grid subdivision.

    0 = on-beat (1/1, never removed), 1 = 1/2, 2 = 1/4, 3 = 1/8 or triplet,
    4 = off-grid/other. Higher = finer = removed first.
    """
    tp_time, beat_len = tps[0]
    for tt, bl in tps:
        if tt <= t:
            tp_time, beat_len = tt, bl
        else:
            break
    ph = ((t - tp_time) / beat_len) % 1.0

    def near(fracs):
        return min(min(abs(ph - f), abs(ph - f + 1), abs(ph - f - 1)) for f in fracs)

    if near([0.0]) < tol:
        return 0
    if near([0.5]) < tol:
        return 1
    if near([0.25, 0.75]) < tol:
        return 2
    if near([1 / 3, 2 / 3, 0.125, 0.375, 0.625, 0.875]) < tol:
        return 3
    return 4


# ── the core pass ────────────────────────────────────────────────────────────
def apply_density_cap(osu_path, target_nps, out_path=None,
                      keep_accents=False, verbose=True) -> dict:
    """Thin notes to `target_nps`. Holds and on-beat notes are preserved."""
    with open(osu_path, encoding="utf-8", errors="ignore") as f:
        text = f.read()
    lines = text.splitlines()
    span = _hitobject_span(lines)
    if span is None:
        raise ValueError(f"no [HitObjects] section in {osu_path}")
    ho_start, ho_end = span
    tps = _timing_points(lines)

    objs = []
    for i in range(ho_start, ho_end):
        raw = lines[i]
        if not raw.strip():
            continue
        p = raw.split(",")
        if len(p) < 5:
            continue
        x = int(p[0]) if p[0].lstrip("-").isdigit() else 0
        t = int(p[2]); typ = int(p[3]); hs = int(p[4]) if p[4].isdigit() else 0
        is_hold = bool(typ & 128)
        is_slider = bool(typ & 2)
        objs.append({"line": i, "x": x, "t": t, "typ": typ,
                     "structural": is_hold or is_slider,   # never thin held notes
                     "accent": hs != 0, "pulse": False,
                     "level": _grid_level(t, tps)})

    # Protect one "pulse" note per on-beat onset (keeps the 1/1 groove). In mania
    # this lets on-beat CHORDS thin down to a single note, so dense multi-column
    # charts can actually reach a low target instead of flooring on the pulse.
    onsets = {}
    for o in objs:
        onsets.setdefault(o["t"], []).append(o)
    for group in onsets.values():
        onbeat = [g for g in group if g["level"] == 0 and not g["structural"]]
        if onbeat:
            min(onbeat, key=lambda g: g["x"])["pulse"] = True

    total = len(objs)
    if total == 0:
        raise ValueError("no hit objects")
    times = [o["t"] for o in objs]
    dur = (max(times) - min(times)) / 1000.0
    if dur <= 0:
        raise ValueError("zero-duration chart")
    nps = total / dur
    want = round(target_nps * dur)
    need = total - want

    if need <= 0:
        if verbose:
            print(f"[osu_thin] {total} notes / {dur:.0f}s = {nps:.2f} nps "
                  f"≤ target {target_nps:.1f} — no change")
        if out_path and out_path != osu_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(text)
        return {"total": total, "kept": total, "removed": 0,
                "nps_before": round(nps, 2), "nps_after": round(nps, 2),
                "target_nps": target_nps}

    # removable = not structural, not the protected on-beat pulse (and not
    # accented if keeping accents). On-beat chord *extras* stay removable.
    def removable(o):
        if o["structural"] or o["pulse"]:
            return False
        if keep_accents and o["accent"]:
            return False
        return True

    # bucket by removal priority: on-beat chord-extras ("0x") go LAST, after all
    # off-beat notes, so the groove is thinned only as a last resort.
    by_level = {}
    for o in objs:
        if removable(o):
            key = o["level"] if o["level"] > 0 else "0x"
            by_level.setdefault(key, []).append(o)

    to_remove = []
    # finest → coarsest: off-grid(4), 1/8·triplet(3), 1/4(2), 1/2(1), on-beat extras
    for lvl in (4, 3, 2, 1, "0x"):
        if need <= 0:
            break
        notes = sorted(by_level.get(lvl, []), key=lambda o: o["t"])
        if not notes:
            continue
        if len(notes) <= need:
            to_remove.extend(notes)
            need -= len(notes)
        else:
            # decimate evenly across this level so density drops uniformly
            stride = len(notes) / need
            idxs = sorted({int(k * stride) for k in range(need)})
            picked = [notes[i] for i in idxs][:need]
            to_remove.extend(picked)
            need = 0

    drop_lines = {o["line"] for o in to_remove}
    out_lines = [ln for i, ln in enumerate(lines) if i not in drop_lines]
    kept = total - len(to_remove)
    nps_after = kept / dur
    out = out_path or osu_path
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")
    if verbose:
        short = "  (floor: on-beat only)" if need > 0 else ""
        print(f"[osu_thin] total={total}  {nps:.2f}→{nps_after:.2f} nps "
              f"(target {target_nps:.1f})  removed={len(to_remove)}"
              f"{'  keep-accents' if keep_accents else ''}{short}")
    return {"total": total, "kept": kept, "removed": len(to_remove),
            "nps_before": round(nps, 2), "nps_after": round(nps_after, 2),
            "target_nps": target_nps}


def main():
    ap = argparse.ArgumentParser(description="osu! density-cap post-process")
    ap.add_argument("osu")
    ap.add_argument("-o", "--out", default=None, help="output .osu (default: overwrite)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--difficulty", type=float, help="star rating → tier target nps")
    g.add_argument("--target-nps", type=float, help="explicit notes-per-second ceiling")
    ap.add_argument("--keep-accents", action="store_true",
                    help="never remove hitsounded (accented) notes")
    args = ap.parse_args()

    if args.target_nps is not None:
        target = args.target_nps
    else:
        tier = tier_for(args.difficulty)
        target = tier["target_nps"]
        print(f"[osu_thin] ★{args.difficulty} → {tier['name']} tier, "
              f"target {target:.1f} nps")
    apply_density_cap(args.osu, target, out_path=args.out,
                      keep_accents=args.keep_accents)


if __name__ == "__main__":
    sys.exit(main())
