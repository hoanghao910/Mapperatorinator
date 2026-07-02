import { useCallback, useEffect, useRef, useState } from 'react'
import { Analysis, Beatmap, Finding } from './types'
import { parseOsu } from './osu/parseOsu'
import { fmtTime } from './lib/osuMath'
import LaneView from './components/LaneView'
import Timeline from './components/Timeline'
import FindingsPanel from './components/FindingsPanel'
import PipelineView from './pipeline/PipelineView'

type Mode = 'analyze' | 'pipeline'

interface Demo { id: string; label: string; osu: string; audio: string; analysis: string }

const DEMOS: Demo[] = [
  {
    id: 'dirty_diana',
    label: 'Dirty Diana — Michael Jackson',
    osu: '/fixtures/dirty_diana.osu',
    audio: '/fixtures/dirty_diana.mp3',
    analysis: '/fixtures/dirty_diana.maimod.json',
  },
  {
    id: 'beat_it',
    label: 'Beat It — old (osu!standard)',
    osu: '/fixtures/beat_it.osu',
    audio: '/fixtures/beat_it.mp3',
    analysis: '/fixtures/beat_it.maimod.json',
  },
  {
    // Regenerated with today's pipeline: osu!mania 5K + mania_ln long-note pass.
    // Same beat_it.mp3 cut as the old standard demo, so old vs. new line up.
    id: 'beat_it_mania',
    label: 'Beat It — NEW (mania 5K + LN)',
    osu: '/fixtures/beat_it_mania_N.osu',
    audio: '/fixtures/beat_it.mp3',
    analysis: '',
  },
]

export default function App() {
  const [beatmap, setBeatmap] = useState<Beatmap | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [demoId, setDemoId] = useState(DEMOS[0].id)
  const [audioUrl, setAudioUrl] = useState<string>(DEMOS[0].audio)
  const [timeMs, setTimeMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [selected, setSelected] = useState<Finding | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [lookahead, setLookahead] = useState(1600) // ms of chart visible (scroll speed)
  const [mode, setMode] = useState<Mode>('analyze')
  const [osuText, setOsuText] = useState<string>('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeMsg, setAnalyzeMsg] = useState('')

  const audioRef = useRef<HTMLAudioElement>(null)
  const rafRef = useRef<number>()

  // Load the selected demo (also runs on first mount).
  useEffect(() => {
    const demo = DEMOS.find((d) => d.id === demoId)!
    setSelected(null)
    setBeatmap(null)
    setAnalysis(null)
    setError(null)
    setAudioUrl(demo.audio)
    fetch(demo.osu)
      .then((r) => r.text())
      .then((t) => { setOsuText(t); setBeatmap(parseOsu(t)) })
      .catch(() => setError(`Could not load ${demo.label} beatmap`))
    fetch(demo.analysis).then((r) => r.json()).then(setAnalysis).catch(() => {})
  }, [demoId])

  // Land on the first object so the playfield isn't empty at t=0.
  useEffect(() => {
    if (beatmap && beatmap.hitObjects.length) {
      seek(Math.max(0, beatmap.hitObjects[0].time - 400))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beatmap])

  // Drive timeMs from audio playback.
  useEffect(() => {
    const tick = () => {
      const a = audioRef.current
      if (a) setTimeMs(a.currentTime * 1000)
      rafRef.current = requestAnimationFrame(tick)
    }
    if (playing) rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [playing])

  const seek = useCallback((ms: number) => {
    const a = audioRef.current
    if (a) a.currentTime = Math.max(0, ms / 1000)
    setTimeMs(Math.max(0, ms))
  }, [])

  const selectFinding = useCallback((f: Finding) => {
    setSelected(f)
    seek(f.time)
  }, [seek])

  const togglePlay = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) { a.play(); setPlaying(true) } else { a.pause(); setPlaying(false) }
  }

  const loadOsuFile = (file: File) => {
    file.text().then((t) => {
      try { setOsuText(t); setBeatmap(parseOsu(t)); setSelected(null); setError(null) }
      catch (e) { setError(`Failed to parse .osu: ${e}`) }
    })
  }

  // Live analysis: upload the current .osu + audio to the API, poll, load findings.
  const analyzeLive = async () => {
    if (!osuText) { setError('Load a .osu beatmap first.'); return }
    setAnalyzing(true); setAnalyzeMsg('uploading'); setError(null)
    try {
      const fd = new FormData()
      fd.append('beatmap', new Blob([osuText], { type: 'text/plain' }), 'map.osu')
      const audioBlob = await fetch(audioUrl).then((r) => r.blob())
      fd.append('audio', audioBlob, 'audio.mp3')
      const job = await fetch('/api/analyze/upload', { method: 'POST', body: fd })
        .then((r) => { if (!r.ok) throw new Error(`API ${r.status}`); return r.json() })
      let result: Analysis | null = null
      for (;;) {
        await new Promise((r) => setTimeout(r, 3000))
        const j = await fetch(`/api/analyze/${job.id}`).then((r) => r.json())
        setAnalyzeMsg(j.status === 'running' ? 'analyzing (~100s)' : j.status)
        if (j.status === 'done') { result = j.result; break }
        if (j.status === 'error') throw new Error(j.error?.split('\n').pop() || 'analysis failed')
      }
      setAnalysis(result); setSelected(null)
    } catch (e: any) {
      setError(`Analyze failed: ${e.message}. Is the API running on :8770? (./run_api.sh)`)
    } finally {
      setAnalyzing(false); setAnalyzeMsg('')
    }
  }
  const loadAudioFile = (file: File) => setAudioUrl(URL.createObjectURL(file))
  const loadAnalysisFile = (file: File) => {
    file.text().then((t) => {
      try { setAnalysis(JSON.parse(t)); setSelected(null) }
      catch (e) { setError(`Failed to parse analysis JSON: ${e}`) }
    })
  }

  const findings = analysis?.suggestions ?? []

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Mapperatorinator <span className="sub">Visualize / Analyze</span>
        </div>
        <div className="mode-nav">
          <button className={mode === 'analyze' ? 'on' : ''} onClick={() => setMode('analyze')}>Analyze</button>
          <button className={mode === 'pipeline' ? 'on' : ''} onClick={() => setMode('pipeline')}>Pipeline Demo</button>
        </div>
        {mode === 'analyze' && (
          <div className="loaders">
            <label className="demo-select">
              demo
              <select value={demoId} onChange={(e) => setDemoId(e.target.value)}>
                {DEMOS.map((d) => (
                  <option key={d.id} value={d.id}>{d.label}</option>
                ))}
              </select>
            </label>
            <FileBtn label="Beatmap (.osu)" accept=".osu" onFile={loadOsuFile} />
            <FileBtn label="Audio" accept="audio/*" onFile={loadAudioFile} />
            <FileBtn label="Analysis (.json)" accept=".json,.maimod.json" onFile={loadAnalysisFile} />
            <button className="loader-btn analyze-live" onClick={analyzeLive} disabled={analyzing}>
              {analyzing ? `⏳ ${analyzeMsg || 'analyzing'}…` : '⚡ Analyze live'}
            </button>
          </div>
        )}
      </header>

      {mode === 'pipeline' ? (
        <PipelineView />
      ) : (
      <>
      {error && <div className="error-bar">{error}</div>}

      <div className="main">
        <section className="left">
          <div className="view-area">
            {beatmap ? (
              <div className="lane-stage">
                <LaneView
                  beatmap={beatmap}
                  findings={findings}
                  timeMs={timeMs}
                  selected={selected}
                  lookahead={lookahead}
                  onSeek={seek}
                  onSelect={selectFinding}
                />
              </div>
            ) : (
              <div className="placeholder">Loading beatmap…</div>
            )}
          </div>

          <div className="transport">
            <button className="play" onClick={togglePlay}>{playing ? '❚❚' : '▶'}</button>
            <button onClick={() => seek(0)}>⏮</button>
            <span className="clock">{fmtTime(timeMs)}</span>
            <label className="scroll-ctl">
              scroll
              <select value={lookahead} onChange={(e) => setLookahead(+e.target.value)}>
                <option value={1000}>fast</option>
                <option value={1600}>normal</option>
                <option value={2600}>slow</option>
              </select>
            </label>
            <span className="meta">
              {beatmap && `${beatmap.artist} — ${beatmap.title} [${beatmap.version}]`}
            </span>
          </div>

          {beatmap && (
            <Timeline
              beatmap={beatmap}
              findings={findings}
              timeMs={timeMs}
              selected={selected}
              onSeek={seek}
              onSelect={selectFinding}
            />
          )}
        </section>

        <aside className="right">
          {analysis && (
            <div className="analysis-meta">
              <strong>{analysis.count}</strong> findings · mode {analysis.mode}
            </div>
          )}
          <FindingsPanel findings={findings} selected={selected} onSelect={selectFinding} />
        </aside>
      </div>

      <audio
        ref={audioRef}
        src={audioUrl}
        onPause={() => setPlaying(false)}
        onPlay={() => setPlaying(true)}
        onEnded={() => setPlaying(false)}
        preload="auto"
      />
      </>
      )}
    </div>
  )
}

function FileBtn({ label, accept, onFile }: { label: string; accept: string; onFile: (f: File) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  return (
    <>
      <button className="loader-btn" onClick={() => ref.current?.click()}>{label}</button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = '' }}
      />
    </>
  )
}
