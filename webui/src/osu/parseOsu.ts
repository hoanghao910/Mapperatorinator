import { Beatmap, HitObject, TimingPoint } from '../types'

/** Parse a .osu file (osu!standard focus) into a Beatmap for rendering. */
export function parseOsu(text: string): Beatmap {
  const lines = text.split(/\r?\n/)
  let section = ''
  const general: Record<string, string> = {}
  const meta: Record<string, string> = {}
  const diff: Record<string, string> = {}
  const uninherited: TimingPoint[] = []
  const inherited: { time: number; sv: number }[] = []
  const hitObjects: HitObject[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('//')) continue
    const sec = line.match(/^\[(.+)\]$/)
    if (sec) {
      section = sec[1]
      continue
    }
    if (section === 'General' || section === 'Metadata' || section === 'Difficulty') {
      const i = line.indexOf(':')
      if (i < 0) continue
      const key = line.slice(0, i).trim()
      const val = line.slice(i + 1).trim()
      if (section === 'General') general[key] = val
      else if (section === 'Metadata') meta[key] = val
      else diff[key] = val
    } else if (section === 'TimingPoints') {
      const p = line.split(',')
      const time = parseFloat(p[0])
      const beatLength = parseFloat(p[1])
      const isUninherited = p[6] === undefined ? true : p[6] === '1'
      if (isUninherited) uninherited.push({ time, beatLength, uninherited: true })
      else inherited.push({ time, sv: -100 / beatLength })
    } else if (section === 'HitObjects') {
      hitObjects.push(parseHit(line))
    }
  }

  const sliderMultiplier = parseFloat(diff['SliderMultiplier'] ?? '1.4')
  uninherited.sort((a, b) => a.time - b.time)
  inherited.sort((a, b) => a.time - b.time)

  const beatLengthAt = (t: number): number => {
    let bl = uninherited[0]?.beatLength ?? 500
    for (const tp of uninherited) {
      if (tp.time <= t) bl = tp.beatLength
      else break
    }
    return bl
  }
  const svAt = (t: number): number => {
    let sv = 1
    for (const ip of inherited) {
      if (ip.time <= t) sv = ip.sv
      else break
    }
    return sv
  }

  // Resolve slider end times from length / slides / SV / beatLength.
  for (const o of hitObjects) {
    if (o.kind === 'slider' && o.length && o.slides) {
      const bl = beatLengthAt(o.time)
      const sv = svAt(o.time)
      const beats = (o.length * o.slides) / (sliderMultiplier * 100 * sv)
      o.endTime = o.time + beats * bl
    }
  }

  const duration = hitObjects.reduce((m, o) => Math.max(m, o.endTime), 0)

  return {
    title: meta['Title'] ?? '',
    artist: meta['Artist'] ?? '',
    version: meta['Version'] ?? '',
    mode: parseInt(general['Mode'] ?? '0', 10),
    audioFilename: general['AudioFilename'] ?? '',
    cs: parseFloat(diff['CircleSize'] ?? '4'),
    ar: parseFloat(diff['ApproachRate'] ?? '9'),
    od: parseFloat(diff['OverallDifficulty'] ?? '8'),
    hp: parseFloat(diff['HPDrainRate'] ?? '5'),
    sliderMultiplier,
    timingPoints: uninherited,
    hitObjects,
    duration,
  }
}

function parseHit(line: string): HitObject {
  const p = line.split(',')
  const x = +p[0]
  const y = +p[1]
  const time = +p[2]
  const type = +p[3]
  const newCombo = (type & 4) !== 0

  if (type & 128) {
    // osu!mania hold / long note: x,y,time,128,hitSound,endTime:hitSample
    // The mania hold bit (128) never collides with the standard slider(2)/
    // spinner(8) bits, so this branch is inert for osu!standard maps. Rendered
    // as a hold bar (kind 'slider') by LaneView; x encodes the column, which
    // laneOf() maps to a lane exactly as for a normal note.
    const endTime = parseInt((p[5] ?? '').split(':')[0], 10)
    return {
      x, y, time, kind: 'slider', newCombo,
      endTime: Number.isFinite(endTime) ? endTime : time,
      points: [{ x, y }],
    }
  }
  if (type & 2) {
    // slider: x,y,time,type,hitSound,curve|p1|p2..,slides,length,...
    const curve = (p[5] ?? '').split('|')
    const curveType = curve[0]
    const points = [{ x, y }]
    for (const seg of curve.slice(1)) {
      const [cx, cy] = seg.split(':')
      points.push({ x: +cx, y: +cy })
    }
    return {
      x, y, time, kind: 'slider', newCombo, endTime: time,
      points, curveType, slides: +(p[6] ?? 1), length: +(p[7] ?? 0),
    }
  }
  if (type & 8) {
    // spinner: x,y,time,type,hitSound,endTime,...
    return { x, y, time, kind: 'spinner', newCombo, endTime: +(p[5] ?? time) }
  }
  return { x, y, time, kind: 'circle', newCombo, endTime: time }
}
