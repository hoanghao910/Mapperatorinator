import { useEffect, useMemo, useState } from 'react'
import { BHChart, DemoData } from './types'
import { deriveDiffsFromBH, Diffs, Level, LEVELS, MapMatrix, osuToDiffNotes, Source, SOURCES } from './util'
import StemsView from './StemsView'
import GameplayGridView from './GameplayGridView'
import MergeView from './MergeView'
import CombinedView from './CombinedView'

const BASE = '/fixtures/pipeline/'
type Tab = 'audio' | 'gameplay' | 'combined' | 'merge'
// Which chart set drives the difficulty tabs: the regenerated mania 5K charts,
// or the previous ones (orig-stem maps, or the BH-derived proxy).
type ChartSource = 'mania' | 'legacy'

// A generated song pipeline discovered from the API (source×level chart matrix).
interface Pipeline {
  song: string
  label: string
  duration: number
  sources: string[]
  levels: string[]
  maps: Record<string, { id: string; mode?: number; objs?: number; nps?: number; ln_pct?: number }>
  audio: Record<string, string> // source → a run id whose /audio serves that stem
}

const BUILTIN = 'builtin'

// Minimal DemoData for a dynamic song: enough for the tabs that only need
// duration + the note matrix (no waveform peaks / sections assets).
function synthDemo(pl: Pipeline): DemoData {
  return {
    meta: { song: pl.label, bpm: 0, nLanes: 5, clipStart: 0, clipLen: pl.duration, fullDuration: pl.duration },
    peaks: {}, notes: [], sectionsFull: [], sectionsClip: [], accentsClip: [], beatsClip: [],
    counts: { notes: 0, strong: 0, sections: 0, accents: 0 },
  }
}

/** The slide-deck pipeline as an interactive demo: audio/stems → 5-lane gameplay
 * → combined decomposition → multi-difficulty merge. Beat It fixtures by default;
 * any generated source×level matrix on disk (e.g. stem_study songs) is selectable. */
export default function PipelineView() {
  const [demo, setDemo] = useState<DemoData | null>(null)
  const [bh, setBh] = useState<BHChart | null>(null)
  const [matrix, setMatrix] = useState<MapMatrix>({})
  const [maniaDiffs, setManiaDiffs] = useState<Diffs | null>(null)
  const [tab, setTab] = useState<Tab>('audio')
  const [source, setSource] = useState<ChartSource>('mania')
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [songKey, setSongKey] = useState<string>(BUILTIN)

  // Discover generated song matrices from the API (in addition to Beat It fixtures).
  useEffect(() => {
    fetch('/api/pipelines')
      .then((r) => (r.ok ? r.json() : []))
      .then((ps: Pipeline[]) => setPipelines(Array.isArray(ps) ? ps : []))
      .catch(() => setPipelines([]))
  }, [])

  const activePl = songKey === BUILTIN ? null : pipelines.find((p) => p.song === songKey) ?? null

  // Load the selected song's assets (built-in fixtures, or a dynamic matrix via /api/runs).
  useEffect(() => {
    setMatrix({})
    setManiaDiffs(null)

    if (songKey === BUILTIN) {
      setBh(null)
      fetch(BASE + 'demo_data.json').then((r) => r.json()).then(setDemo).catch(() => {})
      fetch(BASE + 'beat_it_bh.json').then((r) => r.json()).then(setBh).catch(() => {})
      // mania 5K E/N/H charts (with long notes) drive the difficulty tabs.
      Promise.all(
        (LEVELS as Level[]).map((l) =>
          fetch(BASE + `beat_it_mania_${l}.osu`)
            .then((r) => (r.ok ? r.text() : Promise.reject()))
            .then((txt) => osuToDiffNotes(txt))
            .catch(() => null),
        ),
      ).then(([E, N, H]) => { if (E && N && H) setManiaDiffs({ E, N, H }) })
      // 3×5 map matrix (map_<source>_<level>.osu). Missing ones just stay absent.
      Promise.all(
        SOURCES.flatMap((s) =>
          LEVELS.map((l) =>
            fetch(BASE + `map_${s}_${l}.osu`)
              .then((r) => (r.ok ? r.text() : Promise.reject()))
              .then((txt) => ({ s, l, notes: osuToDiffNotes(txt) }))
              .catch(() => null),
          ),
        ),
      ).then((results) => {
        const m: MapMatrix = {}
        for (const r of results) if (r && r.notes.length) ((m[r.s] ??= {})[r.l] = r.notes)
        setMatrix(m)
      })
      return
    }

    const pl = pipelines.find((p) => p.song === songKey)
    if (!pl) return
    setBh(null)
    setDemo(synthDemo(pl))
    setSource('mania')
    // matrix: fetch each present source×level chart from the API by run id.
    Promise.all(
      pl.sources.flatMap((s) =>
        pl.levels.map((l) => {
          const cell = pl.maps[`${s}_${l}`]
          if (!cell) return Promise.resolve(null)
          return fetch(`/api/runs/${cell.id}/osu`)
            .then((r) => (r.ok ? r.text() : Promise.reject()))
            .then((txt) => ({ s: s as Source, l: l as Level, notes: osuToDiffNotes(txt) }))
            .catch(() => null)
        }),
      ),
    ).then((results) => {
      const m: MapMatrix = {}
      for (const r of results) if (r && r.notes.length) ((m[r.s] ??= {})[r.l] = r.notes)
      setMatrix(m)
    })
    // difficulty tabs are driven by the ORIGINAL-audio charts at E/N/H.
    Promise.all(
      (['E', 'N', 'H'] as Level[]).map((l) => {
        const cell = pl.maps[`orig_${l}`]
        if (!cell) return Promise.resolve(null)
        return fetch(`/api/runs/${cell.id}/osu`)
          .then((r) => (r.ok ? r.text() : Promise.reject()))
          .then((txt) => osuToDiffNotes(txt))
          .catch(() => null)
      }),
    ).then(([E, N, H]) => { if (E && N && H) setManiaDiffs({ E, N, H }) })
  }, [songKey, pipelines])

  // The "legacy" (pre-regeneration) difficulty set: orig-stem E/N/H, else BH proxy.
  const legacyDiffs = useMemo<Diffs>(() => {
    const o = matrix.orig
    if (o?.E && o?.N && o?.H) return { E: o.E, N: o.N, H: o.H }
    return bh ? deriveDiffsFromBH(bh.notes) : { E: [], N: [], H: [] }
  }, [matrix, bh])

  // Chart selector drives the Gameplay/Merge tabs; fall back to legacy if the
  // mania set hasn't loaded (or isn't present).
  const useMania = source === 'mania' && !!maniaDiffs
  const diffs = useMania ? (maniaDiffs as Diffs) : legacyDiffs
  const legacyLabel = matrix.orig?.E ? 'OLD · orig-stem' : 'OLD · BH proxy'

  if (!demo) return <div className="placeholder pl-loading">Loading pipeline demo…</div>

  const TABS: { id: Tab; label: string }[] = [
    { id: 'audio', label: '① Audio · Stems' },
    { id: 'gameplay', label: '② Gameplay · compare' },
    { id: 'combined', label: '③ Combined · build-up' },
    { id: 'merge', label: '④ Difficulties · Merge' },
  ]

  // For a dynamic song, feed StemsView the API stem audio + client-computed peaks.
  const stemAudioSrc = activePl ? (k: string) => (activePl.audio[k] ? `/api/runs/${activePl.audio[k]}/audio` : undefined) : undefined

  return (
    <div className="pipeline">
      <div className="pl-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
        <label className="demo-select pl-song-pick" title="Which generated song's pipeline to view">
          song
          <select value={songKey} onChange={(e) => setSongKey(e.target.value)}>
            <option value={BUILTIN}>Beat It (built-in)</option>
            {pipelines.length > 0 && (
              <optgroup label="Generated runs">
                {pipelines.map((p) => (
                  <option key={p.song} value={p.song}>{p.label}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label className="demo-select pl-source" title="Which chart set drives the Gameplay & Merge tabs">
          chart
          <select value={useMania ? 'mania' : 'legacy'} onChange={(e) => setSource(e.target.value as ChartSource)}>
            <option value="mania" disabled={!maniaDiffs}>
              {maniaDiffs ? 'NEW · mania 5K + LN' : 'NEW · mania (loading…)'}
            </option>
            <option value="legacy">{legacyLabel}</option>
          </select>
        </label>
        <span className="pl-song">{demo.meta.song}</span>
      </div>
      <div className="pl-body">
        {tab === 'audio' && (
          <StemsView
            demo={demo} matrix={matrix} diffs={diffs}
            audioSrc={stemAudioSrc} peaksSrc={activePl ? null : undefined} songId={songKey}
          />
        )}
        {tab === 'gameplay' && <GameplayGridView matrix={matrix} diffs={diffs} duration={demo.meta.fullDuration} />}
        {tab === 'combined' && <CombinedView matrix={matrix} duration={demo.meta.fullDuration} />}
        {tab === 'merge' && (
          <MergeView diffs={diffs} sections={demo.sectionsFull} duration={demo.meta.fullDuration} real={useMania || !!matrix.orig?.E} />
        )}
      </div>
    </div>
  )
}
