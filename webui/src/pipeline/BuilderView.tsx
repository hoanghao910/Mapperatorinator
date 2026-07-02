import { useEffect, useMemo, useRef, useState } from 'react'
import {
  DiffNote, fmtSec, Level, LEVELS, LEVEL_LABEL, MapMatrix,
  Source, SOURCE_COLOR, SOURCE_LABEL,
} from './util'
import { AUDIO_SOURCES } from './GameplayGridView'

const NL = 5
const ZOOMS = [1, 2, 4, 8]
const ORIG_GREY = '#9aa3b2'
const STEMS: Source[] = ['drums', 'bass', 'vocals', 'other'] // priority order on ties
const TOL = 0.045 // s: coverage / dedup window

// Per-segment recipe: which stems play, and whether to backfill from the original.
interface SegCfg { sources: Source[]; fill: boolean }
interface Placed { time: number; lane: number; strong: boolean; src: Source }

const cloneCfg = (c: SegCfg): SegCfg => ({ sources: [...c.sources], fill: c.fill })

/** Build the manual combination: for each segment, union the chosen stems' notes,
 * then backfill original onsets the stems don't already cover. */
function buildSegment(
  matrix: MapMatrix, level: Level, cfg: SegCfg, lo: number, hi: number,
): Placed[] {
  const inRange = (n: DiffNote) => n.time >= lo && n.time < hi
  const cands: Placed[] = []
  for (const s of STEMS) {
    if (!cfg.sources.includes(s)) continue
    for (const n of matrix[s]?.[level] ?? []) if (inRange(n)) cands.push({ ...n, src: s })
  }
  if (cfg.fill) {
    for (const n of matrix.orig?.[level] ?? []) {
      if (!inRange(n)) continue
      // covered if a stem note already lands on this onset (any lane)
      if (cands.some((c) => Math.abs(c.time - n.time) <= TOL)) continue
      cands.push({ ...n, src: 'orig' })
    }
  }
  // dedup same lane + near-same time (layered stems overlapping) — keep priority src
  const prio = (s: Source) => (s === 'orig' ? 99 : STEMS.indexOf(s))
  cands.sort((a, b) => a.time - b.time || prio(a.src) - prio(b.src))
  const out: Placed[] = []
  for (const c of cands) {
    const dup = out.find((o) => o.lane === c.lane && Math.abs(o.time - c.time) <= TOL)
    if (!dup) out.push(c)
  }
  return out
}

function drawField(cv: HTMLCanvasElement, notes: Placed[], bounds: number[], t: number, vs: number, viewLen: number) {
  const ctx = cv.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = cv.clientHeight
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#101015'; ctx.fillRect(0, 0, W, H)
  const X = (tm: number) => ((tm - vs) / viewLen) * W
  for (let l = 1; l < NL; l++) {
    ctx.strokeStyle = 'rgba(255,255,255,.06)'
    ctx.beginPath(); ctx.moveTo(0, (l / NL) * H); ctx.lineTo(W, (l / NL) * H); ctx.stroke()
  }
  // segment seam markers
  for (const b of bounds) {
    const x = X(b)
    if (x <= 0 || x >= W) continue
    ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.setLineDash([])
  }
  const laneH = H / NL
  for (const n of notes) {
    const x = X(n.time)
    if (x < -1 || x > W + 1) continue
    const y = ((n.lane - 0.5) / NL) * H
    ctx.fillStyle = n.src === 'orig' ? ORIG_GREY : SOURCE_COLOR[n.src]
    ctx.globalAlpha = n.src === 'orig' ? 0.5 : 0.95
    ctx.fillRect(x - 1, y - laneH * 0.38, 2.4, laneH * 0.76)
  }
  ctx.globalAlpha = 1
  const px = X(t)
  if (px >= 0 && px <= W) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); ctx.lineWidth = 1
  }
}

function drawOrig(cv: HTMLCanvasElement, notes: DiffNote[], t: number, vs: number, viewLen: number) {
  const ctx = cv.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth, H = cv.clientHeight
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#0c0c11'; ctx.fillRect(0, 0, W, H)
  const X = (tm: number) => ((tm - vs) / viewLen) * W
  for (let l = 1; l < NL; l++) {
    ctx.strokeStyle = 'rgba(255,255,255,.05)'
    ctx.beginPath(); ctx.moveTo(0, (l / NL) * H); ctx.lineTo(W, (l / NL) * H); ctx.stroke()
  }
  const laneH = H / NL
  ctx.fillStyle = '#e2e8f0'
  for (const n of notes) {
    const x = X(n.time)
    if (x < -1 || x > W + 1) continue
    const y = ((n.lane - 0.5) / NL) * H
    ctx.fillRect(x - 1, y - laneH * 0.38, 2.4, laneH * 0.76)
  }
  const px = X(t)
  if (px >= 0 && px <= W) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); ctx.lineWidth = 1
  }
}

/** Manual combination builder: author per-range stem layering + original fill. */
export default function BuilderView({ matrix, duration }: { matrix: MapMatrix; duration: number }) {
  const [level, setLevel] = useState<Level>('N')
  const [audioKey, setAudioKey] = useState<Source>('orig')
  const [playing, setPlaying] = useState(false)
  const [tNow, setTNow] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const [follow, setFollow] = useState(true)

  // segment recipe: boundaries[] internal seams; cfgs[] one per segment (len = boundaries+1)
  const [boundaries, setBoundaries] = useState<number[]>([])
  const [cfgs, setCfgs] = useState<SegCfg[]>([{ sources: ['drums'], fill: true }])
  const [sel, setSel] = useState(0)

  const viewLen = duration / zoom
  const maxStart = Math.max(0, duration - viewLen)
  const vs = Math.min(Math.max(0, viewStart), maxStart)
  const toPct = (t: number) => ((t - vs) / viewLen) * 100
  const bounds = useMemo(() => [0, ...boundaries, duration], [boundaries, duration])

  // onset set for snapping seams (union of all sources at this level)
  const onsets = useMemo(() => {
    const set = new Set<number>()
    for (const s of ['orig', ...STEMS] as Source[])
      for (const n of matrix[s]?.[level] ?? []) set.add(Math.round(n.time * 1000))
    return Array.from(set).map((m) => m / 1000).sort((a, b) => a - b)
  }, [matrix, level])
  const snap = (t: number) => {
    const win = Math.max(0.04, viewLen * 0.01)
    let best = t, bd = win
    for (const o of onsets) { const d = Math.abs(o - t); if (d < bd) { bd = d; best = o } }
    return best
  }

  const origNotes = useMemo(() => matrix.orig?.[level] ?? [], [matrix, level])
  const built = useMemo(() => {
    const out: Placed[] = []
    cfgs.forEach((c, i) => out.push(...buildSegment(matrix, level, c, bounds[i], bounds[i + 1])))
    return out.sort((a, b) => a.time - b.time)
  }, [matrix, level, cfgs, bounds])
  const counts = useMemo(() => {
    const c: Record<string, number> = { orig: 0, vocals: 0, drums: 0, bass: 0, other: 0 }
    for (const n of built) c[n.src]++
    return c
  }, [built])

  const audioRef = useRef<HTMLAudioElement>()
  const cvRef = useRef<HTMLCanvasElement>(null)
  const origRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef<number>()
  const stripRef = useRef<HTMLDivElement>(null)
  const dragIdx = useRef<number | null>(null)
  const cfgRef = useRef({ vs, viewLen, maxStart, follow, bounds, built, origNotes })
  cfgRef.current = { vs, viewLen, maxStart, follow, bounds, built, origNotes }

  if (!audioRef.current) {
    const a = new Audio(AUDIO_SOURCES[0].src); a.preload = 'auto'; audioRef.current = a
  }

  const redraw = (t: number) => {
    const c = cfgRef.current
    if (origRef.current) drawOrig(origRef.current, c.origNotes, t, c.vs, c.viewLen)
    if (cvRef.current) drawField(cvRef.current, c.built, c.bounds, t, c.vs, c.viewLen)
  }
  const loop = () => {
    const a = audioRef.current!
    const t = a.currentTime
    setTNow(t)
    const c = cfgRef.current
    if (c.follow && c.viewLen < duration - 0.001) {
      const dv = Math.min(Math.max(0, t - c.viewLen * 0.4), c.maxStart)
      c.vs = dv; setViewStart(dv)
    }
    redraw(t)
    if (!a.paused && !a.ended) raf.current = requestAnimationFrame(loop); else setPlaying(false)
  }
  const toggle = () => {
    const a = audioRef.current!
    if (a.paused) { a.play(); setPlaying(true); raf.current = requestAnimationFrame(loop) }
    else { a.pause(); setPlaying(false); if (raf.current) cancelAnimationFrame(raf.current) }
  }
  const seek = (t: number) => {
    const a = audioRef.current!
    const nt = Math.min(Math.max(0, t), duration)
    a.currentTime = nt; setTNow(nt)
    const dv = Math.min(Math.max(0, nt - viewLen * 0.4), maxStart)
    cfgRef.current.vs = dv; setViewStart(dv); redraw(nt)
  }
  const pickAudio = (k: Source) => {
    const a = audioRef.current!
    const t = a.currentTime, wasPlaying = !a.paused
    setAudioKey(k)
    a.src = AUDIO_SOURCES.find((s) => s.key === k)!.src
    const onReady = () => { a.currentTime = t; if (wasPlaying) a.play(); a.removeEventListener('canplay', onReady) }
    a.addEventListener('canplay', onReady)
  }
  const changeZoom = (z: number) => {
    const center = vs + viewLen / 2, nl = duration / z
    setZoom(z); setViewStart(Math.min(Math.max(0, center - nl / 2), Math.max(0, duration - nl)))
  }

  // ── segment editing ──
  const segAt = (t: number) => { let i = 0; while (i < boundaries.length && boundaries[i] <= t) i++; return i }
  const splitAtPlayhead = () => {
    const t = snap(tNow)
    if (t <= 0.4 || t >= duration - 0.4) return
    if (boundaries.some((b) => Math.abs(b - t) < 0.4)) return
    const i = segAt(t)
    setBoundaries((p) => [...p, t].sort((a, b) => a - b))
    setCfgs((p) => { const n = [...p]; n.splice(i + 1, 0, cloneCfg(p[i])); return n })
    setSel(i)
  }
  const deleteSeg = () => {
    if (cfgs.length <= 1) return
    const i = sel
    setCfgs((p) => p.filter((_, k) => k !== i))
    setBoundaries((p) => p.filter((_, k) => k !== (i < p.length ? i : i - 1)))
    setSel(Math.max(0, i - (i >= boundaries.length ? 1 : 0)))
  }
  const setSegCfg = (i: number, fn: (c: SegCfg) => SegCfg) =>
    setCfgs((p) => p.map((c, k) => (k === i ? fn(c) : c)))
  const toggleSource = (s: Source) => setSegCfg(sel, (c) => ({
    ...c, sources: c.sources.includes(s) ? c.sources.filter((x) => x !== s) : [...c.sources, s],
  }))
  const toggleFill = () => setSegCfg(sel, (c) => ({ ...c, fill: !c.fill }))

  const onDown = (i: number) => (e: React.PointerEvent) => {
    dragIdx.current = i; (e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const i = dragIdx.current
    if (i == null || !stripRef.current) return
    const rect = stripRef.current.getBoundingClientRect()
    const t = snap(vs + ((e.clientX - rect.left) / rect.width) * viewLen)
    setBoundaries((prev) => {
      const lo = i > 0 ? prev[i - 1] + 0.3 : 0.3
      const hi = i < prev.length - 1 ? prev[i + 1] - 0.3 : duration - 0.3
      const next = [...prev]; next[i] = Math.max(lo, Math.min(hi, t)); return next
    })
  }
  const onUp = () => { dragIdx.current = null }

  const exportCombo = () => {
    const out = {
      format: 'mapperatorinator-combo',
      version: 1,
      level: LEVEL_LABEL[level],
      duration,
      segments: cfgs.map((c, i) => ({
        start: +bounds[i].toFixed(3),
        end: +bounds[i + 1].toFixed(3),
        sources: c.sources.map((s) => SOURCE_LABEL[s]),
        fillOriginal: c.fill,
      })),
      count: built.length,
      notes: built.map((n) => ({
        type: 'short', time: +n.time.toFixed(3), lane: n.lane,
        variant: n.strong ? 'strong' : '', source: SOURCE_LABEL[n.src],
      })),
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url; a.download = `beat_it_combo_${level}.json`; a.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => { redraw(tNow) })
  useEffect(() => () => { audioRef.current?.pause(); if (raf.current) cancelAnimationFrame(raf.current) }, [])

  const segG = (x0: number, x1: number) => {
    const l = Math.max(0, toPct(x0)), r = Math.min(100, toPct(x1))
    return { left: `${l}%`, width: `${Math.max(0, r - l)}%`, hidden: r <= 0 || l >= 100 }
  }
  const selCfg = cfgs[sel]

  return (
    <div className="combined">
      <div className="gp-toolbar">
        <button className="play" onClick={toggle}>{playing ? '❚❚' : '▶'}</button>
        <button onClick={() => seek(0)}>⏮</button>
        <span className="clock">{tNow.toFixed(1)}s</span>
        <label className="gp-audio">
          audio
          <select value={audioKey} onChange={(e) => pickAudio(e.target.value as Source)}>
            {AUDIO_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <span className="gp-diff-pick">
          level:
          {LEVELS.map((l) => (
            <button key={l} className={level === l ? 'on' : ''} onClick={() => setLevel(l)}>{LEVEL_LABEL[l]}</button>
          ))}
        </span>
        <div className="zoom-ctl">
          zoom{ZOOMS.map((z) => <button key={z} className={zoom === z ? 'on' : ''} onClick={() => changeZoom(z)}>{z}×</button>)}
        </div>
        <label className="bg-toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow playhead
        </label>
        <button className="pl-btn export-btn" onClick={exportCombo}>⬇ Export combo ({built.length})</button>
      </div>

      <div className="scroll-row" style={{ marginLeft: 0 }}>
        <input type="range" min={0} max={duration} step={0.05} value={Math.min(tNow, duration)} onChange={(e) => seek(+e.target.value)} />
        <span className="muted small">{tNow.toFixed(1)} / {Math.round(duration)}s{zoom > 1 ? ` · view ${vs.toFixed(0)}–${(vs + viewLen).toFixed(0)}s` : ''}</span>
      </div>

      <div className="combined-orig-head">
        <span className="muted small">Original ({LEVEL_LABEL[level]}) — your build below should line up with these</span>
      </div>
      <div className="combined-orig"><canvas ref={origRef} /></div>
      <div className="combined-field"><canvas ref={cvRef} /></div>

      {/* editable segment structure — click a band to select, drag seams (snap to onsets) */}
      <div className="stemrow merge-row" style={{ marginTop: 10 }}>
        <div className="stemname">
          <span className="dot" style={{ background: 'linear-gradient(90deg,#f59e0b,#6366f1,#ec4899)' }} />
          <span>Segments</span>
          <span className="stem-note">{cfgs.length} segs</span>
        </div>
        <div className="wavewrap merge-strip" ref={stripRef} onPointerMove={onMove} onPointerUp={onUp}>
          {cfgs.map((c, i) => {
            const g = segG(bounds[i], bounds[i + 1])
            if (g.hidden) return null
            const label = c.sources.length ? c.sources.map((s) => SOURCE_LABEL[s][0]).join('+') + (c.fill ? '+O' : '') : (c.fill ? 'Orig' : '∅')
            const col = c.sources.length ? SOURCE_COLOR[c.sources[0]] : ORIG_GREY
            return (
              <div key={i} className="seg" style={{ left: g.left, width: g.width, background: col, outline: i === sel ? '2px solid #fff' : 'none' }}
                onPointerDown={() => setSel(i)}>
                <span>{label}</span>
                <small>{fmtSec(bounds[i])}–{fmtSec(bounds[i + 1])}</small>
              </div>
            )
          })}
          {boundaries.map((b, i) => {
            const p = toPct(b)
            return p < 0 || p > 100 ? null : (
              <div key={i} className="seam" style={{ left: `${p}%` }} onPointerDown={onDown(i)}>
                <div className="seam-handle" />
                <span className="seam-t">{fmtSec(b)}</span>
              </div>
            )
          })}
        </div>
        <span className="muted small" style={{ textAlign: 'right' }}>drag = snap to onset</span>
      </div>

      {/* selected-segment inspector */}
      <div className="builder-inspect">
        <div className="seg-actions">
          <button onClick={splitAtPlayhead}>＋ Split at playhead</button>
          <button onClick={deleteSeg} disabled={cfgs.length <= 1}>🗑 Delete segment</button>
          <span className="muted small">segment {sel + 1}: {fmtSec(bounds[sel])}–{fmtSec(bounds[sel + 1])}</span>
        </div>
        <div className="seg-sources">
          <span className="muted small">stems in this segment:</span>
          {STEMS.map((s) => {
            const on = selCfg.sources.includes(s)
            return (
              <button key={s} className={on ? 'on' : ''}
                style={on ? { background: SOURCE_COLOR[s], borderColor: SOURCE_COLOR[s], color: '#0a0a0a' } : {}}
                onClick={() => toggleSource(s)}>{SOURCE_LABEL[s]}</button>
            )
          })}
          <label className="bg-toggle" style={{ marginLeft: 8 }}>
            <input type="checkbox" checked={selCfg.fill} onChange={toggleFill} />
            fill with original
          </label>
        </div>
      </div>

      <div className="combined-legend">
        <span className="muted small">built {built.length} notes:</span>
        {STEMS.map((s) => (
          <span className="leg-item" key={s}><i style={{ background: SOURCE_COLOR[s] }} />{SOURCE_LABEL[s]} <b>{counts[s]}</b></span>
        ))}
        <span className="leg-item"><i style={{ background: ORIG_GREY, opacity: 0.5 }} />orig-fill <b>{counts.orig}</b></span>
      </div>
    </div>
  )
}
