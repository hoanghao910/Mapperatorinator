import { useEffect, useRef } from 'react'
import { Beatmap, Finding } from '../types'
import { sevColor } from '../lib/severity'

interface Props {
  beatmap: Beatmap
  findings: Finding[]
  timeMs: number
  selected: Finding | null
  onSeek: (ms: number) => void
  onSelect: (f: Finding) => void
}

const H = 88

/** Full-song timeline: object ticks (bottom), finding markers (colored), playhead. */
export default function Timeline({ beatmap, findings, timeMs, selected, onSeek, onSelect }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const dur = Math.max(1, beatmap.duration)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    canvas.width = cw * dpr
    canvas.height = H * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const X = (t: number) => (t / dur) * cw

    ctx.clearRect(0, 0, cw, H)
    ctx.fillStyle = '#121216'
    ctx.fillRect(0, 0, cw, H)

    // Object density ticks along the bottom.
    ctx.strokeStyle = '#2c2c36'
    ctx.lineWidth = 1
    for (const o of beatmap.hitObjects) {
      const x = X(o.time)
      ctx.beginPath()
      ctx.moveTo(x, H - 14)
      ctx.lineTo(x, H - 4)
      ctx.stroke()
    }

    // Finding markers: taller bar for higher importance.
    for (const f of findings) {
      const x = X(f.time)
      const h = 14 + Math.min(46, Math.log10(Math.max(1, f.importance)) * 26)
      ctx.strokeStyle = sevColor(f.importance)
      ctx.globalAlpha = f === selected ? 1 : 0.8
      ctx.lineWidth = f === selected ? 3 : 2
      ctx.beginPath()
      ctx.moveTo(x, H - 16)
      ctx.lineTo(x, H - 16 - h)
      ctx.stroke()
      if (f === selected) {
        ctx.beginPath()
        ctx.arc(x, H - 16 - h, 4, 0, Math.PI * 2)
        ctx.fillStyle = sevColor(f.importance)
        ctx.fill()
      }
      ctx.globalAlpha = 1
    }

    // Playhead.
    const px = X(timeMs)
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(px, 0)
    ctx.lineTo(px, H)
    ctx.stroke()
  }, [beatmap, findings, timeMs, selected, dur])

  // Click: select nearest finding if close, else seek.
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const t = (x / rect.width) * dur
    let best: Finding | null = null
    let bestDx = Infinity
    for (const f of findings) {
      const fx = (f.time / dur) * rect.width
      const dx = Math.abs(fx - x)
      if (dx < bestDx) {
        bestDx = dx
        best = f
      }
    }
    if (best && bestDx <= 6) onSelect(best)
    else onSeek(t)
  }

  return <canvas ref={ref} className="timeline-canvas" style={{ height: H }} onClick={onClick} />
}
