import { useEffect, useMemo, useState } from 'react'
import { BHChart, DemoData } from './types'
import { deriveDiffsFromBH, Diffs, LEVELS, MapMatrix, osuToDiffNotes, SOURCES } from './util'
import StemsView from './StemsView'
import GameplayGridView from './GameplayGridView'
import MergeView from './MergeView'
import CombinedView from './CombinedView'

const BASE = '/fixtures/pipeline/'
type Tab = 'audio' | 'gameplay' | 'combined' | 'merge'

/** The slide-deck pipeline as an interactive demo: audio/stems → 5-lane gameplay
 * → combined decomposition → multi-difficulty merge. Real Beat It assets. */
export default function PipelineView() {
  const [demo, setDemo] = useState<DemoData | null>(null)
  const [bh, setBh] = useState<BHChart | null>(null)
  const [matrix, setMatrix] = useState<MapMatrix>({})
  const [tab, setTab] = useState<Tab>('audio')

  useEffect(() => {
    fetch(BASE + 'demo_data.json').then((r) => r.json()).then(setDemo).catch(() => {})
    fetch(BASE + 'beat_it_bh.json').then((r) => r.json()).then(setBh).catch(() => {})
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

  // orig E/N/H drives the Merge tab; fall back to BH-derived if not loaded yet.
  const diffs = useMemo<Diffs>(() => {
    const o = matrix.orig
    if (o?.E && o?.N && o?.H) return { E: o.E, N: o.N, H: o.H }
    return bh ? deriveDiffsFromBH(bh.notes) : { E: [], N: [], H: [] }
  }, [matrix, bh])

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
        <span className="pl-song">{demo.meta.song}</span>
      </div>
      <div className="pl-body">
        {tab === 'audio' && <StemsView demo={demo} matrix={matrix} diffs={diffs} />}
        {tab === 'gameplay' && <GameplayGridView matrix={matrix} diffs={diffs} duration={demo.meta.fullDuration} />}
        {tab === 'combined' && <CombinedView matrix={matrix} duration={demo.meta.fullDuration} />}
        {tab === 'merge' && (
          <MergeView diffs={diffs} sections={demo.sectionsFull} duration={demo.meta.fullDuration} real={!!matrix.orig?.E} />
        )}
      </div>
    </div>
  )
}
