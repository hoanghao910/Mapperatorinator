import { useEffect, useMemo, useRef, useState } from 'react'
import { Section } from './types'
import { Diffs } from './util'
import { fmtSec } from './util'

interface Props {
  diffs: Diffs
  sections: Section[]
  duration: number
  real: boolean // true once real generated charts are loaded
}

type Diff = 'E' | 'N' | 'H'
const DIFF_COL: Record<Diff, string> = { E: '#22c55e', N: '#6366f1', H: '#ef4444' }
const DIFF_NAME: Record<Diff, string> = { E: 'Easy', N: 'Normal', H: 'Hard' }
const ZOOMS = [1, 2, 4, 8]
const NL = 5 // BH play lanes (1 top → 5 bottom)

function drawLanes(ctx: CanvasRenderingContext2D, W: number, H: number) {
  ctx.strokeStyle = 'rgba(255,255,255,.06)'
  ctx.lineWidth = 1
  for (let l = 1; l < NL; l++) {
    const y = (l / NL) * H
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(W, y)
    ctx.stroke()
  }
}

function drawSectionBg(ctx: CanvasRenderingContext2D, sections: Section[], X: (t: number) => number, W: number, H: number) {
  for (const s of sections) {
    const x0 = Math.max(0, X(s.start))
    const x1 = Math.min(W, X(s.end))
    if (x1 <= x0) continue
    ctx.fillStyle = s.color || '#64748b'
    ctx.globalAlpha = 0.09
    ctx.fillRect(x0, 0, x1 - x0, H)
    ctx.globalAlpha = 1
  }
}

function snapInitialBoundaries(pattern: Diff[], sections: Section[], duration: number): number[] {
  const nb = pattern.length - 1
  if (nb <= 0) return []
  const starts = sections.map((s) => s.start).filter((t) => t > 0 && t < duration)
  const used = new Set<number>()
  const out: number[] = []
  for (let k = 1; k <= nb; k++) {
    const ideal = (duration * k) / (nb + 1)
    let best = ideal
    let bd = Infinity
    for (const c of starts) {
      if (!used.has(c) && Math.abs(c - ideal) < bd) { bd = Math.abs(c - ideal); best = c }
    }
    used.add(best)
    out.push(best)
  }
  return out.sort((a, b) => a - b)
}

export default function MergeView({ diffs, sections, duration, real }: Props) {
  const [patternStr, setPatternStr] = useState('E N H N E')
  const pattern = useMemo<Diff[]>(() => {
    const p = patternStr.toUpperCase().match(/[ENH]/g) as Diff[] | null
    return p && p.length ? p : ['E', 'N', 'H', 'N', 'E']
  }, [patternStr])

  const [boundaries, setBoundaries] = useState<number[]>(() =>
    snapInitialBoundaries(['E', 'N', 'H', 'N', 'E'], sections, duration),
  )
  useEffect(() => {
    setBoundaries((prev) =>
      prev.length === pattern.length - 1 ? prev : snapInitialBoundaries(pattern, sections, duration),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pattern.length])

  // ── zoom + scroll view window ──
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const viewLen = duration / zoom
  const maxStart = Math.max(0, duration - viewLen)
  const vs = Math.min(Math.max(0, viewStart), maxStart)
  const toPct = (t: number) => ((t - vs) / viewLen) * 100

  const changeZoom = (z: number) => {
    const center = vs + viewLen / 2
    const nl = duration / z
    setZoom(z)
    setViewStart(Math.min(Math.max(0, center - nl / 2), Math.max(0, duration - nl)))
  }

  const stripRef = useRef<HTMLDivElement>(null)
  const dragIdx = useRef<number | null>(null)
  const onDown = (i: number) => (e: React.PointerEvent) => {
    dragIdx.current = i
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const i = dragIdx.current
    if (i == null || !stripRef.current) return
    const rect = stripRef.current.getBoundingClientRect()
    let t = vs + ((e.clientX - rect.left) / rect.width) * viewLen
    for (const s of sections) {
      if (s.start > 0 && s.start < duration && Math.abs(s.start - t) < viewLen * 0.012) { t = s.start; break }
    }
    setBoundaries((prev) => {
      const lo = i > 0 ? prev[i - 1] + 0.5 : 0.5
      const hi = i < prev.length - 1 ? prev[i + 1] - 0.5 : duration - 0.5
      const next = [...prev]
      next[i] = Math.max(lo, Math.min(hi, t))
      return next
    })
  }
  const onUp = () => { dragIdx.current = null }

  const bounds = [0, ...boundaries, duration]

  // The actual merged chart: each segment contributes its difficulty's notes.
  const merged = useMemo(() => {
    const out: { time: number; lane: number; diff: Diff; strong: boolean }[] = []
    const b = [0, ...boundaries, duration]
    pattern.forEach((d, i) => {
      for (const n of diffs[d]) if (n.time >= b[i] && n.time < b[i + 1]) out.push({ time: n.time, lane: n.lane, diff: d, strong: n.strong })
    })
    return out.sort((a, c) => a.time - c.time)
  }, [diffs, pattern, boundaries, duration])

  // Export the merged chart: the recipe (pattern + segment ranges) + merged notes.
  const exportMerge = () => {
    const b = [0, ...boundaries, duration]
    const out = {
      format: 'mapperatorinator-merge',
      version: 1,
      duration,
      pattern: pattern.map((d) => DIFF_NAME[d]),
      segments: pattern.map((d, i) => ({
        difficulty: DIFF_NAME[d],
        start: +b[i].toFixed(3),
        end: +b[i + 1].toFixed(3),
      })),
      count: merged.length,
      notes: merged.map((m) => ({
        type: 'short',
        time: +m.time.toFixed(3),
        lane: m.lane,
        variant: m.strong ? 'strong' : '',
        source: DIFF_NAME[m.diff],
      })),
    }
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `beat_it_merge_${pattern.join('')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // difficulty density rows (canvas) — drawn within the view window
  const canvases = useRef<Record<Diff, HTMLCanvasElement | null>>({ E: null, N: null, H: null })
  const resultRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    ;(['E', 'N', 'H'] as Diff[]).forEach((d) => {
      const cv = canvases.current[d]
      if (!cv) return
      const ctx = cv.getContext('2d')!
      const dpr = window.devicePixelRatio || 1
      const W = cv.clientWidth
      const H = cv.clientHeight
      cv.width = W * dpr
      cv.height = H * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const X = (t: number) => ((t - vs) / viewLen) * W
      drawSectionBg(ctx, sections, X, W, H)
      drawLanes(ctx, W, H)
      const laneH = H / NL
      ctx.fillStyle = DIFF_COL[d]
      for (const n of diffs[d]) {
        const x = X(n.time)
        if (x < -1 || x > W + 1) continue
        const y = ((n.lane - 0.5) / NL) * H // lane 1 → top
        ctx.globalAlpha = n.strong ? 1 : 0.78
        ctx.fillRect(x, y - laneH * 0.36, 1.8, laneH * 0.72)
      }
      ctx.globalAlpha = 1
    })
  }, [diffs, sections, duration, vs, viewLen])

  // merge-result row: the combined chart, ticks colored by source difficulty
  useEffect(() => {
    const cv = resultRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const W = cv.clientWidth
    const H = cv.clientHeight
    cv.width = W * dpr
    cv.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, H)
    const X = (t: number) => ((t - vs) / viewLen) * W
    const b = [0, ...boundaries, duration]
    // faint tint bands showing which difficulty plays where
    pattern.forEach((d, i) => {
      const x0 = Math.max(0, X(b[i]))
      const x1 = Math.min(W, X(b[i + 1]))
      if (x1 <= x0) return
      ctx.fillStyle = DIFF_COL[d]
      ctx.globalAlpha = 0.08
      ctx.fillRect(x0, 0, x1 - x0, H)
      ctx.globalAlpha = 1
    })
    drawLanes(ctx, W, H)
    // merged notes in 5 lanes, colored by the difficulty they came from
    const laneH = H / NL
    for (const n of merged) {
      const x = X(n.time)
      if (x < -1 || x > W + 1) continue
      const y = ((n.lane - 0.5) / NL) * H
      ctx.fillStyle = DIFF_COL[n.diff]
      ctx.globalAlpha = n.strong ? 1 : 0.82
      ctx.fillRect(x, y - laneH * 0.36, 1.8, laneH * 0.72)
    }
    ctx.globalAlpha = 1
  }, [merged, pattern, boundaries, duration, vs, viewLen])

  const seg = (x0: number, x1: number) => {
    const l = Math.max(0, toPct(x0))
    const r = Math.min(100, toPct(x1))
    return { left: `${l}%`, width: `${Math.max(0, r - l)}%`, hidden: r <= 0 || l >= 100 }
  }

  return (
    <div className="merge">
      <div className="merge-controls">
        <label>
          Merge pattern
          <input value={patternStr} onChange={(e) => setPatternStr(e.target.value)} placeholder="E N H N E" spellCheck={false} />
        </label>
        <div className="zoom-ctl">
          zoom
          {ZOOMS.map((z) => (
            <button key={z} className={zoom === z ? 'on' : ''} onClick={() => changeZoom(z)}>{z}×</button>
          ))}
        </div>
        <button className="pl-btn export-btn" onClick={exportMerge}>⬇ Export merge ({merged.length})</button>
        <span className="muted small">{real ? 'real Easy/Normal/Hard charts' : 'derived difficulties (proxy)'} · drag seams to set ranges</span>
      </div>

      {zoom > 1 && (
        <div className="scroll-row">
          <input
            type="range"
            min={0}
            max={maxStart}
            step={duration / 1000}
            value={vs}
            onChange={(e) => setViewStart(+e.target.value)}
          />
          <span className="muted small">{fmtSec(vs)}–{fmtSec(vs + viewLen)}</span>
        </div>
      )}

      {(['E', 'N', 'H'] as Diff[]).map((d) => (
        <div className="stemrow" key={d}>
          <div className="stemname">
            <span className="dot" style={{ background: DIFF_COL[d] }} />
            <span>{DIFF_NAME[d]}</span>
            <span className="stem-note">{diffs[d].length} notes</span>
          </div>
          <div className="wavewrap">
            <canvas ref={(el) => (canvases.current[d] = el)} className="diff-strip" />
          </div>
          <span className="muted small" style={{ textAlign: 'right' }}>{d === 'E' ? 'sparse' : d === 'N' ? 'medium' : 'dense'}</span>
        </div>
      ))}

      {/* merge result — the actual combined chart */}
      <div className="stemrow result-row">
        <div className="stemname">
          <span className="dot" style={{ background: 'linear-gradient(90deg,#22c55e,#6366f1,#ef4444)' }} />
          <span>Merge Result</span>
          <span className="stem-note">{merged.length} notes</span>
        </div>
        <div className="wavewrap">
          <canvas ref={resultRef} className="diff-strip" />
        </div>
        <span className="muted small" style={{ textAlign: 'right' }}>combined chart</span>
      </div>

      {/* editable structure */}
      <div className="stemrow merge-row">
        <div className="stemname">
          <span className="dot" style={{ background: 'linear-gradient(90deg,#22c55e,#6366f1,#ef4444)' }} />
          <span>Structure</span>
          <span className="stem-note">{pattern.join('·')}</span>
        </div>
        <div className="wavewrap merge-strip" ref={stripRef} onPointerMove={onMove} onPointerUp={onUp}>
          {sections.map((s, i) => {
            const g = seg(s.start, s.end)
            return g.hidden ? null : (
              <div key={i} className="sec-band" style={{ left: g.left, width: g.width, background: s.color || '#64748b' }} title={s.label} />
            )
          })}
          {pattern.map((d, i) => {
            const g = seg(bounds[i], bounds[i + 1])
            return g.hidden ? null : (
              <div key={i} className="seg" style={{ left: g.left, width: g.width, background: DIFF_COL[d] }}>
                <span>{DIFF_NAME[d]}</span>
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
        <span className="muted small" style={{ textAlign: 'right' }}>{pattern.length} segs</span>
      </div>
    </div>
  )
}
