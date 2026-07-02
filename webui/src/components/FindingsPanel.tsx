import { useMemo, useState } from 'react'
import { Finding } from '../types'
import { sevColor, sevLabel } from '../lib/severity'
import { fmtTime } from '../lib/osuMath'
import { stripMarkup } from '../lib/text'

interface Props {
  findings: Finding[]
  selected: Finding | null
  onSelect: (f: Finding) => void
}

/** Findings grouped by category, sorted by importance, click to seek + highlight. */
export default function FindingsPanel({ findings, selected, onSelect }: Props) {
  const [minImp, setMinImp] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const by: Record<string, Finding[]> = {}
    for (const f of findings) {
      if (f.importance < minImp) continue
      ;(by[f.category] ??= []).push(f)
    }
    for (const k of Object.keys(by)) by[k].sort((a, b) => b.importance - a.importance)
    return Object.entries(by).sort((a, b) => b[1].length - a[1].length)
  }, [findings, minImp])

  const shown = groups.reduce((n, [, fs]) => n + fs.length, 0)

  return (
    <div className="findings-panel">
      <div className="findings-head">
        <span>{shown} / {findings.length} findings</span>
        <label className="imp-filter">
          min severity
          <select value={minImp} onChange={(e) => setMinImp(+e.target.value)}>
            <option value={0}>all</option>
            <option value={10}>notable (≥10)</option>
            <option value={100}>issues (≥100)</option>
          </select>
        </label>
      </div>

      <div className="findings-scroll">
        {groups.map(([cat, fs]) => (
          <div key={cat} className="finding-group">
            <button
              className="finding-group-head"
              onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
            >
              <span className={`chev ${collapsed[cat] ? 'closed' : ''}`}>▾</span>
              {cat} <span className="count">{fs.length}</span>
            </button>
            {!collapsed[cat] &&
              fs.map((f, i) => (
                <button
                  key={i}
                  className={`finding-item ${f === selected ? 'sel' : ''}`}
                  onClick={() => onSelect(f)}
                  title={sevLabel(f.importance)}
                >
                  <span className="sev-dot" style={{ background: sevColor(f.importance) }}>
                    {f.importance}
                  </span>
                  <span className="finding-body">
                    <span className="finding-line1">
                      <span className="ts">{fmtTime(f.time)}</span>
                      <span className="grp">{f.group_str}</span>
                    </span>
                    <span className="finding-expl">{stripMarkup(f.explanation)}</span>
                  </span>
                </button>
              ))}
          </div>
        ))}
        {shown === 0 && <div className="empty">No findings at this severity.</div>}
      </div>
    </div>
  )
}
