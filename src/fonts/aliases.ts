/**
 * Family-name repair and substitution.
 *
 * **Substitutions** swap in a different typeface because the requested one is
 * unavailable. Whether that is safe depends entirely on whether the replacement
 * is metric-compatible: Arimo has Helvetica's advance widths, so text lands in
 * the same place, whereas nothing free matches Lucida Console. A
 * metric-incompatible substitution shifts every glyph and must be reported.
 *
 * There is no longer a repair table. `repairFamily` is kept as part of the
 * `./fonts` surface and the resolver's candidate list, but it only normalises
 * whitespace — it corrects nothing. A family the document names wrongly simply
 * does not resolve, and `needsWideCoverage` keeps a CJK one from being given a
 * Latin substitute, so its labels stay as HTML rather than rendering as tofu.
 */

export interface Substitution {
  family: string
  /** True when the replacement shares the original's advance widths. */
  metricCompatible: boolean
}

/**
 * Replacements for families we cannot obtain, keyed by lowercased name.
 *
 * The metric-compatible entries are the Chrome OS core fonts, commissioned
 * precisely to drop into these slots without reflowing text.
 */
const SUBSTITUTIONS: ReadonlyMap<string, Substitution> = new Map([
  ['helvetica', { family: 'Arimo', metricCompatible: true }],
  ['helvetica neue', { family: 'Arimo', metricCompatible: true }],
  ['arial', { family: 'Arimo', metricCompatible: true }],
  ['times', { family: 'Tinos', metricCompatible: true }],
  ['times new roman', { family: 'Tinos', metricCompatible: true }],
  ['courier', { family: 'Cousine', metricCompatible: true }],
  ['courier new', { family: 'Cousine', metricCompatible: true }],
  // No free face matches Lucida Console's metrics; this reflows the text.
  ['lucida console', { family: 'Cousine', metricCompatible: false }],
  ['consolas', { family: 'Cousine', metricCompatible: false }],
  ['monaco', { family: 'Cousine', metricCompatible: false }],
  ['menlo', { family: 'Cousine', metricCompatible: false }],
  ['segoe ui', { family: 'Arimo', metricCompatible: false }],
  ['tahoma', { family: 'Arimo', metricCompatible: false }],
  ['verdana', { family: 'Arimo', metricCompatible: false }],
])

/** Generic CSS families, mapped to the face that stands in for them. */
const GENERIC: ReadonlyMap<string, string> = new Map([
  ['sans-serif', 'Arimo'],
  ['serif', 'Tinos'],
  ['monospace', 'Cousine'],
  ['ui-sans-serif', 'Arimo'],
  ['ui-serif', 'Tinos'],
  ['ui-monospace', 'Cousine'],
  ['system-ui', 'Arimo'],
])

/**
 * Normalise a family name.
 *
 * Kept so the `./fonts` surface and the resolver's candidate list do not have to
 * change shape, but it no longer corrects anything — surrounding whitespace is
 * all it removes.
 */
export function repairFamily(family: string): string {
  return family.trim()
}

export function substituteFamily(family: string): Substitution | undefined {
  const key = family.trim().toLowerCase()
  const generic = GENERIC.get(key)
  if (generic !== undefined) return { family: generic, metricCompatible: false }
  return SUBSTITUTIONS.get(key)
}

/** True for a family whose glyph coverage a Latin face cannot supply. */
export function needsWideCoverage(family: string): boolean {
  return /\b(cjk|jp|sc|tc|kr|hk|japanese|chinese|korean|gothic|mincho|hei|song|kai)\b/i.test(family)
}
