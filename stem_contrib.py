#!/usr/bin/env python3
"""Stem-contribution analysis: how much of the ORIGINAL map does each stem drive?

For a song+level, we have a map generated from the original audio and one from
each Demucs stem (drums/bass/vocals/other). For every note in the original map,
find the nearest note (in time) across the stem maps; attribute that note to the
stem whose map best explains it (within a tolerance), ties broken by a fixed
priority (drums > bass > vocals > other) — the same rule as the webui's
`combineByStem`. The result is a % contribution per stem: an approximate
decomposition of which instrument each part of the chart follows.

    python stem_contrib.py                 # all songs/levels under the study dir
    python stem_contrib.py --tol-ms 50     # match tolerance (default 60ms)

Writes <study>/contribution.json and prints a summary table. Reads the maps that
stem_study.py produced under <study>/maps/<song>/<source>_<level>/.
"""
import argparse
import glob
import json
import os

STUDY = "mapperatorinator-output/stem_study"
STEMS = ["drums", "bass", "vocals", "other"]   # priority order on ties
LEVELS = ["E", "N", "H"]


def _note_times(osu_path):
    """Sorted list of hit-object times (ms) from a .osu."""
    if not osu_path or not os.path.exists(osu_path):
        return None
    ts = []
    sec = None
    for ln in open(osu_path, encoding="utf-8", errors="ignore"):
        s = ln.strip()
        if s.startswith("["):
            sec = s
            continue
        if sec == "[HitObjects]" and s:
            p = s.split(",")
            if len(p) >= 3:
                ts.append(int(p[2]))
    return sorted(ts)


def _fixed_osu(song, src, lvl):
    d = os.path.join(STUDY, "maps", song, f"{src}_{lvl}")
    g = glob.glob(os.path.join(d, "*_fixed.osu"))
    return g[0] if g else None


def _nearest(ts, t):
    """Min |t - x| over sorted ts via binary search; inf if empty."""
    import bisect
    if not ts:
        return float("inf")
    i = bisect.bisect_left(ts, t)
    best = float("inf")
    for j in (i - 1, i):
        if 0 <= j < len(ts):
            best = min(best, abs(ts[j] - t))
    return best


def analyze_song_level(song, lvl, tol_ms):
    orig = _note_times(_fixed_osu(song, "original", lvl))
    if not orig:
        return None
    stem_ts = {s: _note_times(_fixed_osu(song, s, lvl)) for s in STEMS}
    stem_ts = {s: t for s, t in stem_ts.items() if t}
    if not stem_ts:
        return None
    counts = {s: 0 for s in STEMS}
    counts["none"] = 0
    attribution = []  # (time_ms, stem) — for a timeline / webui feed
    for t in orig:
        best_stem, best_d = None, tol_ms
        for s in STEMS:               # priority order — first within tol wins ties
            ts = stem_ts.get(s)
            if ts is None:
                continue
            d = _nearest(ts, t)
            if d < best_d:            # strictly closer; priority handles equal-ish
                best_d, best_stem = d, s
        key = best_stem or "none"
        counts[key] += 1
        attribution.append({"t": t, "stem": key})
    total = len(orig)
    pct = {s: round(100 * counts[s] / total) for s in counts}
    return {"song": song, "level": lvl, "orig_notes": total,
            "tol_ms": tol_ms, "stems_present": sorted(stem_ts.keys()),
            "counts": counts, "pct": pct, "attribution": attribution}


def main():
    ap = argparse.ArgumentParser(description="stem-contribution analysis")
    ap.add_argument("--tol-ms", type=int, default=60)
    args = ap.parse_args()

    songs = sorted({os.path.basename(p) for p in
                    glob.glob(os.path.join(STUDY, "maps", "*"))})
    results = []
    for song in songs:
        for lvl in LEVELS:
            r = analyze_song_level(song, lvl, args.tol_ms)
            if r:
                results.append(r)
    if not results:
        print("no analyzable song/level yet (need original + ≥1 stem map).")
        return
    out = os.path.join(STUDY, "contribution.json")
    with open(out, "w") as f:
        # drop the big attribution arrays from the on-disk summary's echo, keep in file
        json.dump(results, f, indent=2)

    print(f"# Stem contribution (tol {args.tol_ms}ms)  → {out}\n")
    hdr = f"{'song':14} {'lvl':3} {'notes':6} | " + " ".join(f"{s:>7}" for s in STEMS) + f" {'none':>7}"
    print(hdr)
    print("-" * len(hdr))
    for r in results:
        p = r["pct"]
        row = f"{r['song']:14} {r['level']:3} {r['orig_notes']:<6} | " + \
              " ".join(f"{p.get(s,0):>6}%" for s in STEMS) + f" {p.get('none',0):>6}%"
        print(row)


if __name__ == "__main__":
    main()
