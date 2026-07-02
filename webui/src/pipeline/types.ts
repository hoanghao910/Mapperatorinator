// ── Pipeline demo data (reuses the slide deck's real Beat It assets) ──

export interface DemoMeta {
  song: string
  bpm: number
  nLanes: number
  clipStart: number   // s into the full song where the clip begins
  clipLen: number     // clip length (s)
  fullDuration: number
}

export interface Section {
  start: number
  end: number
  label: string
  color?: string
}

export interface DemoData {
  meta: DemoMeta
  peaks: Record<string, number[]> // orig, vocals, drums, bass, other
  notes: { t: number; lane: number; type: string; strong: boolean; end: number | null }[]
  sectionsFull: Section[]
  sectionsClip: Section[]
  accentsClip: { t: number; kind: string; s: number }[]
  beatsClip: number[]
  counts: { notes: number; strong: number; sections: number; accents: number }
}

// BH chart (Tiles-Hop): time in seconds, lanes 1..5 play + 9 meta.
export interface BHNote {
  type: string                 // 'short' | 'long'
  time: number                 // seconds
  variant: string              // '' | 'strong'
  lane: number
  controls?: { time: number; lane: number }[]
  metas?: { key: string; value: string }[]
}
export interface BHChart {
  notes: BHNote[]
  songMeta?: Record<string, unknown>
}

export interface Analysis {
  duration: number
  bpm: number
  beats: number[]
  sections: Section[]
}

// A note normalized for the 5-lane falling-note field.
export interface FieldNote {
  t: number          // clip-relative seconds
  end: number | null // clip-relative seconds for holds
  lane: number       // 1..5
  strong: boolean
}
