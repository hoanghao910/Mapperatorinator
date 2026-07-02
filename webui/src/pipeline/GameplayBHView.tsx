import { useEffect, useRef, useState } from 'react'
import { FieldNote, Section } from './types'
import { LANE_COLORS } from '../lib/lanes'
import { sectionAt } from './util'

const BASE = '/fixtures/pipeline/'
const NLANES = 5

interface Props {
  notes: FieldNote[]
  sections: Section[] // clip-relative
  clipLen: number
}

/** 5-lane BH falling-note field synced to the clip audio. */
export default function GameplayBHView({ notes, sections, clipLen }: Props) {
  const cvRef = useRef<HTMLCanvasElement>(null)
  const audioRef = useRef<HTMLAudioElement>()
  const raf = useRef<number>()
  const [playing, setPlaying] = useState(false)
  const [tNow, setTNow] = useState(0)

  if (!audioRef.current) {
    const a = new Audio(BASE + 'clip_orig.mp3')
    a.preload = 'auto'
    audioRef.current = a
  }

  const draw = (t: number) => {
    const cv = cvRef.current
    if (!cv) return
    const ctx = cv.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    const W = cv.clientWidth
    const H = cv.clientHeight
    if (cv.width !== W * dpr || cv.height !== H * dpr) {
      cv.width = W * dpr
      cv.height = H * dpr
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    const lw = W / NLANES
    const hitY = H - 54
    const lookahead = 1.9
    const PPS = (hitY - 10) / lookahead
    const yOf = (nt: number) => hitY - (nt - t) * PPS

    // bg + section tint
    ctx.fillStyle = '#0b0b10'
    ctx.fillRect(0, 0, W, H)
    const sec = sectionAt(sections, t)
    if (sec) {
      ctx.globalAlpha = 0.14
      ctx.fillStyle = sec.color || '#64748b'
      ctx.fillRect(0, 0, W, H)
      ctx.globalAlpha = 1
    }
    // lanes
    for (let l = 0; l <= NLANES; l++) {
      ctx.strokeStyle = 'rgba(255,255,255,.07)'
      ctx.beginPath()
      ctx.moveTo(l * lw, 0)
      ctx.lineTo(l * lw, H)
      ctx.stroke()
    }
    // hit line
    ctx.strokeStyle = 'rgba(255,255,255,.5)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, hitY)
    ctx.lineTo(W, hitY)
    ctx.stroke()
    ctx.lineWidth = 1

    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      r = Math.min(r, w / 2, Math.abs(h) / 2)
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, r)
    }

    // notes
    for (const n of notes) {
      const ref = n.end ?? n.t
      if (ref < t - 0.25 || n.t > t + lookahead + 0.1) continue
      const cx = (n.lane - 0.5) * lw
      const y = yOf(n.t)
      const fade = t > ref ? Math.max(0, 1 - (t - ref) / 0.18) : 1
      if (fade <= 0) continue
      ctx.globalAlpha = fade
      if (n.end != null) {
        const y2 = yOf(n.end)
        ctx.fillStyle = 'rgba(20,184,166,.6)'
        rr(cx - 16, Math.min(y, y2), 32, Math.max(8, Math.abs(y2 - y)), 8)
        ctx.fill()
      }
      const w = n.strong ? 40 : 34
      if (n.strong) {
        ctx.shadowColor = '#f59e0b'
        ctx.shadowBlur = 18
        ctx.fillStyle = '#f59e0b'
      } else {
        ctx.shadowBlur = 0
        ctx.fillStyle = LANE_COLORS[n.lane - 1]
      }
      rr(cx - w / 2, y - 13, w, 26, 7)
      ctx.fill()
      ctx.shadowBlur = 0
      ctx.globalAlpha = 1
    }

    // hit flash (age-based so it survives pause/seek)
    for (const n of notes) {
      const age = t - n.t
      if (age < 0 || age > 0.26) continue
      const k = 1 - age / 0.26
      const cx = (n.lane - 0.5) * lw
      const col = n.strong ? '#fbbf24' : '#a5b4fc'
      ctx.globalAlpha = k * 0.85
      ctx.lineWidth = 3
      ctx.strokeStyle = col
      ctx.beginPath()
      ctx.arc(cx, hitY, 10 + (1 - k) * 26, 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineWidth = 1
      ctx.globalAlpha = 1
    }
  }

  const loop = () => {
    const a = audioRef.current!
    const t = a.currentTime
    setTNow(t)
    draw(t)
    if (!a.paused && !a.ended) raf.current = requestAnimationFrame(loop)
    else setPlaying(false)
  }

  const toggle = () => {
    const a = audioRef.current!
    if (a.paused) { a.play(); setPlaying(true); raf.current = requestAnimationFrame(loop) }
    else { a.pause(); setPlaying(false); if (raf.current) cancelAnimationFrame(raf.current) }
  }
  const restart = () => {
    const a = audioRef.current!
    a.currentTime = 0
    setTNow(0)
    draw(0)
  }

  useEffect(() => {
    draw(0)
    const a = audioRef.current!
    const onEnd = () => { a.currentTime = 0; setPlaying(false); setTNow(0); draw(0) }
    a.addEventListener('ended', onEnd)
    return () => {
      a.removeEventListener('ended', onEnd)
      a.pause()
      if (raf.current) cancelAnimationFrame(raf.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes])

  const sec = sectionAt(sections, tNow)
  return (
    <div className="gameplay">
      <div className="field-wrap">
        <canvas ref={cvRef} className="bh-field" />
      </div>
      <div className="gameplay-side">
        <div className="transport">
          <button className="play" onClick={toggle}>{playing ? '❚❚' : '▶'}</button>
          <button onClick={restart}>⏮</button>
          <span className="clock">{tNow.toFixed(1)}s</span>
        </div>
        <div className="gp-stats">
          <div><b>{sec?.label ?? '—'}</b><span>section</span></div>
          <div><b>{notes.length}</b><span>tiles</span></div>
          <div><b>{notes.filter((n) => n.strong).length}</b><span>strong</span></div>
        </div>
        <div className="gp-legend">
          <span><i style={{ background: LANE_COLORS[0] }} />tap (5 lanes)</span>
          <span><i style={{ background: '#f59e0b' }} />strong (drum accent)</span>
          <span><i style={{ background: '#14b8a6' }} />long hold</span>
        </div>
        <p className="muted small">BH (Tiles-Hop) 5-lane chart, sliced to the {clipLen}s clip — gold tiles are accent-driven strong notes.</p>
      </div>
    </div>
  )
}
