#!/usr/bin/env python3
"""Fix the timing of a generated .osu beatmap — Part 1 of the pipeline.

Mapperatorinator (v32-mini) sometimes emits a beatmap whose tempo is doubled
(e.g. 235 BPM for a ~117 BPM song) or whose timing points jitter. This rewrites
the [TimingPoints] section of a .osu and writes a corrected .osu, leaving the
hit objects and every other section byte-for-byte intact. The downstream
game-content converter (now in game_content_tools) consumes this clean .osu.

Fixes:
  * double_time : halve every uninherited BPM (beatLength * 2). SV points kept.
  * simplify    : cluster jittery uninherited points into stable sections.
  * auto        : apply double_time only when the tempo looks doubled —
                  if --ref-bpm given, when (BPM / 2) ≈ ref-bpm; else when
                  BPM > --dt-threshold (default 180). simplify is never auto.
  * none        : copy through unchanged.

Usage:
    python osu_timing.py IN.osu [-o OUT.osu] \
        [--fix auto|double_time|simplify|none] \
        [--ref-bpm 117] [--dt-threshold 180]

With no -o, writes <stem>_fixed.osu next to the input.
"""
import argparse
import os
import re
import statistics


# ─────────────────────────── PARSE ───────────────────────────

def read_osu(path):
    with open(path) as f:
        return f.read()


def parse_timing_block(content):
    """Return (header_match, body_str, list[dict]) for [TimingPoints].

    Each dict keeps every osu field so the block round-trips losslessly:
    time, beat_length, meter, sample_set, sample_index, volume, uninherited,
    effects.
    """
    m = re.search(r'\[TimingPoints\]\r?\n(.*?)(?=\r?\n\[)', content, re.DOTALL)
    if not m:
        return None, "", []
    body = m.group(1)
    points = []
    for line in body.splitlines():
        line = line.strip()
        if not line or not line[0].isdigit():
            continue
        p = line.split(',')
        # osu pads to 8 fields; older maps may have fewer.
        p += ['0'] * (8 - len(p))
        points.append({
            "time": float(p[0]),
            "beat_length": float(p[1]),
            "meter": int(p[2]),
            "sample_set": int(p[3]),
            "sample_index": int(p[4]),
            "volume": int(p[5]),
            "uninherited": int(p[6]),
            "effects": int(p[7]),
        })
    return m, body, points


def bpm_of(tp):
    return 60000.0 / tp["beat_length"] if tp["uninherited"] and tp["beat_length"] > 0 else None


def median_bpm(points):
    bpms = [bpm_of(tp) for tp in points]
    bpms = [b for b in bpms if b]
    return statistics.median(bpms) if bpms else None


# ─────────────────────────── FIXES ───────────────────────────

def fix_double_time(points):
    out = []
    for tp in points:
        tp = dict(tp)
        if tp["uninherited"] and tp["beat_length"] > 0:
            tp["beat_length"] *= 2.0
        out.append(tp)
    return out


def fix_simplify(points):
    """Cluster jittery uninherited points; keep inherited (SV) points as-is."""
    uninh = [tp for tp in points if tp["uninherited"] and tp["beat_length"] > 0]
    if not uninh:
        return [dict(tp) for tp in points]

    groups, cur = [], [uninh[0]]
    for prev, curr in zip(uninh, uninh[1:]):
        pb, cb = bpm_of(prev), bpm_of(curr)
        # new section only on a real gap AND a real tempo change
        if curr["time"] - prev["time"] > 5000 and abs(cb - pb) / pb > 0.15:
            groups.append(cur)
            cur = [curr]
        else:
            cur.append(curr)
    groups.append(cur)

    new_uninh = []
    for g in groups:
        avg_bpm = sum(bpm_of(tp) for tp in g) / len(g)
        head = g[0]
        new_uninh.append({
            "time": head["time"],
            "beat_length": 60000.0 / avg_bpm,
            "meter": head["meter"],
            "sample_set": head["sample_set"],
            "sample_index": head["sample_index"],
            "volume": head["volume"],
            "uninherited": 1,
            "effects": head["effects"],
        })

    inherited = [dict(tp) for tp in points if not tp["uninherited"]]
    merged = new_uninh + inherited
    merged.sort(key=lambda tp: (tp["time"], -tp["uninherited"]))
    return merged


def should_double_time(points, ref_bpm, dt_threshold):
    bpm = median_bpm(points)
    if bpm is None:
        return False, None
    if ref_bpm:
        # doubled iff halving lands within 8% of the reference tempo
        return abs((bpm / 2.0) - ref_bpm) / ref_bpm < 0.08, bpm
    return bpm > dt_threshold and (bpm / 2.0) >= 60.0, bpm


def resolve_fix(points, mode, ref_bpm, dt_threshold):
    """Return (fixed_points, applied_mode_label)."""
    if mode == "none":
        return [dict(tp) for tp in points], "none"
    if mode == "double_time":
        return fix_double_time(points), "double_time"
    if mode == "simplify":
        return fix_simplify(points), "simplify"
    # auto
    dt, bpm = should_double_time(points, ref_bpm, dt_threshold)
    if dt:
        return fix_double_time(points), "double_time (auto)"
    return [dict(tp) for tp in points], "none (auto)"


# ─────────────────────────── SERIALIZE ───────────────────────────

def fmt_num(x):
    """osu writes integers without a trailing .0; floats keep precision."""
    if x == int(x):
        return str(int(x))
    return repr(x)


def serialize_points(points):
    lines = []
    for tp in points:
        lines.append(",".join([
            fmt_num(tp["time"]),
            fmt_num(tp["beat_length"]),
            str(tp["meter"]),
            str(tp["sample_set"]),
            str(tp["sample_index"]),
            str(tp["volume"]),
            str(tp["uninherited"]),
            str(tp["effects"]),
        ]))
    return "\n".join(lines)


def rewrite_osu(content, match, new_body):
    """Replace the [TimingPoints] body (group 1) with new_body."""
    start, end = match.start(1), match.end(1)
    return content[:start] + new_body + content[end:]


# ─────────────────────── AUTO REF-BPM ───────────────────────

def ref_bpm_from_analysis(osu_path, audio_path=None):
    """Opportunistically read bpm from a sibling <audio>.analysis.json.

    Not a hard dependency — returns None if nothing is found. Lets `auto` use a
    reliable doubled-tempo signal when game_content_tools' analysis is present.
    """
    import glob
    import json
    candidates = []
    if audio_path:
        candidates.append(audio_path + ".analysis.json")
    d = os.path.dirname(os.path.abspath(osu_path))
    candidates += glob.glob(os.path.join(d, "*.analysis.json"))
    for c in candidates:
        if os.path.isfile(c):
            try:
                with open(c) as f:
                    bpm = json.load(f).get("bpm")
                if bpm:
                    return float(bpm), c
            except (ValueError, OSError):
                pass
    return None, None


# ─────────────────────────── MAIN ───────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="Fix timing of a generated .osu (writes a corrected .osu).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("input", help="path to the .osu file")
    ap.add_argument("-o", "--output", help="output .osu (default: <stem>_fixed.osu)")
    ap.add_argument("--fix", default="auto",
                    choices=["auto", "double_time", "simplify", "none"],
                    help="timing fix to apply (default: auto = double_time only if doubled)")
    ap.add_argument("--ref-bpm", type=float, default=None,
                    help="reference tempo for auto double-time detection "
                         "(default: read from a sibling <audio>.analysis.json if present)")
    ap.add_argument("--audio", help="audio path, used only to locate <audio>.analysis.json")
    ap.add_argument("--dt-threshold", type=float, default=180.0,
                    help="auto double-time BPM threshold when no ref-bpm (default: 180)")
    args = ap.parse_args()

    content = read_osu(args.input)
    match, _body, points = parse_timing_block(content)
    if match is None:
        raise SystemExit(f"no [TimingPoints] section in {args.input}")

    ref_bpm, ref_src = args.ref_bpm, None
    if ref_bpm is None and args.fix == "auto":
        ref_bpm, ref_src = ref_bpm_from_analysis(args.input, args.audio)

    fixed, applied = resolve_fix(points, args.fix, ref_bpm, args.dt_threshold)

    out_path = args.output
    if not out_path:
        stem, ext = os.path.splitext(args.input)
        out_path = f"{stem}_fixed{ext or '.osu'}"

    new_content = rewrite_osu(content, match, serialize_points(fixed))
    with open(out_path, "w") as f:
        f.write(new_content)

    before, after = median_bpm(points), median_bpm(fixed)
    ref_note = ""
    if ref_bpm:
        ref_note = f" | ref-bpm {ref_bpm:g}" + (f" ({os.path.basename(ref_src)})" if ref_src else "")
    print(f"timing fix: {applied} | BPM {before:.1f} -> {after:.1f}"
          f" | {len(points)} timing points{ref_note}")
    print(f"  -> {out_path}")


if __name__ == "__main__":
    main()
