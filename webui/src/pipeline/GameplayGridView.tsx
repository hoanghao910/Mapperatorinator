import { useEffect, useRef, useState } from 'react'
import {
  Diffs, DiffNote, Level, LEVELS, LEVEL_LABEL, MapMatrix,
  Source, SOURCES, SOURCE_COLOR, SOURCE_LABEL,
} from './util'

const BASE = '/fixtures/pipeline/'
const NL = 5

export const AUDIO_SOURCES = SOURCES.map((k) => ({
  key: k, label: SOURCE_LABEL[k], src: BASE + `full_${k === 'orig' ? 'orig' : k}.mp3`,
}))

function drawField(cv: HTMLCanvasElement, notes: DiffNote[], t: number, color: string) {
  const ctx = cv.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth
  const H = cv.clientHeight
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  const lw = W / NL
  const hitY = H - 30
  const lookahead = 1.9
  const PPS = (hitY - 6) / lookahead
  const yOf = (nt: number) => hitY - (nt - t) * PPS

  ctx.fillStyle = '#0b0b10'
  ctx.fillRect(0, 0, W, H)
  for (let l = 0; l <= NL; l++) {
    ctx.strokeStyle = 'rgba(255,255,255,.07)'
    ctx.beginPath(); ctx.moveTo(l * lw, 0); ctx.lineTo(l * lw, H); ctx.stroke()
  }
  ctx.strokeStyle = 'rgba(255,255,255,.5)'
  ctx.lineWidth = 2
  ctx.beginPath(); ctx.moveTo(0, hitY); ctx.lineTo(W, hitY); ctx.stroke()
  ctx.lineWidth = 1

  for (const n of notes) {
    if (n.time < t - 0.25 || n.time > t + lookahead + 0.1) continue
    const cx = (n.lane - 0.5) * lw
    const y = yOf(n.time)
    const fade = t > n.time ? Math.max(0, 1 - (t - n.time) / 0.18) : 1
    if (fade <= 0) continue
    ctx.globalAlpha = fade
    const w = lw * 0.56
    if (n.strong) { ctx.shadowColor = '#f59e0b'; ctx.shadowBlur = 12; ctx.fillStyle = '#f59e0b' }
    else { ctx.shadowBlur = 0; ctx.fillStyle = color }
    ctx.beginPath(); ctx.roundRect(cx - w / 2, y - 8, w, 16, 5); ctx.fill()
    ctx.shadowBlur = 0; ctx.globalAlpha = 1
  }
}

const key = (s: Source, l: Level) => `${s}_${l}`

/** Compare grid: pick any source×level fields; all synced to one selectable audio. */
export default function GameplayGridView({ matrix, diffs, duration }: { matrix: MapMatrix; diffs: Diffs; duration: number }) {
  const [sources, setSources] = useState<Set<Source>>(new Set(['orig']))
  const [levels, setLevels] = useState<Set<Level>>(new Set(['E', 'N', 'H']))
  const [audioKey, setAudioKey] = useState<Source>('orig')
  const [playing, setPlaying] = useState(false)
  const [tNow, setTNow] = useState(0)
  const audioRef = useRef<HTMLAudioElement>()
  const canvases = useRef<Record<string, HTMLCanvasElement | null>>({})
  const raf = useRef<number>()

  if (!audioRef.current) {
    const a = new Audio(AUDIO_SOURCES[0].src); a.preload = 'auto'; audioRef.current = a
  }

  const notesFor = (s: Source, l: Level): DiffNote[] => matrix[s]?.[l] ?? (s === 'orig' ? diffs[l] : [])

  // ordered list of visible (source, level) fields
  const fields: { s: Source; l: Level }[] = []
  for (const s of SOURCES) if (sources.has(s)) for (const l of LEVELS) if (levels.has(l)) fields.push({ s, l })

  const redraw = (t: number) => {
    for (const f of fields) {
      const cv = canvases.current[key(f.s, f.l)]
      if (cv) drawField(cv, notesFor(f.s, f.l), t, SOURCE_COLOR[f.s])
    }
  }

  const loop = () => {
    const a = audioRef.current!
    setTNow(a.currentTime)
    redraw(a.currentTime)
    if (!a.paused && !a.ended) raf.current = requestAnimationFrame(loop)
    else setPlaying(false)
  }
  const toggle = () => {
    const a = audioRef.current!
    if (a.paused) { a.play(); setPlaying(true); raf.current = requestAnimationFrame(loop) }
    else { a.pause(); setPlaying(false); if (raf.current) cancelAnimationFrame(raf.current) }
  }
  const restart = () => seek(0)
  const seek = (t: number) => { const a = audioRef.current!; a.currentTime = Math.min(Math.max(0, t), duration); setTNow(a.currentTime); redraw(a.currentTime) }
  const pickAudio = (k: Source) => {
    const a = audioRef.current!
    const t = a.currentTime
    const wasPlaying = !a.paused
    setAudioKey(k)
    a.src = AUDIO_SOURCES.find((s) => s.key === k)!.src
    const onReady = () => { a.currentTime = t; if (wasPlaying) a.play(); a.removeEventListener('canplay', onReady) }
    a.addEventListener('canplay', onReady)
  }
  const toggleSet = <T,>(set: React.Dispatch<React.SetStateAction<Set<T>>>) => (v: T) =>
    set((s) => { const n = new Set(s); n.has(v) ? n.delete(v) : n.add(v); return n })

  useEffect(() => { redraw(audioRef.current!.currentTime) })
  useEffect(() => {
    const a = audioRef.current!
    const onEnd = () => { a.currentTime = 0; setPlaying(false); setTNow(0); redraw(0) }
    a.addEventListener('ended', onEnd)
    return () => { a.removeEventListener('ended', onEnd); a.pause(); if (raf.current) cancelAnimationFrame(raf.current) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="gp-grid-wrap">
      <div className="gp-toolbar">
        <button className="play" onClick={toggle}>{playing ? '❚❚' : '▶'}</button>
        <button onClick={restart}>⏮</button>
        <span className="clock">{tNow.toFixed(1)}s</span>
        <label className="gp-audio">
          audio
          <select value={audioKey} onChange={(e) => pickAudio(e.target.value as Source)}>
            {AUDIO_SOURCES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </label>
        <span className="gp-diff-pick">
          sources:
          {SOURCES.map((s) => (
            <button key={s} className={sources.has(s) ? 'on' : ''} style={sources.has(s) ? { background: SOURCE_COLOR[s], borderColor: SOURCE_COLOR[s], color: '#0a0a0a' } : {}} onClick={() => toggleSet(setSources)(s)}>
              {SOURCE_LABEL[s]}
            </button>
          ))}
        </span>
        <span className="gp-diff-pick">
          levels:
          {LEVELS.map((l) => (
            <button key={l} className={levels.has(l) ? 'on' : ''} onClick={() => toggleSet(setLevels)(l)}>{LEVEL_LABEL[l]}</button>
          ))}
        </span>
        <span className="muted small">{fields.length} fields · synced to 1 audio</span>
      </div>
      <div className="scroll-row" style={{ marginLeft: 0, marginBottom: 12 }}>
        <input type="range" min={0} max={duration} step={0.05} value={Math.min(tNow, duration)} onChange={(e) => seek(+e.target.value)} />
        <span className="muted small">{tNow.toFixed(1)} / {Math.round(duration)}s</span>
      </div>
      <div className="gp-grid wrap">
        {fields.map((f) => {
          const n = notesFor(f.s, f.l)
          return (
            <div className="gp-cell" key={key(f.s, f.l)}>
              <div className="gp-cell-head" style={{ color: SOURCE_COLOR[f.s] }}>
                {SOURCE_LABEL[f.s]} · {LEVEL_LABEL[f.l]} <span className="muted">{n.length}</span>
              </div>
              <div className="gp-cell-field">
                <canvas ref={(el) => (canvases.current[key(f.s, f.l)] = el)} />
              </div>
            </div>
          )
        })}
        {fields.length === 0 && <div className="placeholder">Pick sources and levels above.</div>}
      </div>
    </div>
  )
}
