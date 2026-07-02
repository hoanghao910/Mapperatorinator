// osu! playfield is 512 x 384 osu!pixels.
export const PLAYFIELD_W = 512
export const PLAYFIELD_H = 384

/** Circle radius in osu!pixels from Circle Size. */
export function csRadius(cs: number): number {
  return 54.4 - 4.48 * cs
}

/** Approach-circle preempt (ms before hit time the object appears) from AR. */
export function arPreempt(ar: number): number {
  if (ar < 5) return 1200 + (600 * (5 - ar)) / 5
  if (ar > 5) return 1200 - (750 * (ar - 5)) / 5
  return 1200
}

/** mm:ss:mmm timestamp used by osu! editor. */
export function fmtTime(ms: number): string {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms / 1000) % 60)
  const f = Math.floor(ms % 1000)
  return `${pad(m)}:${pad(s)}:${pad(f, 3)}`
}

function pad(n: number, w = 2): string {
  return Math.max(0, n).toString().padStart(w, '0')
}
