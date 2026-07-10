import { useEffect, useRef, useState } from 'react'
import { DemoData } from './types'
import { Diffs, DiffNote, Level, MapMatrix } from './util'

const BASE = '/fixtures/pipeline/'
const STEMS = [
  { k: 'orig', label: 'Original', col: '#cbd5e1', src: BASE + 'full_orig.mp3' },
  { k: 'vocals', label: 'Vocals', col: '#ec4899', src: BASE + 'full_vocals.mp3' },
  { k: 'drums', label: 'Drums', col: '#f59e0b', src: BASE + 'full_drums.mp3', note: 'drives strong notes' },
  { k: 'bass', label: 'Bass', col: '#6366f1', src: BASE + 'full_bass.mp3' },
  { k: 'other', label: 'Other', col: '#14b8a6', src: BASE + 'full_other.mp3' },
]
const DIFFS: { k: 'E' | 'N' | 'H'; name: string; col: string }[] = [
  { k: 'E', name: 'Easy', col: '#22c55e' },
  { k: 'N', name: 'Normal', col: '#6366f1' },
  { k: 'H', name: 'Hard', col: '#ef4444' },
]
const NL = 5
const ZOOMS = [1, 2, 4, 8]
const MAP_SRC = ['orig', 'vocals', 'drums', 'bass', 'other'] // a map is generated per source

// Decode an audio URL to a normalized peak-per-bucket array, for songs that have
// no precomputed peaks JSON (dynamic runs served by the API). Best-effort: any
// failure just leaves that stem's waveform empty while audio still plays.
async function computePeaks(url: string, buckets = 1200): Promise<number[]> {
  const AC: typeof AudioContext =
    (window as any).AudioContext || (window as any).webkitAudioContext
  const ac = new AC()
  try {
    const buf = await fetch(url).then((r) => r.arrayBuffer())
    const audio = await ac.decodeAudioData(buf)
    const ch = audio.getChannelData(0)
    const block = Math.max(1, Math.floor(ch.length / buckets))
    const out: number[] = []
    let max = 0
    for (let i = 0; i < buckets; i++) {
      let m = 0
      const s = i * block
      for (let j = 0; j < block; j++) { const v = Math.abs(ch[s + j] || 0); if (v > m) m = v }
      out.push(m); if (m > max) max = m
    }
    return max > 0 ? out.map((v) => v / max) : out
  } finally {
    ac.close()
  }
}

function setup(cv: HTMLCanvasElement) {
  const ctx = cv.getContext('2d')!
  const dpr = window.devicePixelRatio || 1
  const W = cv.clientWidth
  const H = cv.clientHeight
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, W, H }
}

function drawWave(cv: HTMLCanvasElement, peaks: number[], color: string, t: number, dur: number, vs: number, viewLen: number) {
  const { ctx, W, H } = setup(cv)
  ctx.clearRect(0, 0, W, H)
  if (!peaks.length) return
  const n = peaks.length
  const base = H / 2
  const amp = H / 2 - 3
  const i0 = Math.max(0, Math.floor((vs / dur) * n))
  const i1 = Math.min(n, Math.ceil(((vs + viewLen) / dur) * n))
  const count = Math.max(1, i1 - i0)
  const bw = W / count
  for (let i = i0; i < i1; i++) {
    const h = Math.max(1, (peaks[i] || 0) * amp)
    const barT = (i / n) * dur
    ctx.fillStyle = barT <= t ? color : '#33333d'
    ctx.fillRect((i - i0) * bw, base - h, Math.max(0.7, bw - 0.4), h * 2)
  }
}

function drawPianoRoll(cv: HTMLCanvasElement, notes: DiffNote[], t: number, vs: number, viewLen: number, color: string, bg?: DiffNote[]) {
  const { ctx, W, H } = setup(cv)
  ctx.fillStyle = '#121216'
  ctx.fillRect(0, 0, W, H)
  for (let l = 1; l < NL; l++) {
    ctx.strokeStyle = 'rgba(255,255,255,.06)'
    ctx.beginPath(); ctx.moveTo(0, (l / NL) * H); ctx.lineTo(W, (l / NL) * H); ctx.stroke()
  }
  const X = (tm: number) => ((tm - vs) / viewLen) * W
  const laneH = H / NL
  // original map as faint background (to compare stem mapping vs original)
  if (bg) {
    ctx.fillStyle = '#8a8a9a'
    ctx.globalAlpha = 0.3
    for (const n of bg) {
      const x = X(n.time)
      if (x < -1 || x > W + 1) continue
      const y = ((n.lane - 0.5) / NL) * H
      ctx.fillRect(x - 0.5, y - laneH * 0.3, 2.4, laneH * 0.6)
    }
    ctx.globalAlpha = 1
  }
  for (const n of notes) {
    const x = X(n.time)
    if (x < -1 || x > W + 1) continue
    const y = ((n.lane - 0.5) / NL) * H
    ctx.fillStyle = n.strong ? '#f59e0b' : color
    ctx.globalAlpha = n.strong ? 1 : 0.8
    ctx.fillRect(x, y - laneH * 0.36, 1.8, laneH * 0.72)
  }
  ctx.globalAlpha = 1
  const px = X(t)
  if (px >= 0 && px <= W) {
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1.5
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
    ctx.lineWidth = 1
  }
}

/** Audio/Stems: mixer (checkboxes) + waveform ⇄ per-stem gameplay (level selectable).
 * audioSrc/peaksSrc let a caller point at a different song's assets: audioSrc(k)
 * returns the URL for stem k; peaksSrc is a peaks-JSON url, or null to compute
 * peaks from the audio client-side (dynamic runs). songId scopes the audio/peaks
 * caches so switching songs resets them. */
export default function StemsView({
  demo, matrix, diffs, audioSrc, peaksSrc, songId = 'builtin',
}: {
  demo: DemoData; matrix: MapMatrix; diffs: Diffs
  audioSrc?: (k: string) => string | undefined
  peaksSrc?: string | null
  songId?: string
}) {
  const srcOf = (k: string): string =>
    (audioSrc ? audioSrc(k) : STEMS.find((x) => x.k === k)?.src) || ''
  const [view, setView] = useState<'wave' | 'game'>('wave')
  const [gameLevel, setGameLevel] = useState<Level>('N') // which difficulty the stem maps show
  const [selected, setSelected] = useState<Set<string>>(new Set(['orig'])) // stems to play
  const [bgOn, setBgOn] = useState(true) // overlay the original map behind each stem
  const [playing, setPlaying] = useState(false)
  const [tNow, setTNow] = useState(0)
  const audios = useRef<Record<string, HTMLAudioElement>>({})
  const waveCv = useRef<Record<string, HTMLCanvasElement | null>>({})
  const gameCv = useRef<Record<string, HTMLCanvasElement | null>>({})
  const peaks = useRef<Record<string, number[]>>({})
  const raf = useRef<number>()
  const dur = demo.meta.fullDuration

  // zoom + scroll view window (shared by waveform + gameplay lanes)
  const [zoom, setZoom] = useState(1)
  const [viewStart, setViewStart] = useState(0)
  const [follow, setFollow] = useState(true) // scroll the view to keep the playhead visible
  const viewLen = dur / zoom
  const maxStart = Math.max(0, dur - viewLen)
  const vs = Math.min(Math.max(0, viewStart), maxStart)
  const STEM_KEYS = ['vocals', 'drums', 'bass', 'other']
  const stemsReady = STEM_KEYS.every((k) => matrix[k as keyof MapMatrix]?.[gameLevel])
  // everything redraw() needs, in a ref, so the rAF loop never reads stale values
  const cfgRef = useRef<any>({})
  cfgRef.current = { view, gameLevel, vs, viewLen, matrix, bgOn, stemsReady, diffs, follow, maxStart, dur }
  const changeZoom = (z: number) => {
    const center = vs + viewLen / 2
    const nl = dur / z
    setZoom(z)
    setViewStart(Math.min(Math.max(0, center - nl / 2), Math.max(0, dur - nl)))
  }

  // orig is the master clock (always plays when transport is on; muted if not selected)
  const clock = () => {
    if (!audios.current.orig) {
      const a = new Audio(srcOf('orig')); a.preload = 'auto'; audios.current.orig = a
    }
    return audios.current.orig
  }
  const getAudio = (k: string) => {
    if (!audios.current[k]) {
      const a = new Audio(srcOf(k)); a.preload = 'auto'; audios.current[k] = a
    }
    return audios.current[k]
  }

  const redraw = (t: number) => {
    const c = cfgRef.current
    if (c.view === 'wave') {
      for (const s of STEMS) { const cv = waveCv.current[s.k]; if (cv) drawWave(cv, peaks.current[s.k] || [], s.col, t, dur, c.vs, c.viewLen) }
    } else if (c.stemsReady) {
      // each stem row shows the map generated from THAT stem at the level; original as bg
      for (const s of STEMS) {
        const cv = gameCv.current[s.k]
        if (!cv) continue
        const notes = c.matrix[s.k]?.[c.gameLevel] || []
        const bg = c.bgOn && s.k !== 'orig' ? c.matrix.orig?.[c.gameLevel] : undefined
        drawPianoRoll(cv, notes, t, c.vs, c.viewLen, s.col, bg)
      }
    } else {
      // fallback (stem maps for this level not generated yet): the orig chart
      const dc = DIFFS.find((d) => d.k === c.gameLevel)!.col
      for (const s of STEMS) { const cv = gameCv.current[s.k]; if (cv) drawPianoRoll(cv, c.diffs[c.gameLevel], t, c.vs, c.viewLen, dc) }
    }
  }

  const loop = () => {
    const t = clock().currentTime
    setTNow(t)
    const c = cfgRef.current
    if (c.follow && c.viewLen < c.dur - 0.001) {
      const dv = Math.min(Math.max(0, t - c.viewLen * 0.4), c.maxStart)
      c.vs = dv
      setViewStart(dv)
    }
    redraw(t)
    if (!clock().paused && !clock().ended) raf.current = requestAnimationFrame(loop)
    else setPlaying(false)
  }

  const play = () => {
    const t = clock().currentTime
    const c = clock()
    c.currentTime = t; c.volume = selected.has('orig') ? 1 : 0; c.play()
    selected.forEach((k) => { if (k !== 'orig') { const a = getAudio(k); a.currentTime = t; a.play() } })
    setPlaying(true)
    raf.current = requestAnimationFrame(loop)
  }
  const pause = () => {
    Object.values(audios.current).forEach((a) => a.pause())
    if (raf.current) cancelAnimationFrame(raf.current)
    setPlaying(false)
  }
  const toggle = () => (playing ? pause() : play())
  const restart = () => seek(0)
  // seek the full song across all stem audios; recenter the zoomed view
  const seek = (t: number) => {
    const nt = Math.min(Math.max(0, t), dur)
    clock().currentTime = nt
    Object.values(audios.current).forEach((a) => { a.currentTime = nt })
    setTNow(nt)
    const dv = Math.min(Math.max(0, nt - viewLen * 0.4), maxStart)
    cfgRef.current.vs = dv
    setViewStart(dv)
    redraw(nt)
  }

  const toggleStem = (k: string) => {
    setSelected((prev) => {
      const n = new Set(prev)
      const had = n.has(k)
      had ? n.delete(k) : n.add(k)
      // live mixing while playing
      if (playing) {
        if (k === 'orig') clock().volume = had ? 0 : 1
        else { const a = getAudio(k); if (had) a.pause(); else { a.currentTime = clock().currentTime; a.play() } }
      }
      return n
    })
  }

  // Load (or compute) waveform peaks, scoped to the current song. On song change,
  // stop + drop the cached audio elements and peaks so nothing bleeds across.
  useEffect(() => {
    let cancelled = false
    Object.values(audios.current).forEach((a) => a.pause())
    audios.current = {}
    peaks.current = {}
    setPlaying(false)
    if (peaksSrc === null) {
      // dynamic song: no peaks JSON — decode each stem's audio in the browser
      for (const s of STEMS) {
        const url = srcOf(s.k)
        if (!url) continue
        computePeaks(url).then((p) => { if (!cancelled) { peaks.current[s.k] = p; redraw(tNow) } }).catch(() => {})
      }
    } else {
      fetch(peaksSrc ?? BASE + 'full_peaks.json')
        .then((r) => r.json())
        .then((p) => { if (!cancelled) { peaks.current = p; redraw(tNow) } })
        .catch(() => {})
    }
    return () => {
      cancelled = true
      if (raf.current) cancelAnimationFrame(raf.current)
      Object.values(audios.current).forEach((a) => a.pause())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songId, peaksSrc])
  useEffect(() => { redraw(tNow) }) // redraw on view/selection/maps change

  return (
    <div className="stems">
      <div className="stems-top">
        <button className="play" onClick={toggle}>{playing ? '❚❚' : '▶'}</button>
        <button onClick={restart}>⏮</button>
        <span className="clock">{tNow.toFixed(1)}s</span>
        <div className="view-toggle">
          <button className={view === 'wave' ? 'on' : ''} onClick={() => setView('wave')}>Waveform</button>
          <button className={view === 'game' ? 'on' : ''} onClick={() => setView('game')}>Gameplay lanes</button>
        </div>
        {view === 'game' && (
          <>
            <span className="gp-diff-pick">
              level:
              {DIFFS.map((d) => (
                <button key={d.k} className={gameLevel === d.k ? 'on' : ''} style={gameLevel === d.k ? { background: d.col, borderColor: d.col } : {}} onClick={() => setGameLevel(d.k)}>
                  {d.name}
                </button>
              ))}
            </span>
            <label className="bg-toggle">
              <input type="checkbox" checked={bgOn} onChange={(e) => setBgOn(e.target.checked)} />
              <span className="bg-swatch" /> Original map as background
            </label>
          </>
        )}
        <div className="zoom-ctl">
          zoom
          {ZOOMS.map((z) => (
            <button key={z} className={zoom === z ? 'on' : ''} onClick={() => changeZoom(z)}>{z}×</button>
          ))}
        </div>
        <label className="bg-toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          follow playhead
        </label>
        <span className="muted small">check stems to mix · {Math.round(dur)}s</span>
      </div>

      <div className="scroll-row" style={{ marginLeft: 0 }}>
        <input type="range" min={0} max={dur} step={0.05} value={Math.min(tNow, dur)} onChange={(e) => seek(+e.target.value)} />
        <span className="muted small">{tNow.toFixed(1)} / {Math.round(dur)}s{zoom > 1 ? ` · view ${vs.toFixed(0)}–${(vs + viewLen).toFixed(0)}s` : ''}</span>
      </div>

      <div className="stems-rows">
        {STEMS.map((s) => (
          <div className={`stemrow ${selected.has(s.k) ? 'on' : ''}`} key={s.k}>
            <label className="stemname">
              <input type="checkbox" checked={selected.has(s.k)} onChange={() => toggleStem(s.k)} />
              <span className="dot" style={{ background: s.col }} />
              <span>{s.label}</span>
              {view === 'wave' && s.note && <span className="stem-note">{s.note}</span>}
              {view === 'game' && stemsReady && matrix[s.k as keyof MapMatrix]?.[gameLevel] && (
                <span className="stem-note">{matrix[s.k as keyof MapMatrix]![gameLevel]!.length} notes</span>
              )}
            </label>
            {view === 'wave' ? (
              <div className="wavewrap"><canvas ref={(el) => (waveCv.current[s.k] = el)} /></div>
            ) : (
              <div className="wavewrap" style={{ height: 92 }}><canvas ref={(el) => (gameCv.current[s.k] = el)} className="diff-strip" /></div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
