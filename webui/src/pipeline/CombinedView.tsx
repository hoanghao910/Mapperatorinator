import { useEffect, useMemo, useRef, useState } from 'react'
import {
  combineByStem, Level, LEVELS, LEVEL_LABEL, MapMatrix,
  Source, SOURCE_COLOR, SOURCE_LABEL,
} from './util'
import { AUDIO_SOURCES } from './GameplayGridView'
import BuilderView from './BuilderView'

const NL = 5
const ZOOMS = [1, 2, 4, 8]
const ORIG_GREY = '#9aa3b2'
const CONTRIB: Source[] = ['vocals', 'drums', 'bass', 'other']

interface Combo { note: { time: number; lane: number; strong: boolean }; src: Source }

function draw(cv: HTMLCanvasElement, combined: Combo[], t: number, vs: number, viewLen: number) {
  const ctx = cv.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth
  const H = cv.clientHeight
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#101015'
  ctx.fillRect(0, 0, W, H)
  for (let l = 1; l < NL; l++) {
    ctx.strokeStyle = 'rgba(255,255,255,.06)'
    ctx.beginPath(); ctx.moveTo(0, (l / NL) * H); ctx.lineTo(W, (l / NL) * H); ctx.stroke()
  }
  const X = (tm: number) => ((tm - vs) / viewLen) * W
  const laneH = H / NL
  for (const { note, src } of combined) {
    const x = X(note.time)
    if (x < -1 || x > W + 1) continue
    const y = ((note.lane - 0.5) / NL) * H
    ctx.fillStyle = src === 'orig' ? ORIG_GREY : SOURCE_COLOR[src]
    ctx.globalAlpha = src === 'orig' ? 0.45 : 0.95
    ctx.fillRect(x - 1, y - laneH * 0.38, 2.4, laneH * 0.76)
  }
  ctx.globalAlpha = 1
  // timing grid: a guide ONLY at original note onsets (nothing in silent gaps).
  // dedup onsets so dense chords in different lanes don't overdraw.
  const onsets = new Set<number>()
  for (const { note } of combined) onsets.add(Math.round(note.time * 1000))
  for (const ms of onsets) {
    const x = X(ms / 1000)
    if (x < 0 || x > W) continue
    ctx.strokeStyle = 'rgba(255,255,255,.09)' // faint full-height line at the note
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
    ctx.fillStyle = 'rgba(255,255,255,.6)' // brighter onset tick on the top edge
    ctx.fillRect(x - 0.5, 0, 1.2, 7)
  }
  const px = X(t)
  if (px >= 0 && px <= W) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); ctx.lineWidth = 1
  }
}

// Original reference strip (neutral) — the target each stem note should align to.
function drawOrig(cv: HTMLCanvasElement, notes: { time: number; lane: number; strong: boolean }[], t: number, vs: number, viewLen: number) {
  const ctx = cv.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth
  const H = cv.clientHeight
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.fillStyle = '#0c0c11'
  ctx.fillRect(0, 0, W, H)
  for (let l = 1; l < NL; l++) {
    ctx.strokeStyle = 'rgba(255,255,255,.05)'
    ctx.beginPath(); ctx.moveTo(0, (l / NL) * H); ctx.lineTo(W, (l / NL) * H); ctx.stroke()
  }
  const X = (tm: number) => ((tm - vs) / viewLen) * W
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

/** Combined build-up: the full map, each note colored by the stem it matches. */
export default function CombinedView({ matrix, duration }: { matrix: MapMatrix; duration: number }) {
  const [mode, setMode] = useState<'auto' | 'build'>('auto')
  const [level, setLevel] = useState<Level>('N')
  const [audioKey, setAudioKey] = useState<Source>('orig')
  const [playing, setPlaying] = useState(false)
  const [tNow, setTNow] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const [follow, setFollow] = useState(true) // scroll the view to keep the playhead visible
  const viewLen = duration / zoom
  const maxStart = Math.max(0, duration - viewLen)
  const vs = Math.min(Math.max(0, viewStart), maxStart)

  const audioRef = useRef<HTMLAudioElement>()
  const cvRef = useRef<HTMLCanvasElement>(null)
  const origRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef<number>()
  const cfgRef = useRef({ vs, viewLen, maxStart, follow })
  cfgRef.current = { vs, viewLen, maxStart, follow }

  if (!audioRef.current) {
    const a = new Audio(AUDIO_SOURCES[0].src); a.preload = 'auto'; audioRef.current = a
  }

  const combined = useMemo<Combo[]>(() => {
    const orig = matrix.orig?.[level] || []
    const stems = { vocals: matrix.vocals?.[level], drums: matrix.drums?.[level], bass: matrix.bass?.[level], other: matrix.other?.[level] }
    return combineByStem(orig, stems) as Combo[]
  }, [matrix, level])

  const counts = useMemo(() => {
    const c: Record<string, number> = { orig: 0, vocals: 0, drums: 0, bass: 0, other: 0 }
    for (const x of combined) c[x.src]++
    return c
  }, [combined])
  const stemsReady = CONTRIB.every((s) => matrix[s]?.[level])
  const origNotes = useMemo(() => combined.map((c) => c.note), [combined])

  const redraw = (t: number) => {
    const { vs, viewLen } = cfgRef.current
    if (origRef.current) drawOrig(origRef.current, origNotes, t, vs, viewLen)
    if (cvRef.current) draw(cvRef.current, combined, t, vs, viewLen)
  }
  const loop = () => {
    const a = audioRef.current!
    const t = a.currentTime
    setTNow(t)
    const c = cfgRef.current
    if (c.follow && c.viewLen < duration - 0.001) {
      // keep the playhead ~40% from the left edge; update the slider too
      const dv = Math.min(Math.max(0, t - c.viewLen * 0.4), c.maxStart)
      c.vs = dv // this frame's draw uses the followed position
      setViewStart(dv)
    }
    redraw(t)
    if (!a.paused && !a.ended) raf.current = requestAnimationFrame(loop); else setPlaying(false)
  }
  const toggle = () => {
    const a = audioRef.current!
    if (a.paused) { a.play(); setPlaying(true); raf.current = requestAnimationFrame(loop) }
    else { a.pause(); setPlaying(false); if (raf.current) cancelAnimationFrame(raf.current) }
  }
  const restart = () => seek(0)
  // seek the full song; recenter the zoomed view on the new position
  const seek = (t: number) => {
    const a = audioRef.current!
    const nt = Math.min(Math.max(0, t), duration)
    a.currentTime = nt
    setTNow(nt)
    const dv = Math.min(Math.max(0, nt - viewLen * 0.4), maxStart)
    cfgRef.current.vs = dv
    setViewStart(dv)
    redraw(nt)
  }
  const pickAudio = (k: Source) => {
    const a = audioRef.current!
    const t = a.currentTime; const wasPlaying = !a.paused
    setAudioKey(k)
    a.src = AUDIO_SOURCES.find((s) => s.key === k)!.src
    const onReady = () => { a.currentTime = t; if (wasPlaying) a.play(); a.removeEventListener('canplay', onReady) }
    a.addEventListener('canplay', onReady)
  }
  const changeZoom = (z: number) => {
    const center = vs + viewLen / 2; const nl = duration / z
    setZoom(z); setViewStart(Math.min(Math.max(0, center - nl / 2), Math.max(0, duration - nl)))
  }

  useEffect(() => { redraw(tNow) })
  useEffect(() => () => { audioRef.current?.pause(); if (raf.current) cancelAnimationFrame(raf.current) }, [])

  return (
    <div className="combined">
      <div className="builder-mode">
        <button className={mode === 'auto' ? 'on' : ''} onClick={() => setMode('auto')}>Auto-decompose</button>
        <button className={mode === 'build' ? 'on' : ''} onClick={() => setMode('build')}>Manual build</button>
        <span className="muted small">{mode === 'auto' ? 'full map auto-colored by matching stem' : 'author per-range stem layering + original fill'}</span>
      </div>
      {mode === 'build' ? <BuilderView matrix={matrix} duration={duration} /> : <>
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
        <span className="muted small">full map, each note colored by its stem</span>
      </div>

      <div className="scroll-row" style={{ marginLeft: 0 }}>
        <input type="range" min={0} max={duration} step={0.05} value={Math.min(tNow, duration)} onChange={(e) => seek(+e.target.value)} />
        <span className="muted small">{tNow.toFixed(1)} / {Math.round(duration)}s{zoom > 1 ? ` · view ${vs.toFixed(0)}–${(vs + viewLen).toFixed(0)}s` : ''}</span>
      </div>

      <div className="combined-orig-head">
        <span className="muted small">Original (reference) — combined notes &amp; the timing ticks below should line up with these</span>
      </div>
      <div className="combined-orig"><canvas ref={origRef} /></div>
      <div className="combined-field"><canvas ref={cvRef} /></div>

      <div className="combined-legend">
        <span className="muted small">build-up of {combined.length} notes:</span>
        {CONTRIB.map((s) => (
          <span className="leg-item" key={s}><i style={{ background: SOURCE_COLOR[s] }} />{SOURCE_LABEL[s]} <b>{counts[s]}</b></span>
        ))}
        <span className="leg-item"><i style={{ background: ORIG_GREY, opacity: 0.5 }} />unmatched <b>{counts.orig}</b></span>
        {!stemsReady && <span className="muted small">· {LEVEL_LABEL[level]} stem maps still generating…</span>}
      </div>
      </>}
    </div>
  )
}
