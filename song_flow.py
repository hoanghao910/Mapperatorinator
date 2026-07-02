#!/usr/bin/env python3
"""song_flow — cut, time-trim and merge Mapperatorinator song maps into one file.

Single, dependency-free (stdlib-only) tool that wraps the full editing flow:

    1. CUT + JOIN   pick time segments of a map (from a timing JSON or given
                    explicitly) and splice them back-to-back into one continuous
                    timeline — the same parts you cut/concat in the audio.
    2. TIME TRIM    drop a whole number of leading bars (bpm-based), shifting the
                    rest of the timeline to start at 0. Keeps map and audio in sync.
    3. MERGE        fuse several difficulties (easy -> normal -> hard ...) into ONE
                    file, switching difficulty at chosen points with either a hard
                    cut or a smooth one-segment density CROSSFADE.

It works on both BH and MT3 format JSON (same note schema: each note has a
`time` plus a list of `controls`, each with its own `time`). Times are seconds.

Drop this file into any project — it imports nothing outside the standard
library. ffmpeg is only shelled out to by the optional `audio` subcommand.

--------------------------------------------------------------------------------
SUBCOMMANDS
--------------------------------------------------------------------------------

  cut     Cut+join one map by segments, optionally trimming leading bars.

            song_flow.py cut MAP.json --timing timing.json --trim-bars 1 -o OUT.json
            song_flow.py cut MAP.json --segments 0:14 14:40 90:120 -o OUT.json

  merge   Merge ordered difficulty files (low -> high) into one map.

            song_flow.py merge -o OUT.json easy.json normal.json hard.json \
                --at 60.96 --at 95.0 --crossfade-bars 8 --bpm 87

  flow    The whole pipeline in one shot: cut+join+trim every difficulty by a
          timing JSON, then merge them with crossfades at the segment seams.

            song_flow.py flow -o OUT.json --timing timing.json --trim-bars 1 \
                --diff easy.json --diff normal.json --after-segment 3 --crossfade-segment

  audio   Print (or --run) the matching ffmpeg command so the MP3 stays in sync
          with a `cut`/`flow` edit (same segments + same bar trim).

            song_flow.py audio IN.mp3 --timing timing.json --trim-bars 1 -o OUT.mp3 --run

  selftest  Run built-in invariant checks on synthetic data (no files needed).

--------------------------------------------------------------------------------
HOW THE PIECES BEHAVE
--------------------------------------------------------------------------------

Cut:    a note is kept if its START time falls inside a segment. Segments play
        back-to-back with no gaps (segment k+1 starts where segment k ended), so
        you can also REORDER parts, not just trim. Hold/slider control times that
        run past a segment end are clamped to that boundary.

Trim:   `--trim-bars N` removes N*beats_per_bar*(60/bpm) seconds from the front.
        Notes starting before the cut are dropped; everything else shifts earlier.

Merge:  between difficulty i and i+1 there is a transition at time `at[i]`. With a
        crossfade window [at, at+len) the lower difficulty fades out and the higher
        fades in by a deterministic per-note hash: keep LOWER note when h(t) >= p,
        HIGHER note when h(t) < p, where p = (t-at)/len. Same hash basis for both
        sides => notes on identical times never double up. len=0 is a hard cut.
"""
import argparse
import json
import os
import subprocess
import sys


# ───────────────────────────── shared helpers ─────────────────────────────

PHI = 0.6180339887498949  # golden-ratio conjugate — good low-discrepancy hash


def crossfade_hash(t):
    """Deterministic value in [0,1) used to decide which side of a crossfade a
    note falls on. Stable across runs and identical for equal times in both
    difficulties, so coincident notes resolve to exactly one source."""
    return (t * PHI) % 1.0


def load_json(path):
    with open(path) as f:
        return json.load(f)


def dump_json(data, path):
    with open(path, "w") as f:
        json.dump(data, f, indent=1)


def set_audio_duration(out, seconds):
    """Mirror the cut/merge length into songMeta.audioDuration when present."""
    if isinstance(out.get("songMeta"), dict) and "audioDuration" in out["songMeta"]:
        out["songMeta"] = {**out["songMeta"], "audioDuration": seconds}


def bar_seconds(bars, bpm, beats_per_bar):
    """Length in seconds of `bars` bars at the given tempo."""
    return bars * beats_per_bar * 60.0 / bpm


def parse_segment(tok):
    """'START:END' or 'START-END' (seconds) -> (start, end) float pair."""
    sep = ":" if ":" in tok else "-"
    try:
        a, b = tok.split(sep)
        start, end = float(a), float(b)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"bad segment {tok!r}; expected START:END in seconds, e.g. 19.4:50"
        )
    if end <= start:
        raise argparse.ArgumentTypeError(f"segment {tok!r}: end must be > start")
    return (start, end)


def segments_from_timing(timing):
    """Pull (start, end) source segments out of a *_timing.json arrangement."""
    segs = timing.get("segments")
    if not segs:
        raise ValueError("timing JSON has no 'segments' list")
    out = []
    for s in segs:
        start, end = float(s["start"]), float(s["end"])
        if end <= start:
            raise ValueError(f"timing segment end<=start: {s}")
        out.append((start, end))
    return out


# ─────────────────────────────── cut + join ───────────────────────────────

def shift_note(note, start, end, offset):
    """Copy of `note` moved into the joined timeline: new = (t - start) + offset.
    Control times are clamped to `end` so holds can't stick past the cut."""
    n = dict(note)
    n["time"] = (note["time"] - start) + offset
    new_controls = []
    for c in note.get("controls", []):
        nc = dict(c)
        ct = min(c["time"], end)
        nc["time"] = (ct - start) + offset
        new_controls.append(nc)
    n["controls"] = new_controls
    return n


def cut_join(data, segments, trim_seconds=0.0):
    """Cut `segments` from `data` and join them back-to-back, then drop the first
    `trim_seconds` of the joined timeline. Returns (new_data, total_seconds)."""
    out = dict(data)
    joined = []
    offset = 0.0
    for start, end in segments:
        for note in data.get("notes", []):
            t = note.get("time")
            if t is None or t < start or t > end:
                continue
            joined.append(shift_note(note, start, end, offset))
        offset += end - start

    if trim_seconds:
        trimmed = []
        for n in joined:
            if n["time"] < trim_seconds:
                continue  # note starts inside the removed lead-in
            n = dict(n)
            n["time"] -= trim_seconds
            n["controls"] = [{**c, "time": max(0.0, c["time"] - trim_seconds)}
                             for c in n.get("controls", [])]
            trimmed.append(n)
        joined = trimmed

    joined.sort(key=lambda n: (n["time"], n.get("lane", 0)))
    out["notes"] = joined

    total = sum(e - s for s, e in segments) - trim_seconds
    set_audio_duration(out, total)
    return out, total


# ───────────────────────────────── merge ──────────────────────────────────

def merge_difficulties(diffs, ats, cf_lengths):
    """Merge difficulty maps (ordered low->high) into one.

    diffs       list of loaded map dicts, length N.
    ats         transition times, length N-1: ats[i] switches diff i -> i+1.
    cf_lengths  crossfade window length per transition, length N-1 (0 = hard cut).

    Returns (merged_dict, stats) where stats[d] = {full, fade_in, fade_out}.
    """
    n = len(diffs)
    if n < 2:
        raise ValueError("merge needs at least 2 difficulties")
    if len(ats) != n - 1 or len(cf_lengths) != n - 1:
        raise ValueError("need exactly N-1 transition points and crossfade lengths")
    if any(ats[i] >= ats[i + 1] for i in range(len(ats) - 1)):
        raise ValueError("transition points must be strictly increasing")

    # window[j] = [start, end) crossfade between diff j and j+1
    windows = [(ats[j], ats[j] + cf_lengths[j]) for j in range(n - 1)]
    INF = float("inf")

    merged = []
    stats = [{"full": 0, "fade_in": 0, "fade_out": 0} for _ in range(n)]

    for d, data in enumerate(diffs):
        own_lo = windows[d - 1][1] if d > 0 else -INF   # full from prev window end
        own_hi = windows[d][0] if d < n - 1 else INF     # full until next window start
        for note in data.get("notes", []):
            t = note.get("time")
            if t is None:
                continue
            if own_lo <= t < own_hi:
                merged.append(note); stats[d]["full"] += 1
            elif d > 0 and windows[d - 1][0] <= t < windows[d - 1][1]:
                ws, we = windows[d - 1]
                p = (t - ws) / (we - ws) if we > ws else 1.0
                if crossfade_hash(t) < p:               # higher side fades IN
                    merged.append(note); stats[d]["fade_in"] += 1
            elif d < n - 1 and windows[d][0] <= t < windows[d][1]:
                ws, we = windows[d]
                p = (t - ws) / (we - ws) if we > ws else 1.0
                if crossfade_hash(t) >= p:              # lower side fades OUT
                    merged.append(note); stats[d]["fade_out"] += 1

    merged.sort(key=lambda x: (x["time"], x.get("lane", 0)))
    out = dict(diffs[-1])  # base on the highest difficulty (fullest schema/meta)
    out["notes"] = merged

    end = max((x["time"] for x in merged), default=0.0)
    set_audio_duration(out, max(
        end, *[diff.get("songMeta", {}).get("audioDuration", 0) for diff in diffs]
    ))
    return out, stats


# ──────────────────────────── subcommand bodies ───────────────────────────

def resolve_segments(args):
    if args.timing:
        return segments_from_timing(load_json(args.timing))
    if args.segments:
        return args.segments
    raise SystemExit("error: give --timing TIMING.json or --segments START:END ...")


def resolve_tempo(args, timing=None):
    """bpm / beats_per_bar from CLI, falling back to the timing JSON."""
    bpm = args.bpm
    bpb = args.beats_per_bar
    if timing:
        bpm = bpm or timing.get("bpm")
        bpb = bpb or timing.get("beats_per_bar")
    return bpm, (bpb or 4)


def cmd_cut(args):
    timing = load_json(args.timing) if args.timing else None
    segments = segments_from_timing(timing) if timing else args.segments
    if not segments:
        raise SystemExit("error: give --timing TIMING.json or --segments START:END ...")

    trim = 0.0
    if args.trim_bars:
        bpm, bpb = resolve_tempo(args, timing)
        if not bpm:
            raise SystemExit("error: --trim-bars needs --bpm (or a timing JSON with bpm)")
        trim = bar_seconds(args.trim_bars, bpm, bpb)

    data = load_json(args.input)
    result, total = cut_join(data, segments, trim)

    out = args.output or _auto_name(args.input, segments, trim)
    dump_json(result, out)
    seglist = ", ".join(f"[{s:g},{e:g}]" for s, e in segments)
    print(f"Kept {len(result['notes'])}/{len(data.get('notes', []))} notes from "
          f"{len(segments)} segment(s) {seglist}"
          + (f", trimmed {trim:g}s" if trim else "")
          + f" -> 0..{total:g}s", file=sys.stderr)
    print(out)


def _auto_name(input_path, segments, trim):
    base, ext = os.path.splitext(input_path)
    tag = "_".join(f"{s:g}-{e:g}" for s, e in segments)
    suffix = f"_join_{tag}" + (f"_trim{trim:g}" if trim else "")
    return f"{base}{suffix}{ext}"


def cmd_merge(args):
    diffs = [load_json(p) for p in args.inputs]
    n = len(diffs)
    if len(args.at) != n - 1:
        raise SystemExit(f"error: {n} difficulties need {n-1} --at points, got {len(args.at)}")

    cf_lengths = _resolve_crossfade_lengths(args, n)
    result, stats = merge_difficulties(diffs, args.at, cf_lengths)

    dump_json(result, args.output)
    for d, (path, st) in enumerate(zip(args.inputs, stats)):
        print(f"  [{d}] {os.path.basename(path):40s} "
              f"full={st['full']:4d} fade_in={st['fade_in']:3d} fade_out={st['fade_out']:3d}",
              file=sys.stderr)
    print(f"Merged {n} difficulties -> {len(result['notes'])} notes "
          f"at {', '.join(f'{a:g}s' for a in args.at)}", file=sys.stderr)
    print(args.output)


def _resolve_crossfade_lengths(args, n):
    """Crossfade window length for each of the N-1 transitions."""
    if args.hard:
        return [0.0] * (n - 1)
    if args.crossfade_seconds is not None:
        return [args.crossfade_seconds] * (n - 1)
    if args.crossfade_bars is not None:
        if not args.bpm:
            raise SystemExit("error: --crossfade-bars needs --bpm")
        return [bar_seconds(args.crossfade_bars, args.bpm, args.beats_per_bar or 4)] * (n - 1)
    return [0.0] * (n - 1)  # default: hard cut


def cmd_flow(args):
    """End-to-end: cut+join+trim each --diff by the timing, then merge at seams."""
    timing = load_json(args.timing)
    segments = segments_from_timing(timing)
    bpm, bpb = resolve_tempo(args, timing)

    trim = 0.0
    if args.trim_bars:
        if not bpm:
            raise SystemExit("error: --trim-bars needs --bpm (or timing bpm)")
        trim = bar_seconds(args.trim_bars, bpm, bpb)

    # cumulative joined boundaries (after trim) at each segment seam
    cum, acc = [], 0.0
    for s, e in segments:
        acc += e - s
        cum.append(acc - trim)

    n = len(args.diff)
    if n < 2:
        raise SystemExit("error: flow needs >=2 --diff files to merge")
    if len(args.after_segment) != n - 1:
        raise SystemExit(f"error: {n} difficulties need {n-1} --after-segment values")

    ats = []
    for k in args.after_segment:
        if not (1 <= k < len(segments)):
            raise SystemExit(f"error: --after-segment {k} out of range 1..{len(segments)-1}")
        ats.append(cum[k - 1])  # seam after k segments = cumulative of first k

    # crossfade length per transition
    if args.crossfade_segment:
        cf_lengths = [segments[k][1] - segments[k][0] for k in args.after_segment]
    elif args.hard:
        cf_lengths = [0.0] * (n - 1)
    elif args.crossfade_bars is not None:
        cf_lengths = [bar_seconds(args.crossfade_bars, bpm, bpb)] * (n - 1)
    elif args.crossfade_seconds is not None:
        cf_lengths = [args.crossfade_seconds] * (n - 1)
    else:
        cf_lengths = [0.0] * (n - 1)

    cut_maps = []
    for path in args.diff:
        cut_map, _ = cut_join(load_json(path), segments, trim)
        cut_maps.append(cut_map)

    result, stats = merge_difficulties(cut_maps, ats, cf_lengths)
    dump_json(result, args.output)

    print(f"flow: {len(segments)} segments, trim {trim:g}s, "
          f"transitions at {', '.join(f'{a:g}s' for a in ats)} "
          f"(crossfade {', '.join(f'{c:g}s' for c in cf_lengths)})", file=sys.stderr)
    for d, (path, st) in enumerate(zip(args.diff, stats)):
        print(f"  [{d}] {os.path.basename(path):40s} "
              f"full={st['full']:4d} fade_in={st['fade_in']:3d} fade_out={st['fade_out']:3d}",
              file=sys.stderr)
    print(f"-> {len(result['notes'])} notes", file=sys.stderr)
    print(args.output)


def cmd_audio(args):
    timing = load_json(args.timing) if args.timing else None
    segments = segments_from_timing(timing) if timing else args.segments
    if not segments:
        raise SystemExit("error: give --timing TIMING.json or --segments START:END ...")

    trim = 0.0
    if args.trim_bars:
        bpm, bpb = resolve_tempo(args, timing)
        if not bpm:
            raise SystemExit("error: --trim-bars needs --bpm (or timing bpm)")
        trim = bar_seconds(args.trim_bars, bpm, bpb)

    labels = [chr(ord("a") + i) for i in range(len(segments))]
    parts = [f"[0]atrim={s:g}:{e:g},asetpts=N/SR/TB[{labels[i]}]"
             for i, (s, e) in enumerate(segments)]
    concat_in = "".join(f"[{l}]" for l in labels)
    chain = "; ".join(parts) + f"; {concat_in}concat=n={len(segments)}:v=0:a=1"
    if trim:
        chain += f"[j]; [j]atrim={trim:g},asetpts=N/SR/TB[out]"
        out_map = "[out]"
    else:
        chain += "[out]"
        out_map = "[out]"
    cmd = ["ffmpeg", "-y", "-i", args.input,
           "-filter_complex", chain, "-map", out_map, args.output]

    if args.run:
        print(" ".join(_shquote(c) for c in cmd), file=sys.stderr)
        subprocess.run(cmd, check=True)
        print(args.output)
    else:
        print(" ".join(_shquote(c) for c in cmd))


def _shquote(s):
    return s if all(c.isalnum() or c in "._:-/=" for c in s) else "'" + s.replace("'", "'\\''") + "'"


def cmd_selftest(_args):
    """Synthetic invariant checks — no external files needed."""
    failures = []

    def check(name, cond):
        print(("ok  " if cond else "FAIL") + "  " + name)
        if not cond:
            failures.append(name)

    # build a tiny map: 1 note per 0.5s from 0..10
    notes = [{"type": "short", "time": round(i * 0.5, 3), "lane": 1, "controls": []}
             for i in range(21)]
    data = {"format": "BH", "notes": notes,
            "songMeta": {"audioDuration": 10.0}}

    # cut+join two segments [0,2] and [5,7] -> joined 0..4
    jdata, total = cut_join(data, [(0.0, 2.0), (5.0, 7.0)])
    joined = jdata["notes"]
    check("cut_join total length", abs(total - 4.0) < 1e-9)
    check("cut_join all times within [0,4]", all(0 <= n["time"] <= 4 + 1e-9 for n in joined))
    check("cut_join sorted", all(joined[i]["time"] <= joined[i+1]["time"]
                                 for i in range(len(joined) - 1)))
    check("cut_join audioDuration updated", jdata["songMeta"]["audioDuration"] == 4.0)

    # second segment ([5,7]) lands at joined time 2..4 (2.5,3,3.5,4 past the seam)
    seg2 = [n for n in joined if n["time"] > 2 + 1e-9]
    check("cut_join second segment shifted past offset 2", len(seg2) == 4)

    # trim 1 bar @ 120bpm/4 = 2.0s off a 0..10 single-segment cut
    tdata, ttotal = cut_join(data, [(0.0, 10.0)], trim_seconds=2.0)
    trimmed = tdata["notes"]
    check("trim total length", abs(ttotal - 8.0) < 1e-9)
    check("trim drops early notes", all(n["time"] >= -1e-9 for n in trimmed))
    check("trim shifts start to 0", abs(min(n["time"] for n in trimmed)) < 1e-9)

    # bar_seconds sanity: 1 bar, 120 bpm, 4 beats = 2.0s
    check("bar_seconds 1bar@120 = 2.0", abs(bar_seconds(1, 120, 4) - 2.0) < 1e-9)

    # merge two identical maps, hard cut at t=5 -> still 21 notes, no dup
    a = json.loads(json.dumps(data)); b = json.loads(json.dumps(data))
    merged, stats = merge_difficulties([a, b], [5.0], [0.0])
    check("hard-cut merge keeps every time once", len(merged["notes"]) == 21)
    times = [n["time"] for n in merged["notes"]]
    check("hard-cut merge no duplicate times", len(times) == len(set(times)))
    check("hard-cut lower owns t<5", stats[0]["full"] == 10)
    check("hard-cut higher owns t>=5", stats[1]["full"] == 11)

    # crossfade merge: every time still represented exactly once (mutual exclusivity)
    mc, _ = merge_difficulties(
        [json.loads(json.dumps(data)), json.loads(json.dumps(data))], [4.0], [2.0])
    tc = [n["time"] for n in mc["notes"]]
    check("crossfade no duplicate times (identical maps)", len(tc) == len(set(tc)))
    check("crossfade keeps all (identical maps -> partition)", len(tc) == 21)

    # crossfade boundary: p=0 at window start keeps lower (h>=0 always true)
    check("crossfade hash in [0,1)", 0 <= crossfade_hash(3.14159) < 1)

    print()
    if failures:
        print(f"{len(failures)} FAILED: {failures}", file=sys.stderr)
        return 1
    print("all self-tests passed")
    return 0


# ─────────────────────────────────── CLI ──────────────────────────────────

def build_parser():
    p = argparse.ArgumentParser(
        prog="song_flow.py",
        description="Cut, time-trim and merge Mapperatorinator song maps.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("SUBCOMMANDS")[0].rstrip(),
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("cut", help="cut+join one map by segments, optionally trim bars")
    c.add_argument("input", help="input map JSON (BH or MT3)")
    c.add_argument("--timing", help="timing JSON defining the segments")
    c.add_argument("--segments", nargs="+", type=parse_segment, metavar="START:END",
                   help="explicit segments in seconds, joined in order")
    c.add_argument("--trim-bars", type=float, default=0, help="leading bars to drop")
    c.add_argument("--bpm", type=float, help="tempo for --trim-bars (else from timing)")
    c.add_argument("--beats-per-bar", type=int, help="beats per bar (default 4 / timing)")
    c.add_argument("-o", "--output", help="output path (auto-named if omitted)")
    c.set_defaults(func=cmd_cut)

    m = sub.add_parser("merge", help="merge ordered difficulties (low->high) into one")
    m.add_argument("inputs", nargs="+", help="difficulty JSONs, easiest first")
    m.add_argument("--at", type=float, action="append", default=[], metavar="SEC",
                   help="transition time (give N-1 for N difficulties)")
    m.add_argument("--crossfade-bars", type=float, help="crossfade window in bars")
    m.add_argument("--crossfade-seconds", type=float, help="crossfade window in seconds")
    m.add_argument("--bpm", type=float, help="tempo for --crossfade-bars")
    m.add_argument("--beats-per-bar", type=int, help="beats per bar (default 4)")
    m.add_argument("--hard", action="store_true", help="hard cut, no crossfade")
    m.add_argument("-o", "--output", required=True, help="merged output path")
    m.set_defaults(func=cmd_merge)

    f = sub.add_parser("flow", help="cut+trim every difficulty by timing, then merge")
    f.add_argument("--timing", required=True, help="timing JSON (segments + bpm)")
    f.add_argument("--diff", action="append", default=[], required=True,
                   help="a difficulty map, easiest first (repeat)")
    f.add_argument("--after-segment", type=int, action="append", default=[], metavar="K",
                   help="transition after K segments (give N-1 for N difficulties)")
    f.add_argument("--trim-bars", type=float, default=0, help="leading bars to drop")
    f.add_argument("--bpm", type=float, help="tempo override (else from timing)")
    f.add_argument("--beats-per-bar", type=int, help="beats per bar override")
    f.add_argument("--crossfade-segment", action="store_true",
                   help="crossfade across the segment following each seam")
    f.add_argument("--crossfade-bars", type=float, help="crossfade window in bars")
    f.add_argument("--crossfade-seconds", type=float, help="crossfade window in seconds")
    f.add_argument("--hard", action="store_true", help="hard cut, no crossfade")
    f.add_argument("-o", "--output", required=True, help="merged output path")
    f.set_defaults(func=cmd_flow)

    a = sub.add_parser("audio", help="emit/run the matching ffmpeg cut for the MP3")
    a.add_argument("input", help="input audio file")
    a.add_argument("--timing", help="timing JSON defining the segments")
    a.add_argument("--segments", nargs="+", type=parse_segment, metavar="START:END")
    a.add_argument("--trim-bars", type=float, default=0, help="leading bars to drop")
    a.add_argument("--bpm", type=float, help="tempo for --trim-bars (else from timing)")
    a.add_argument("--beats-per-bar", type=int, help="beats per bar (default 4 / timing)")
    a.add_argument("-o", "--output", required=True, help="output audio path")
    a.add_argument("--run", action="store_true", help="run ffmpeg instead of just printing")
    a.set_defaults(func=cmd_audio)

    s = sub.add_parser("selftest", help="run built-in invariant checks")
    s.set_defaults(func=cmd_selftest)

    return p


def main():
    args = build_parser().parse_args()
    rc = args.func(args)
    sys.exit(rc or 0)


if __name__ == "__main__":
    main()
