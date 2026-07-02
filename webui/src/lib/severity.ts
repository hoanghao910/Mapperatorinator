// Severity coloring mirrors mai_mod's text UI thresholds (importance = surprisal/10):
// >= 100 likely an issue (red), >= 10 notable (yellow), else subjective (blue).
export function sevColor(importance: number): string {
  if (importance >= 100) return '#ff4d4f'
  if (importance >= 10) return '#f7c948'
  return '#5aa0ff'
}

export function sevTier(importance: number): 'issue' | 'notable' | 'subjective' {
  if (importance >= 100) return 'issue'
  if (importance >= 10) return 'notable'
  return 'subjective'
}

export function sevLabel(importance: number): string {
  const t = sevTier(importance)
  return t === 'issue' ? 'likely issue' : t === 'notable' ? 'notable' : 'subjective'
}
