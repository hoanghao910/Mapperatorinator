#!/usr/bin/env python3
"""Stem-vs-full generation study driver.

For each song, submit generation jobs to the WARM Mapperatorinator API (:8771)
for the original audio + each Demucs stem (vocals/drums/bass/other), across the
E/N/H difficulty levels. Collect per-job wall-clock timing and quality, then
write a markdown report (produce-time + quality per source×level).

Using the warm API (not run_generate.sh) means the model loads once, so 30 jobs
don't pay 30 model reloads. The API already runs thin → LN → timing per job.

Requires: API up on :8771; stems separated under <study>/stems/htdemucs/<base>/.

    python stem_study.py submit    # enqueue all jobs, write jobs.json
    python stem_study.py poll      # poll until done, write results.json + report
    python stem_study.py report    # rebuild report.md from results.json
    python stem_study.py           # submit + poll + report
"""
import json
import os
import sys
import time
import urllib.request

API = os.environ.get("MAPP_API", "http://127.0.0.1:8771")
STUDY = "mapperatorinator-output/stem_study"

# E/N/H star values chosen to land in the Easy / Normal / Hard density+LN tiers.
LEVELS = [("E", 2.0), ("N", 3.5), ("H", 5.0)]
SOURCES = ["original", "vocals", "drums", "bass", "other"]
SONGS = [
    {"slug": "thapphonktudo", "orig": "/Users/haonguyen/Downloads/thapphonktudo.mp3"},
    {"slug": "cocongmaisac", "orig": "/Users/haonguyen/Downloads/CoCongMaiSac.mp3"},
]


def _api(path, data=None, timeout=20):
    url = API + path
    if data is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(
            url, data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def _stem_paths(song):
    base = os.path.splitext(os.path.basename(song["orig"]))[0]
    d = os.path.join(STUDY, "stems", "htdemucs", base)
    return {"original": song["orig"],
            "vocals": os.path.join(d, "vocals.mp3"),
            "drums": os.path.join(d, "drums.mp3"),
            "bass": os.path.join(d, "bass.mp3"),
            "other": os.path.join(d, "other.mp3")}


def cmd_submit():
    jobs = []
    for song in SONGS:
        srcmap = _stem_paths(song)
        for src in SOURCES:
            aud = srcmap[src]
            if not os.path.exists(aud):
                print(f"  SKIP {song['slug']}/{src}: missing {aud}")
                continue
            for lvl, diff in LEVELS:
                out = os.path.join(STUDY, "maps", song["slug"], f"{src}_{lvl}")
                r = _api("/jobs", {
                    "audio_path": os.path.abspath(aud),
                    "title": f"{song['slug']}_{src}_{lvl}",
                    "artist": "stem_study", "difficulty": diff,
                    "out_dir": os.path.abspath(out)})
                jobs.append({"id": r["id"], "song": song["slug"], "src": src,
                             "lvl": lvl, "diff": diff, "out": out})
                print(f"  queued {r['id']}  {song['slug']}/{src}/{lvl} (★{diff})")
    os.makedirs(STUDY, exist_ok=True)
    with open(os.path.join(STUDY, "jobs.json"), "w") as f:
        json.dump(jobs, f, indent=2)
    print(f"submitted {len(jobs)} jobs → {STUDY}/jobs.json")
    return jobs


def cmd_poll():
    with open(os.path.join(STUDY, "jobs.json")) as f:
        jobs = json.load(f)
    pending = {j["id"]: j for j in jobs}
    results = {}
    t0 = time.time()
    while pending:
        done_now = []
        for jid, j in list(pending.items()):
            try:
                st = _api(f"/jobs/{jid}")
            except Exception:
                continue
            if st["status"] in ("done", "error"):
                j["status"] = st["status"]
                j["created"] = st.get("created")
                j["started"] = st.get("started")
                j["finished"] = st.get("finished")
                j["error"] = (st.get("error") or "")[:400]
                j["result"] = st.get("result")
                results[jid] = j
                done_now.append(jid)
        for jid in done_now:
            pending.pop(jid)
        # checkpoint partial results so a mid-run report is possible
        with open(os.path.join(STUDY, "results.json"), "w") as f:
            json.dump(list(results.values()), f, indent=2)
        el = int(time.time() - t0)
        print(f"[{el}s] done={len(results)}/{len(jobs)} pending={len(pending)}", flush=True)
        if pending:
            time.sleep(20)
    print("all jobs terminal")
    return list(results.values())


def _osu_stats(path):
    if not path or not os.path.exists(path):
        return None
    mode = None
    times = []
    holds = 0
    sec = None
    for ln in open(path, encoding="utf-8", errors="ignore"):
        s = ln.strip()
        if s.startswith("Mode:"):
            mode = int(s.split(":")[1])
        if s.startswith("["):
            sec = s
            continue
        if sec == "[HitObjects]" and s:
            p = s.split(",")
            times.append(int(p[2]))
            if int(p[3]) & 128:
                holds += 1
    if not times:
        return None
    n = len(times)
    dur = (max(times) - min(times)) / 1000.0
    return {"mode": mode, "objs": n, "dur": round(dur, 1),
            "nps": round(n / dur, 2) if dur else 0,
            "ln_pct": round(100 * holds / n) if n else 0}


def cmd_report():
    with open(os.path.join(STUDY, "results.json")) as f:
        rows = json.load(f)
    by_song = {}
    for r in rows:
        by_song.setdefault(r["song"], []).append(r)

    out = ["# Stem-vs-Full Generation Study", ""]
    out.append(f"Pipeline: warm API (:8771) → mania 5K → osu_thin → mania_ln → timing fix.")
    out.append(f"Levels: E ★2.0 · N ★3.5 · H ★5.0. Sources: original + Demucs stems.")
    out.append("")
    grand_gen = []
    for song, rs in by_song.items():
        out.append(f"## {song}")
        out.append("")
        out.append("| source | lvl | status | gen s | queue s | mode | objs | nps | LN% |")
        out.append("|---|---|---|--:|--:|--:|--:|--:|--:|")
        order = {s: i for i, s in enumerate(SOURCES)}
        lorder = {"E": 0, "N": 1, "H": 2}
        for r in sorted(rs, key=lambda z: (order.get(z["src"], 9), lorder.get(z["lvl"], 9))):
            gen = q = ""
            if r.get("started") and r.get("finished"):
                gen = round(r["finished"] - r["started"], 1)
                grand_gen.append(gen)
            if r.get("created") and r.get("started"):
                q = round(r["started"] - r["created"], 1)
            res = r.get("result") or {}
            fixed = res.get("fixed_osu")
            st = _osu_stats(fixed) or {}
            out.append(f"| {r['src']} | {r['lvl']} | {r['status']} | {gen} | {q} | "
                       f"{st.get('mode','')} | {st.get('objs','')} | "
                       f"{st.get('nps','')} | {st.get('ln_pct','')}% |")
        out.append("")
    if grand_gen:
        tot = sum(grand_gen)
        out.append("## Produce time")
        out.append("")
        out.append(f"- jobs timed: **{len(grand_gen)}**")
        out.append(f"- total generation wall-clock: **{tot/60:.1f} min** "
                   f"({tot:.0f}s)")
        out.append(f"- mean per map: **{tot/len(grand_gen):.0f}s**  ·  "
                   f"min {min(grand_gen):.0f}s / max {max(grand_gen):.0f}s")
        out.append(f"- one song, 3 levels (original only): "
                   f"~**{3*tot/len(grand_gen)/60:.1f} min**")
        out.append("")
    path = os.path.join(STUDY, "report.md")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")
    print(f"report → {path}")
    print("\n".join(out))


def cmd_status():
    """Live snapshot: done/total, current job, mean time, ETA. Safe to run any
    time (reads results.json + queries the API; never touches the running job)."""
    jobs_path = os.path.join(STUDY, "jobs.json")
    res_path = os.path.join(STUDY, "results.json")
    total = len(json.load(open(jobs_path))) if os.path.exists(jobs_path) else 0
    rows = json.load(open(res_path)) if os.path.exists(res_path) else []
    done = [r for r in rows if r["status"] == "done"]
    err = [r for r in rows if r["status"] == "error"]
    gens = [r["finished"] - r["started"] for r in done
            if r.get("finished") and r.get("started")]
    mean = sum(gens) / len(gens) if gens else 312
    left = total - len(rows)
    try:
        q = _api("/health")["queue"]
    except Exception:
        q = "?"
    try:
        running = _api("/jobs?status=running&limit=1")
        cur = running[0]["title"] if running else "(none)"
    except Exception:
        cur = "(unavailable)"
    print(f"stem study — {len(rows)}/{total} terminal  (done {len(done)}, err {len(err)})")
    print(f"  API queue     : {q}")
    print(f"  running now   : {cur}")
    print(f"  mean gen/map  : {mean:.0f}s ({mean/60:.1f} min)")
    print(f"  est remaining : {left} left → ~{left*mean/60:.0f} min")
    if done:
        last = sorted(done, key=lambda z: z.get("finished") or 0)[-1]
        print(f"  last finished : {last['song']}/{last['src']}/{last['lvl']}")
    if err:
        print(f"  ERRORS        : " + ", ".join(f"{r['song']}/{r['src']}/{r['lvl']}" for r in err))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd == "status":
        cmd_status()
        return
    if cmd in ("submit", "all"):
        cmd_submit()
    if cmd in ("poll", "all"):
        cmd_poll()
    if cmd in ("report", "poll", "all"):
        cmd_report()


if __name__ == "__main__":
    main()
