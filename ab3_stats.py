#!/usr/bin/env python3
"""Per-.osu stats + cross-model rhythm agreement for the A/B benchmark."""
import sys, glob, os, re

def parse(path):
    tp, ho = [], []
    sec = None
    for ln in open(path, encoding='utf-8', errors='ignore'):
        s = ln.strip()
        if s.startswith('['):
            sec = s; continue
        if not s: continue
        if sec == '[TimingPoints]':
            tp.append(s)
        elif sec == '[HitObjects]':
            ho.append(s)
    return tp, ho

def stats(path):
    tp, ho = parse(path)
    circles = sliders = spinners = combos = 0
    times = []
    for h in ho:
        p = h.split(',')
        if len(p) < 4: continue
        t = int(p[2]); typ = int(p[3])
        times.append(t / 1000.0)
        if typ & 8: spinners += 1
        elif typ & 2: sliders += 1
        elif typ & 1: circles += 1
        if typ & 4: combos += 1
    uninh = sum(1 for x in tp if len(x.split(',')) >= 7 and x.split(',')[6] == '1')
    times.sort()
    gaps = [round((times[i+1]-times[i])*1000) for i in range(len(times)-1) if times[i+1] > times[i]]
    gaps.sort()
    span = (times[-1]-times[0]) if len(times) > 1 else 0
    nps = len(ho)/span if span else 0
    med_gap = gaps[len(gaps)//2] if gaps else 0
    return dict(objs=len(ho), circles=circles, sliders=sliders, spinners=spinners,
                combos=combos, tp=len(tp), uninh=uninh, span=round(span,1),
                nps=round(nps,2), min_gap=gaps[0] if gaps else 0, med_gap=med_gap,
                times=times)

def agree(a, b, tol=0.010):
    """fraction of a-onsets matched by a b-onset within tol."""
    if not a or not b: return 0.0
    bs = sorted(b); m = 0
    import bisect
    for t in a:
        i = bisect.bisect_left(bs, t)
        ok = False
        for j in (i-1, i):
            if 0 <= j < len(bs) and abs(bs[j]-t) <= tol: ok = True; break
        if ok: m += 1
    return m/len(a)

OUT = '/tmp/ab3'
TRACKS = ['give', 'beat', 'smooth']
TLABEL = {'give':'Give In To Me', 'beat':'Beat It', 'smooth':'Smooth Criminal'}

def find_osu(cfg, key):
    g = glob.glob(f'{OUT}/{cfg}/{key}/*.osu')
    return g[0] if g else None

timings = {}
if os.path.exists(f'{OUT}/timings.tsv'):
    for ln in open(f'{OUT}/timings.tsv'):
        p = ln.strip().split('\t')
        if len(p) >= 3: timings[(p[0], p[1])] = int(p[2])

for key in TRACKS:
    print(f'\n========== {TLABEL[key]} ==========')
    mp = find_osu('v32-mini', key); fp = find_osu('v32', key)
    if not mp or not fp:
        print(f'  missing: mini={mp} full={fp}'); continue
    ms = stats(mp); fs = stats(fp)
    tm = timings.get(('v32-mini', key)); tf = timings.get(('v32', key))
    print(f'  speed:   mini {tm}s   full {tf}s   ({tf/tm:.2f}x slower)' if tm and tf else '  speed: n/a')
    fields = [('objs','objects'),('circles','circles'),('sliders','sliders'),
              ('spinners','spinners'),('combos','new combos'),('uninh','red lines'),
              ('nps','notes/sec'),('med_gap','median gap ms')]
    print(f'  {"metric":<14}{"mini":>8}{"v32":>8}')
    for k,lbl in fields:
        print(f'  {lbl:<14}{ms[k]:>8}{fs[k]:>8}')
    am = agree(ms['times'], fs['times']); af = agree(fs['times'], ms['times'])
    print(f'  rhythm:  {am*100:.0f}% of mini onsets match v32; {af*100:.0f}% of v32 match mini')
