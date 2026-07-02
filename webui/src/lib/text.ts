// Strip Rich console markup (e.g. [link=...]..[/link], [bold red]..[/bold red])
// that mai_mod embeds in some strings, so the web UI shows clean text.
export function stripMarkup(s: string): string {
  return s.replace(/\[\/?[a-z][^\]]*\]/gi, '')
}
