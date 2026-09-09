import { findElements } from '../core/scanner.js'
import type { PassContext } from '../core/types.js'
import { hash32 } from '../util/hash.js'

/**
 * Fold repeated styling into CSS classes.
 *
 * draw.io repeats the same declarations on every shape they apply to —
 * `stroke: light-dark(rgb(0, 0, 0), rgb(255, 255, 255))` sixteen times in one
 * reference export, and the converted code-block runs repeat a `fill` seventy
 * times.
 *
 * Both sources of styling are folded:
 *
 *  - **`style` attributes**, which is where draw.io puts its `light-dark()`
 *    colours.
 *  - **presentation attributes** (`fill`, `stroke`, `font-family`, …), which
 *    carry most of the repetition once labels have become SVG text.
 *
 * This runs on the finished document rather than as an SVGO plugin, for two
 * reasons: the biggest `style` repeats live inside `<foreignObject>`, which is
 * withheld from SVGO (see `core/protect.ts`), and an SVG-level `<style>` does
 * apply to that XHTML, since it is all one document.
 *
 * **Off by default.** It cuts raw bytes substantially but costs a little
 * gzipped size, because gzip already dedupes the repeated strings and class
 * attributes add entropy in their place. Worth enabling for files kept in a
 * repository, embedded in a document, or opened in an editor; not for transfer
 * size over a compressing server.
 */

export interface ConsolidateOptions {
  context: PassContext
  /** Fold styling seen at least this many times. @default 3 */
  minOccurrences?: number
  /** Ignore declarations shorter than this; the class reference costs bytes too. @default 24 */
  minLength?: number
  /**
   * Emit short, unscoped class names.
   *
   * Safe for a standalone file. When the SVG is pasted into an HTML page its
   * `<style>` joins that page's global scope, so the default instead scopes every
   * rule under the root element's id.
   *
   * @default false
   */
  unscoped?: boolean
  /** Also fold repeated `fill`/`stroke`/font presentation attributes. @default true */
  presentationAttributes?: boolean
}

/**
 * Presentation attributes safe to move into a rule.
 *
 * Every one of these is a CSS property with identical meaning, so relocating it
 * changes only the cascade — see `RULE ORDER` below. Geometric attributes
 * (`x`, `d`, `width`, `transform`, …) are deliberately absent: some are not CSS
 * properties at all, and the ones that are behave differently.
 */
const PRESENTATION = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'text-decoration',
  'dominant-baseline',
  'opacity',
  'pointer-events',
  'visibility',
  'color',
] as const

/** `a`, `b`, … `z`, `aa`, `ab`, … — short and stable. */
function className(index: number): string {
  let name = ''
  let n = index
  do {
    name = String.fromCharCode(97 + (n % 26)) + name
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return name
}

interface Tag {
  start: number
  end: number
  attributes: string
}

/**
 * Every tag in the document, skipping the text content of `<style>`.
 *
 * Attribute values are quoted in our own output, so a `>` inside one cannot end
 * a tag early; text content has its `<` escaped for the same reason.
 */
function scanTags(svg: string, skip: Array<{ from: number; to: number }>): Tag[] {
  const tags: Tag[] = []
  const pattern = /<([\w:-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g

  for (const match of svg.matchAll(pattern)) {
    const start = match.index
    if (skip.some((range) => start >= range.from && start < range.to)) continue
    tags.push({ start, end: start + match[0].length, attributes: match[2] ?? '' })
  }
  return tags
}

function readAttribute(attributes: string, name: string): string | undefined {
  const found = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)
  return found === null ? undefined : found[1]
}

/**
 * Properties whose CSS form needs an explicit unit.
 *
 * A presentation attribute may write a bare number — `font-size="12"` means
 * twelve user units — but `font-size: 12` is invalid CSS and the declaration is
 * dropped, leaving the element at the inherited default. That renders the text
 * at 16px instead of 12, which is exactly the sort of thing that looks fine in
 * every structural check and is obvious the moment it is drawn.
 *
 * Only genuine lengths belong here: `stroke-miterlimit`, `font-weight` and the
 * opacities take bare numbers in CSS too, and adding `px` would break them.
 */
const NEEDS_UNIT = new Set(['font-size', 'letter-spacing', 'word-spacing'])

/** Convert an attribute value into its CSS equivalent. */
function cssValue(property: string, value: string): string {
  const decoded = decodeForCss(value)
  if (!NEEDS_UNIT.has(property)) return decoded
  return /^-?[\d.]+$/.test(decoded.trim()) ? `${decoded.trim()}px` : decoded
}

/**
 * Decode the entities an attribute value carries, for use in a `<style>` body.
 *
 * `font-family="&apos;Noto Sans JP&apos;"` is correct in an attribute but wrong
 * inside `<style>`, which is a raw-text element when the SVG is inlined into
 * HTML. An `&` there would also make the file invalid XML as a standalone `.svg`.
 */
function decodeForCss(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** The presentation attributes an element carries, as a declaration block. */
function presentationOf(attributes: string): Array<[string, string]> {
  const found: Array<[string, string]> = []
  for (const name of PRESENTATION) {
    const value = readAttribute(attributes, name)
    if (value !== undefined) found.push([name, value])
  }
  return found
}

export interface ConsolidateResult {
  svg: string
  /** Number of elements that gained a class reference. */
  folded: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function consolidateStyles(svg: string, options: ConsolidateOptions): ConsolidateResult {
  const { context } = options
  const minOccurrences = options.minOccurrences ?? 3
  const minLength = options.minLength ?? 24
  const foldPresentation = options.presentationAttributes ?? true

  // `<style>` bodies are text, not markup; never rewrite inside them.
  const skip = findElements(svg, 'style')
    .filter((span) => !span.selfClosing)
    .map((span) => ({ from: span.innerStart, to: span.innerEnd }))

  const tags = scanTags(svg, skip)

  const styleCounts = new Map<string, number>()
  const presentationCounts = new Map<string, number>()

  for (const tag of tags) {
    const style = readAttribute(tag.attributes, 'style')
    if (style !== undefined && style.trim() !== '' && style.length >= minLength) {
      styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1)
    }

    if (!foldPresentation) continue
    const presentation = presentationOf(tag.attributes)
    if (presentation.length === 0) continue
    const block = presentation.map(([name, value]) => `${name}:${cssValue(name, value)}`).join(';')
    if (block.length < minLength) continue
    presentationCounts.set(block, (presentationCounts.get(block) ?? 0) + 1)
  }

  // Worth folding only when the repeats pay for the rule and the class refs.
  const worthwhile = (block: string, occurrences: number): boolean =>
    occurrences >= minOccurrences && (block.length + 9) * occurrences - block.length - 10 * occurrences > 0

  let index = 0
  const presentationClasses = new Map<string, string>()
  for (const [block, occurrences] of presentationCounts) {
    if (worthwhile(block, occurrences)) presentationClasses.set(block, className(index++))
  }
  const styleClasses = new Map<string, string>()
  for (const [block, occurrences] of styleCounts) {
    if (worthwhile(block, occurrences)) styleClasses.set(block, className(index++))
  }
  if (presentationClasses.size + styleClasses.size === 0) return { svg, folded: 0 }

  const [root] = findElements(svg, 'svg')
  if (root === undefined || root.selfClosing) return { svg, folded: 0 }

  // Scope under the root's id unless asked otherwise; draw.io usually supplies
  // one already, and reusing it keeps the document's own CSS working.
  const rootTag = svg.slice(root.start, root.innerStart)
  let rootId = readAttribute(rootTag, 'id')
  let addRootId = false
  if (!options.unscoped && rootId === undefined) {
    rootId = `dn-${hash32(svg)}`
    addRootId = true
  }
  const prefix = options.unscoped || rootId === undefined ? '' : `#${rootId} `

  let folded = 0
  const edits: Array<{ start: number; end: number; text: string }> = []

  for (const tag of tags) {
    const names: string[] = []
    let rewritten = tag.attributes

    if (foldPresentation) {
      const presentation = presentationOf(tag.attributes)
      const block = presentation.map(([name, value]) => `${name}:${cssValue(name, value)}`).join(';')
      const name = presentationClasses.get(block)
      if (name !== undefined) {
        for (const [attribute, value] of presentation) {
          rewritten = rewritten.replace(
            new RegExp(`\\s${attribute}="${escapeRegExp(value)}"`),
            '',
          )
        }
        names.push(name)
      }
    }

    const style = readAttribute(tag.attributes, 'style')
    const styleName = style === undefined ? undefined : styleClasses.get(style)
    if (styleName !== undefined && style !== undefined) {
      rewritten = rewritten.replace(new RegExp(`\\sstyle="${escapeRegExp(style)}"`), '')
      names.push(styleName)
    }

    if (names.length === 0) continue

    const existing = readAttribute(tag.attributes, 'class')
    rewritten =
      existing === undefined
        ? `${rewritten} class="${names.join(' ')}"`
        : rewritten.replace(` class="${existing}"`, ` class="${existing} ${names.join(' ')}"`)

    const original = svg.slice(tag.start, tag.end)
    edits.push({ start: tag.start, end: tag.end, text: original.replace(tag.attributes, rewritten) })
    folded += 1
  }

  if (edits.length === 0) return { svg, folded: 0 }

  // RULE ORDER matters and is the whole reason presentation attributes are safe
  // to fold. A presentation attribute is the *weakest* thing in the author
  // origin — weaker than any selector — while an inline `style` is the
  // strongest. Turning both into classes gives them equal specificity, so the
  // original precedence survives only if the presentation-derived rules come
  // first and the style-derived ones can still win on document order.
  const rules =
    [...presentationClasses].map(([block, name]) => `${prefix}.${name}{${block}}`).join('') +
    [...styleClasses]
      .map(([block, name]) => `${prefix}.${name}{${decodeForCss(block).trim().replace(/;$/, '')}}`)
      .join('')

  let out = svg
  for (const edit of edits.toReversed()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }

  // Recompute the root position: the edits above shifted everything after it.
  const [freshRoot] = findElements(out, 'svg')
  if (freshRoot === undefined) return { svg, folded: 0 }
  out =
    out.slice(0, freshRoot.innerStart) +
    `<style type="text/css">${rules}</style>` +
    out.slice(freshRoot.innerStart)

  if (addRootId) {
    const openTag = out.slice(freshRoot.start, freshRoot.innerStart)
    out =
      out.slice(0, freshRoot.start) +
      openTag.replace(/^<svg/, `<svg id="${rootId}"`) +
      out.slice(freshRoot.innerStart)
  }

  const total = presentationClasses.size + styleClasses.size
  context.warn(
    'styles-consolidated',
    `Folded styling on ${folded} elements into ${total} CSS ${total === 1 ? 'class' : 'classes'}.`,
    prefix === '' ? 'unscoped' : `scoped to #${rootId}`,
  )

  return { svg: out, folded }
}
