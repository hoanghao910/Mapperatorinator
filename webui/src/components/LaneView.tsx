import { useEffect, useMemo, useRef } from 'react'
import { Beatmap, Finding, HitObject } from '../types'
import { LANE_COUNT, LANE_COLORS, laneOf } from '../lib/lanes'
import { sevColor } from '../lib/severity'

interface Props {
  beatmap: Beatmap
  findings: Finding[]
  timeMs: number
  selected: Finding | null
  lookahead: number // ms of chart visible above the judgment line
  onSeek: (ms: number) => void
  onSelect: (f: Finding) => void
}

/** Vertical falling-note view: notes scroll down 5 lanes to a judgment line. */
export default function LaneView({ beatmap, findings, timeMs, selected, lookahead, onSeek, onSelect }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  // Keep geometry in a ref so the click handler maps coords identically to the draw.
  const geo = useRef({ cw: 0, ch: 0, judgmentY: 0, topY: 0 })

  // mai_mod's finding.x is unreliable, but finding.time matches a real hit object.
  // Link each positional finding to its hit object so the overlay sits on the
  // correct note (and uses that note's lane), not the finding's raw x.
  const findingObj = useMemo(() => {
    const m = new Map<Finding, HitObject>()
    for (const f of findings) {
      if (f.x == null) continue
      const tref = f.timestamp_time ?? f.time
      let best: HitObject | null = null
      let bd = Infinity
      for (const o of beatmap.hitObjects) {
        const d = Math.abs(o.time - tref)
        if (d < bd) { bd = d; best = o }
      }
      if (best && bd <= 60) m.set(f, best)
    }
    return m
  }, [beatmap, findings])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = canvas.clientHeight
    canvas.width = cw * dpr
    canvas.height = ch * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const laneW = cw / LANE_COUNT
    const judgmentY = ch * 0.84
    const topY = 8
    geo.current = { cw, ch, judgmentY, topY }

    // time -> y: hit time sits on the judgment line; future is higher up.
    const yOf = (t: number) => judgmentY - ((t - timeMs) / lookahead) * (judgmentY - topY)
    const laneCenter = (lane: number) => lane * laneW + laneW / 2
    const noteW = laneW * 0.72

    ctx.clearRect(0, 0, cw, ch)

    // Lane backgrounds + separators.
    for (let i = 0; i < LANE_COUNT; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#101015' : '#0c0c10'
      ctx.fillRect(i * laneW, 0, laneW, ch)
    }
    ctx.strokeStyle = '#23232b'
    ctx.lineWidth = 1
    for (let i = 1; i < LANE_COUNT; i++) {
      ctx.beginPath()
      ctx.moveTo(i * laneW, 0)
      ctx.lineTo(i * laneW, ch)
      ctx.stroke()
    }

    const roundRect = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.min(r, w / 2, Math.abs(h) / 2)
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, rr)
    }

    // Visible objects.
    const lo = timeMs - 250
    const hi = timeMs + lookahead + 50
    const vis = beatmap.hitObjects.filter((o) => o.endTime >= lo && o.time <= hi)
    vis.sort((a, b) => a.time - b.time)

    for (const o of vis) {
      if (o.kind === 'spinner') {
        // Spinner spans all lanes.
        const yh = yOf(o.time)
        const yt = yOf(o.endTime)
        ctx.fillStyle = 'rgba(120,120,140,0.25)'
        roundRect(2, yt, cw - 4, yh - yt, 8)
        ctx.fill()
        continue
      }
      const lane = laneOf(o.x)
      const cx = laneCenter(lane)
      const color = LANE_COLORS[lane]
      const yHead = yOf(o.time)

      if (o.kind === 'slider') {
        // Hold note: bar from head (lower) up to tail (higher).
        const yTail = yOf(o.endTime)
        ctx.fillStyle = color + '55'
        roundRect(cx - noteW / 2, yTail, noteW, yHead - yTail, 7)
        ctx.fill()
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Head / tap block.
      const h = 16
      ctx.fillStyle = color
      roundRect(cx - noteW / 2, yHead - h / 2, noteW, h, 5)
      ctx.fill()
      if (o.newCombo) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 2
        ctx.stroke()
      }
    }

    // Findings overlay.
    for (const f of findings) {
      const obj = findingObj.get(f)
      const ft = obj ? obj.time : f.time // linked note's time (reliable)
      const near = ft >= lo && ft <= hi
      const isSel = f === selected
      if (!near && !isSel) continue
      const y = yOf(ft)
      const color = sevColor(f.importance)
      if (f.x != null) {
        const lane = obj ? laneOf(obj.x) : laneOf(f.x)
        const cx = laneCenter(lane)
        ctx.globalAlpha = isSel ? 1 : 0.9
        ctx.strokeStyle = color
        ctx.lineWidth = isSel ? 4 : 2.5
        roundRect(cx - noteW / 2 - 5, y - 14, noteW + 10, 28, 8)
        ctx.stroke()
        if (isSel) {
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(cx, y, 4, 0, Math.PI * 2)
          ctx.fill()
        }
        ctx.globalAlpha = 1
      } else {
        // Timing / non-positional finding: line across all lanes.
        ctx.strokeStyle = color
        ctx.globalAlpha = isSel ? 1 : 0.7
        ctx.lineWidth = isSel ? 3 : 1.5
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(cw, y)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }
    }

    // Judgment line.
    ctx.strokeStyle = '#ff3b3f'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, judgmentY)
    ctx.lineTo(cw, judgmentY)
    ctx.stroke()

    // Lane numbers under the judgment line.
    ctx.fillStyle = '#6a6a76'
    ctx.font = '11px Roboto, sans-serif'
    ctx.textAlign = 'center'
    for (let i = 0; i < LANE_COUNT; i++) {
      ctx.fillStyle = LANE_COLORS[i]
      ctx.globalAlpha = 0.7
      ctx.fillText(`${i + 1}`, laneCenter(i), judgmentY + 16)
      ctx.globalAlpha = 1
    }
  }, [beatmap, findings, timeMs, selected, lookahead])

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const { judgmentY, topY } = geo.current
    const y = e.clientY - rect.top
    const t = timeMs + ((judgmentY - y) / (judgmentY - topY)) * lookahead
    // Select nearest finding if the click is close (in time and lane), else seek.
    const x = e.clientX - rect.left
    const laneW = rect.width / LANE_COUNT
    const clickedLane = Math.floor(x / laneW)
    let best: Finding | null = null
    let bestDy = Infinity
    for (const f of findings) {
      const obj = findingObj.get(f)
      const ft = obj ? obj.time : f.time
      const fy = judgmentY - ((ft - timeMs) / lookahead) * (judgmentY - topY)
      const fLane = f.x == null ? clickedLane : obj ? laneOf(obj.x) : laneOf(f.x)
      const sameLane = fLane === clickedLane
      const dy = Math.abs(fy - y)
      if (sameLane && dy < bestDy) {
        bestDy = dy
        best = f
      }
    }
    if (best && bestDy <= 16) onSelect(best)
    else onSeek(Math.max(0, t))
  }

  return <canvas ref={ref} className="lane-canvas" onClick={onClick} />
}
