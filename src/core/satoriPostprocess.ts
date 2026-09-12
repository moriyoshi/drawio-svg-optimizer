/**
 * Tidy the SVG Satori emits.
 *
 * `embedFont: false` gives us real `<text>`, which is what we want, but the
 * surrounding output is wasteful and in one respect wrong:
 *
 *  - Every word becomes its own `<text>`, each repeating `font-family`,
 *    `font-size`, `fill`, `font-weight` and `font-style`. A three-word label
 *    costs about 540 bytes of attributes to say one thing.
 *  - `width` and `height` are written on `<text>`, where SVG ignores them; they
 *    are Satori's layout bookkeeping leaking into the output.
 *  - Overflow masks are emitted as `<mask id="satori_om-id">` with a *fixed*
 *    id. Converting nineteen labels therefore produces nineteen elements
 *    sharing one id, which is invalid — and they are unreferenced anyway.
 *  - Coordinates carry float noise such as `height="14.399999999999999"`.
 */

interface Run {
  attributes: Record<string, string>
  text: string
}

/** Attributes that describe how a run is painted rather than where it sits. */
const PRESENTATION = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'fill',
  'fill-opacity',
  'letter-spacing',
  'text-decoration',
  'opacity',
] as const

/**
 * Whitespace SVG's own text processing would eat.
 *
 * With the default `xml:space="default"`, an SVG renderer strips leading and
 * trailing spaces from a `<text>` and collapses internal runs to one — so
 * `<text x="0">    {</text>` draws `{` flush at x=0 and the indentation of a
 * `white-space: pre` code block disappears. Only U+0020, tab, CR and LF are
 * affected; U+3000 is an ordinary character and survives, which is why the
 * ideographic indents of Japanese labels never showed this.
 */
export function needsSpacePreserved(text: string): boolean {
  return /^[ \t\n\r]|[ \t\n\r]$|[ \t\n\r]{2,}|[\t\n\r]/.test(text)
}

/** True when a run would draw nothing at all. */
function isBlank(text: string): boolean {
  return text.length > 0 && /^[ \t\n\r]+$/.test(text)
}

/** Layout bookkeeping SVG does not read on `<text>`. */
const IGNORED_ON_TEXT = new Set(['width', 'height'])

/** Values equal to the SVG default, so writing them costs bytes and says nothing. */
const DEFAULTS: Record<string, string> = {
  'font-style': 'normal',
  'font-weight': 'normal',
  'fill-opacity': '1',
  opacity: '1',
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) {
    attributes[match[1]!] = match[2]!
  }
  return attributes
}

function round(value: string, precision: number): string {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return value
  return String(Math.round(numeric * 10 ** precision) / 10 ** precision)
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unescapeText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

function samePresentation(a: Run, b: Run): boolean {
  return PRESENTATION.every((name) => a.attributes[name] === b.attributes[name])
}

/**
 * Merge runs that sit on one baseline, share a style, and abut horizontally.
 *
 * SVG advances the text cursor by the font's own metrics, which is exactly what
 * Satori used to compute these positions, so a merged run lands where the pieces
 * did. The tolerance covers rounding only — a real gap (a tab stop, a positioned
 * span) exceeds it and keeps the runs separate.
 */
function mergeRuns(runs: Run[], tolerance: number): Run[] {
  const merged: Run[] = []

  for (const run of runs) {
    const previous = merged.at(-1)
    if (previous === undefined || !samePresentation(previous, run)) {
      merged.push(run)
      continue
    }

    const sameLine = previous.attributes['y'] === run.attributes['y']
    const expected = Number(previous.attributes['x']) + Number(previous.attributes['width'] ?? '0')
    const actual = Number(run.attributes['x'])
    if (!sameLine || !Number.isFinite(expected) || Math.abs(expected - actual) > tolerance) {
      merged.push(run)
      continue
    }

    previous.text += run.text
    previous.attributes['width'] = String(
      Number(previous.attributes['width'] ?? '0') + Number(run.attributes['width'] ?? '0'),
    )
  }

  return merged
}

export interface PostprocessOptions {
  /** Decimal places kept on coordinates. @default 2 */
  precision?: number
  /** Maximum gap, in px, still treated as abutting when merging runs. @default 0.05 */
  mergeTolerance?: number
}

/**
 * Rewrite a Satori fragment into compact, valid SVG.
 *
 * Returns the body plus the attributes that were common to every run, so the
 * caller can hoist them onto the wrapping `<g>` and pay for them once.
 */
export function postprocessSatori(
  fragment: string,
  options: PostprocessOptions = {},
): { body: string; groupAttributes: Record<string, string> } {
  const precision = options.precision ?? 2
  const tolerance = options.mergeTolerance ?? 0.05

  // Masks are unreferenced and share a fixed id across labels; drop them.
  let working = fragment.replace(/<mask\b[^>]*>[\s\S]*?<\/mask>/g, '')
  working = working.replace(/<mask\b[^>]*\/>/g, '')

  const runs: Run[] = []
  const others: string[] = []
  const textPattern = /<text\b([^>]*)>([\s\S]*?)<\/text>/g

  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = textPattern.exec(working)) !== null) {
    const between = working.slice(lastIndex, match.index).trim()
    if (between !== '') others.push(between)
    runs.push({ attributes: parseAttributes(match[1]!), text: unescapeText(match[2]!) })
    lastIndex = textPattern.lastIndex
  }
  const trailing = working.slice(lastIndex).trim()
  if (trailing !== '') others.push(trailing)

  if (runs.length === 0) return { body: working, groupAttributes: {} }

  // Merge first, so an ordinary word space folds into its neighbours and
  // "Countac" + " " + "Proxy" stays a single element. Only then drop what is
  // still nothing but collapsible whitespace: a run of its own, left over
  // because its neighbours are styled differently — a code block's indent
  // between two coloured tokens, say. Those draw no ink, and every remaining run
  // carries its own absolute position, so the spacing they stood for is already
  // expressed by where the next run starts. On the reference export this removes
  // 22 elements that draw nothing.
  const merged = mergeRuns(runs, tolerance).filter((run) => !isBlank(run.text))
  if (merged.length === 0) return { body: working, groupAttributes: {} }

  // Anything identical on every run belongs on the parent instead.
  const groupAttributes: Record<string, string> = {}
  for (const name of PRESENTATION) {
    const value = merged[0]!.attributes[name]
    if (value === undefined) continue
    if (merged.every((run) => run.attributes[name] === value)) groupAttributes[name] = value
  }

  const body = merged
    .map((run) => {
      const parts: string[] = []
      for (const [name, value] of Object.entries(run.attributes)) {
        if (IGNORED_ON_TEXT.has(name)) continue
        // Re-derived below. Merging changes what a run's text is, so an
        // incoming `xml:space` from the browser path describes the pieces
        // rather than the run, and copying it would also emit it twice.
        if (name === 'xml:space') continue
        if (groupAttributes[name] === value) continue
        if (DEFAULTS[name] === value) continue
        parts.push(`${name}="${name === 'x' || name === 'y' ? round(value, precision) : value}"`)
      }
      // Without this the renderer trims the indentation off a pre-formatted run.
      if (needsSpacePreserved(run.text)) parts.push('xml:space="preserve"')
      return `<text ${parts.join(' ')}>${escapeText(run.text)}</text>`
    })
    .join('')

  for (const [name, value] of Object.entries(groupAttributes)) {
    if (DEFAULTS[name] === value) delete groupAttributes[name]
  }

  return { body: others.join('') + body, groupAttributes }
}
