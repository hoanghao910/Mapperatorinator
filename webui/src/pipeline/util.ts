import { parseOsu } from '../osu/parseOsu'
import { laneOf } from '../lib/lanes'
import { BHChart, FieldNote, Section } from './types'

export interface DiffNote { time: number; lane: number; strong: boolean; end?: number } // times in s (end set for holds/LNs), lane 1..5
export interface Diffs { E: DiffNote[]; N: DiffNote[]; H: DiffNote[] }

// 3×5 map matrix: maps[source][level] = notes. source ∈ orig|vocals|drums|bass|other, level ∈ E|N|H.
export type Level = 'E' | 'N' | 'H'
export type Source = 'orig' | 'vocals' | 'drums' | 'bass' | 'other'
export const SOURCES: Source[] = ['orig', 'vocals', 'drums', 'bass', 'other']
export const LEVELS: Level[] = ['E', 'N', 'H']
export const SOURCE_COLOR: Record<Source, string> = {
  orig: '#cbd5e1', vocals: '#ec4899', drums: '#f59e0b', bass: '#6366f1', other: '#14b8a6',
}
export const SOURCE_LABEL: Record<Source, string> = {
  orig: 'Original', vocals: 'Vocals', drums: 'Drums', bass: 'Bass', other: 'Other',
}
export const LEVEL_LABEL: Record<Level, string> = { E: 'Easy', N: 'Normal', H: 'Hard' }
export type MapMatrix = Partial<Record<Source, Partial<Record<Level, DiffNote[]>>>>

// Combined decomposition: tag each original note with the stem whose map has the
// nearest note in time (within tol seconds), else 'orig'. Shows how the full
// chart is built from the stems.
export function combineByStem(
  orig: DiffNote[],
  stems: Partial<Record<Source, DiffNote[]>>,
  tol = 0.045,
): { note: DiffNote; src: Source }[] {
  const srcs: Source[] = ['drums', 'bass', 'vocals', 'other'] // priority on ties
  return orig.map((n) => {
    let best: Source = 'orig'
    let bd = Infinity
    for (const s of srcs) {
      const arr = stems[s]
      if (!arr) continue
      for (const m of arr) {
        const d = Math.abs(m.time - n.time)
        if (d < bd) { bd = d; best = s }
        else if (m.time - n.time > bd) break // arr is time-sorted
      }
    }
    return { note: n, src: bd <= tol ? best : 'orig' }
  })
}

// Derive 3 difficulty note-sets from one BH chart (demo proxy).
export function deriveDiffsFromBH(notes: BHChart['notes']): Diffs {
  const play = notes.filter((n) => n.lane >= 1 && n.lane <= 5)
  const endOf = (n: BHChart['notes'][number]): number | undefined =>
    n.type === 'long' && n.controls?.length ? n.controls[n.controls.length - 1].time : undefined
  const toN = (arr: typeof play): DiffNote[] =>
    arr.map((n) => ({ time: n.time, lane: n.lane, strong: n.variant === 'strong', end: endOf(n) }))
  return {
    E: toN(play.filter((n) => n.variant === 'strong')),
    N: toN(play.filter((n, i) => n.variant === 'strong' || i % 2 === 0)),
    H: toN(play),
  }
}

// Parse a generated .osu chart into 5-lane (BH-style) difficulty notes; lane from osu x.
export function osuToDiffNotes(osuText: string): DiffNote[] {
  const bm = parseOsu(osuText)
  return bm.hitObjects.map((o) => ({
    time: o.time / 1000,
    lane: laneOf(o.x),
    strong: false,
    // sliders (std) and mania holds (type 128) carry endTime > time → hold bar.
    end: o.endTime > o.time ? o.endTime / 1000 : undefined,
  }))
}

// Section label → color (matches the slide palette).
const SECTION_COLORS: Record<string, string> = {
  intro: '#3b82f6',
  outro: '#3b82f6',
  verse: '#22c55e',
  chorus: '#f59e0b',
  bridge: '#a855f7',
  break: '#64748b',
  inst: '#14b8a6',
  solo: '#ec4899',
}
export function sectionColor(label: string): string {
  return SECTION_COLORS[label.toLowerCase()] ?? '#64748b'
}

export function sectionAt(sections: Section[], t: number): Section | null {
  for (const s of sections) if (t >= s.start && t < s.end) return s
  return null
}

// Slice the BH chart to the clip window and normalize to 5-lane field notes.
export function bhToFieldNotes(chart: BHChart, clipStart: number, clipLen: number): FieldNote[] {
  const out: FieldNote[] = []
  for (const n of chart.notes) {
    if (n.lane < 1 || n.lane > 5) continue // skip meta lane 9
    const t = n.time - clipStart
    let end: number | null = null
    if (n.type === 'long' && n.controls && n.controls.length) {
      end = n.controls[n.controls.length - 1].time - clipStart
    }
    const refEnd = end ?? t
    if (refEnd < 0 || t > clipLen) continue // outside the window
    out.push({ t, end, lane: n.lane, strong: n.variant === 'strong' })
  }
  return out.sort((a, b) => a.t - b.t)
}

export function fmtSec(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const f = Math.floor((s % 1) * 10)
  return `${m}:${sec.toString().padStart(2, '0')}.${f}`
}
