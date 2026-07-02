// ── Beatmap (parsed from .osu) ──
export type HitKind = 'circle' | 'slider' | 'spinner'

export interface HitObject {
  x: number
  y: number
  time: number          // ms
  kind: HitKind
  newCombo: boolean
  endTime: number       // == time for circle; slider/spinner end
  points?: { x: number; y: number }[] // slider control points (head first)
  curveType?: string                  // B | P | C | L
  slides?: number
  length?: number                     // slider pixel length
}

export interface TimingPoint {
  time: number
  beatLength: number    // ms per beat (uninherited only)
  uninherited: boolean
}

export interface Beatmap {
  title: string
  artist: string
  version: string
  mode: number
  audioFilename: string
  cs: number
  ar: number
  od: number
  hp: number
  sliderMultiplier: number
  timingPoints: TimingPoint[]
  hitObjects: HitObject[]
  duration: number      // ms (last object end)
}

// ── Analysis (from mai_mod json_output) ──
export interface FindingEvent {
  type: string
  value: number
  str: string
}

export interface Finding {
  category: string
  time: number
  timestamp_time: number | null
  combo_index: number | null
  surprisal: number
  importance: number    // surprisal/10, the value shown in the text UI
  context_type: string
  group_type: string | null
  group_str: string
  previous_group_str: string
  x: number | null
  y: number | null
  actual: FindingEvent
  expected: FindingEvent
  explanation: string
}

export interface Analysis {
  beatmap_path: string
  audio_path: string
  mode: number
  title: string
  artist: string
  version: string
  count: number
  categories: string[]
  suggestions: Finding[]
}
