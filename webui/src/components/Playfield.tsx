import { useEffect, useRef } from 'react'
import { Beatmap, Finding } from '../types'
import { PLAYFIELD_W, PLAYFIELD_H, csRadius, arPreempt } from '../lib/osuMath'
import { sevColor } from '../lib/severity'

interface Props {
  beatmap: Beatmap
  findings: Finding[]
  timeMs: number
  selected: Finding | null
}

/** osu!standard playfield rendered at the current audio time, with finding markers. */
export default function Playfield({ beatmap, findings, timeMs, selected }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const ch = (cw * PLAYFIELD_H) / PLAYFIELD_W
    canvas.width = cw * dpr
    canvas.height = ch * dpr
    canvas.style.height = `${ch}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const scale = cw / PLAYFIELD_W
    const sx = (x: number) => x * scale
    const sy = (y: number) => y * scale
    const r = csRadius(beatmap.cs) * scale
    const preempt = arPreempt(beatmap.ar)

    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = '#0c0c0f'
    ctx.fillRect(0, 0, cw, ch)
    ctx.strokeStyle = '#26262e'
    ctx.lineWidth = 1
    ctx.strokeRect(0.5, 0.5, cw - 1, ch - 1)

    // Visible objects: appear `preempt` before, linger briefly after end.
    const visible = beatmap.hitObjects.filter(
      (o) => o.time - preempt <= timeMs && timeMs <= o.endTime + 150,
    )
    // Draw older first so upcoming objects sit on top.
    visible.sort((a, b) => b.time - a.time)

    for (const o of visible) {
      const fade = o.time > timeMs ? 1 : Math.max(0.25, 1 - (timeMs - o.endTime) / 200)
      ctx.globalAlpha = Math.min(1, fade)

      if (o.kind === 'slider' && o.points) {
        ctx.strokeStyle = '#3a6ea5'
        ctx.lineWidth = r * 1.7
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        ctx.beginPath()
        ctx.moveTo(sx(o.points[0].x), sy(o.points[0].y))
        for (const p of o.points.slice(1)) ctx.lineTo(sx(p.x), sy(p.y))
        ctx.stroke()
        ctx.strokeStyle = '#7fb2e5'
        ctx.lineWidth = r * 1.7 + 2
        // body outline
        ctx.globalAlpha = Math.min(0.5, fade)
        ctx.stroke()
        ctx.globalAlpha = Math.min(1, fade)
      }

      // Head / circle
      ctx.beginPath()
      ctx.arc(sx(o.x), sy(o.y), r, 0, Math.PI * 2)
      ctx.fillStyle = o.kind === 'spinner' ? '#2a2a33' : '#1d6fb8'
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = o.newCombo ? '#ff3b3f' : '#cfe3f7'
      ctx.stroke()

      // Approach circle (upcoming only)
      if (o.time > timeMs) {
        const t = (o.time - timeMs) / preempt // 1 -> 0
        const ar = r * (1 + 3 * t)
        ctx.globalAlpha = Math.min(1, 1 - t) * fade
        ctx.beginPath()
        ctx.arc(sx(o.x), sy(o.y), ar, 0, Math.PI * 2)
        ctx.strokeStyle = '#cfe3f7'
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }

    // Finding markers: those active near the current time, plus the selected one.
    const activeWindow = 400
    for (const f of findings) {
      if (f.x == null || f.y == null) continue
      const isSel = f === selected
      const near = Math.abs(f.time - timeMs) <= activeWindow
      if (!near && !isSel) continue
      const color = sevColor(f.importance)
      ctx.globalAlpha = isSel ? 1 : 0.85
      ctx.beginPath()
      ctx.arc(sx(f.x), sy(f.y), r + (isSel ? 10 : 6), 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth = isSel ? 4 : 2.5
      ctx.stroke()
      if (isSel) {
        ctx.beginPath()
        ctx.arc(sx(f.x), sy(f.y), r + 16, 0, Math.PI * 2)
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.4
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  }, [beatmap, findings, timeMs, selected])

  return <canvas ref={ref} className="playfield-canvas" />
}
