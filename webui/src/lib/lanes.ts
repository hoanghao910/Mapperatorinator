// Map an osu! x-coordinate (0..512) into one of N falling-note lanes.
// This is a positional conversion (same intuition as osu!->mania): the playfield
// width is split evenly. Tune to match the real BH/MT3 lane assignment later.
export const LANE_COUNT = 5

export function laneOf(x: number, lanes = LANE_COUNT): number {
  const i = Math.floor((x / 512) * lanes)
  return Math.max(0, Math.min(lanes - 1, i))
}

// One color per lane (BH-ish: 5 distinct, readable on dark).
export const LANE_COLORS = ['#ff6b6b', '#ffd166', '#06d6a0', '#5aa0ff', '#c792ea']
