import { useEffect, useMemo, useState } from 'react'
import { BHChart, DemoData } from './types'
import { deriveDiffsFromBH, Diffs, Level, LEVELS, MapMatrix, osuToDiffNotes, SOURCES } from './util'
import StemsView from './StemsView'
import GameplayGridView from './GameplayGridView'
import MergeView from './MergeView'
import CombinedView from './CombinedView'

const BASE = '/fixtures/pipeline/'
type Tab = 'audio' | 'gameplay' | 'combined' | 'merge'
// Which chart set drives the difficulty tabs: the regenerated mania 5K charts,
// or the previous ones (orig-stem maps, or the BH-derived proxy).
type ChartSource = 'mania' | 'legacy'

/** The slide-deck pipeline as an interactive demo: audio/stems → 5-lane gameplay
 * → combined decomposition → multi-difficulty merge. Real Beat It assets. */
export default function PipelineView() {
  const [demo, setDemo] = useState<DemoData | null>(null)
  const [bh, setBh] = useState<BHChart | null>(null)
  const [matrix, setMatrix] = useState<MapMatrix>({})
  const [maniaDiffs, setManiaDiffs] = useState<Diffs | null>(null)
  const [tab, setTab] = useState<Tab>('audio')
  const [source, setSource] = useState<ChartSource>('mania')

  useEffect(() => {
    fetch(BASE + 'demo_data.json').then((r) => r.json()).then(setDemo).catch(() => {})
    fetch(BASE + 'beat_it_bh.json').then((r) => r.json()).then(setBh).catch(() => {})
    // New pipeline output: mania 5K E/N/H charts (with long notes). If all three
    // load, they drive the difficulty tabs so you see the real regenerated charts.
    Promise.all(
      (LEVELS as Level[]).map((l) =>
        fetch(BASE + `beat_it_mania_${l}.osu`)
          .then((r) => (r.ok ? r.text() : Promise.reject()))
          .then((txt) => osuToDiffNotes(txt))
          .catch(() => null),
      ),
    ).then(([E, N, H]) => {
      if (E && N && H) setManiaDiffs({ E, N, H })
    })
    // Load the 3×5 map matrix (map_<source>_<level>.osu). Missing ones just stay absent.
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
      for (const r of results) {
        if (r && r.notes.length) ((m[r.s] ??= {})[r.l] = r.notes)
      }
      setMatrix(m)
    })
  }, [])

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

  if (!demo || !bh) return <div className="placeholder pl-loading">Loading pipeline demo…</div>

  const TABS: { id: Tab; label: string }[] = [
    { id: 'audio', label: '① Audio · Stems' },
    { id: 'gameplay', label: '② Gameplay · compare' },
    { id: 'combined', label: '③ Combined · build-up' },
    { id: 'merge', label: '④ Difficulties · Merge' },
  ]

  return (
    <div className="pipeline">
      <div className="pl-tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
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
        {tab === 'audio' && <StemsView demo={demo} matrix={matrix} diffs={diffs} />}
        {tab === 'gameplay' && <GameplayGridView matrix={matrix} diffs={diffs} duration={demo.meta.fullDuration} />}
        {tab === 'combined' && <CombinedView matrix={matrix} duration={demo.meta.fullDuration} />}
        {tab === 'merge' && (
          <MergeView diffs={diffs} sections={demo.sectionsFull} duration={demo.meta.fullDuration} real={useMania || !!matrix.orig?.E} />
        )}
      </div>
    </div>
  )
}
