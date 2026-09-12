/**
 * Shaping text with the browser's own layout engine.
 *
 * Satori reimplements text layout — yoga for boxes, harfbuzz for shaping,
 * opentype.js for the font — because on Node there is nothing else. In a
 * browser that machinery is already present, already correct, and already has
 * the fonts. Measuring what it produces is both more faithful than a
 * reimplementation and dramatically cheaper: no font bytes, so no fetching, so
 * nothing for CORS or a `font-src` policy to refuse, and no 430 KB of Satori in
 * the bundle.
 *
 * It also sidesteps the format problem. The Google Fonts CSS API answers a real
 * browser with WOFF2, which `@shuding/opentype.js` cannot parse — but the
 * browser reads it natively, so a font we could never hand to Satori can still
 * be measured here.
 *
 * What this cannot do is produce font *bytes*, so `fontDelivery: 'inline'` has
 * nothing to embed. That is reported rather than hidden.
 */
import { needsSpacePreserved } from './satoriPostprocess.js'
import type { VNode } from '../html/toVdom.js'
import type { TextRun } from './place.js'

/** A measured piece of text, with everything needed to draw it as SVG. */
export interface ShapedRun extends TextRun {
  text: string
  fontFamily: string
  fontSize: number
  fontWeight: string
  fontStyle: string
  fill: string
  /** Letter spacing, when the label asked for any. */
  letterSpacing?: number
}

/**
 * Whitespace CSS's white-space processing acts on.
 *
 * The same set `toVdom` collapses against, and deliberately not `\s`: U+3000
 * is an ordinary character to CSS, and draw.io indents Japanese with it.
 */
const COLLAPSIBLE_ONLY = /^[ \t\n\r\f]+$/

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}

/** CSS property names arrive camel-cased from `toVdom`; the DOM wants them hyphenated. */
function cssName(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/**
 * CSS properties whose numeric values carry no unit.
 *
 * `toVdom` writes styles in the convention Satori and React share, where a bare
 * number means pixels — *except* for these, where it means what CSS says it
 * means. `lineHeight: 1.2` is a multiplier of the font size, so rendering it as
 * `line-height: 1.2px` collapses every line box to a pixel and stacks the
 * baselines 1.2px apart instead of 14.4. That placed multi-line labels 6.6px
 * wrong, and looked like a baseline-arithmetic bug rather than a unit one.
 */
const UNITLESS = new Set([
  'lineHeight',
  'fontWeight',
  'opacity',
  'zIndex',
  'flex',
  'flexGrow',
  'flexShrink',
  'order',
])

function styleString(style: Record<string, string | number> | undefined): string {
  const declarations = Object.entries(style ?? {}).map(([property, value]) => {
    const rendered =
      typeof value === 'number' && !UNITLESS.has(property) ? `${value}px` : String(value)
    return `${cssName(property)}:${rendered}`
  })

  // Satori's flex defaults are not CSS's. `flex-direction` defaults to `column`
  // there and to `row` here, so a tree built for Satori — where the root is a
  // bare `display: flex` holding one child per line — lays its lines out side
  // by side in a real browser instead of stacking them. That produced baselines
  // 1.2px apart where they should have been a line-height apart, and placed
  // every multi-line label 6.6px wrong.
  if (style?.['display'] === 'flex' && style['flexDirection'] === undefined) {
    declarations.push('flex-direction:column')
  }
  return declarations.join(';')
}

/**
 * Render one child, giving a run of pure whitespace an element of its own.
 *
 * Flexbox wraps each contiguous sequence of child text runs in an anonymous
 * flex item — *except* one that is nothing but whitespace, which is not
 * rendered at all, and that holds even under `white-space: pre` (CSS Flexbox 1
 * §4). Satori does not implement the rule, so the same tree laid out one way
 * there and another here: draw.io puts a code block's indentation in a `<span>`
 * of its own, `toVdom` gives that run its own flex item, and the browser
 * collapsed it to zero width — leaving every nested line of a `pre` JSON block
 * flush against the margin while Satori indented it correctly.
 *
 * An element child is a flex item whatever it contains, so wrapping restores
 * the width. It changes nothing for text that has ink in it, which already gets
 * an anonymous item.
 */
function childToHtml(child: VNode | string): string {
  if (typeof child === 'string' && COLLAPSIBLE_ONLY.test(child)) {
    return `<span>${escapeText(child)}</span>`
  }
  return vnodeToHtml(child)
}

/**
 * Render the vdom `toVdom` built into HTML.
 *
 * The same tree Satori would have consumed, so the scaffold stripping, CSS
 * normalisation and `light-dark()` handling are all shared rather than
 * reimplemented — only the thing that measures it differs.
 */
export function vnodeToHtml(node: VNode | string): string {
  if (typeof node === 'string') return escapeText(node)

  const style = styleString(node.props.style)
  const children = node.props.children
  const inner =
    children === undefined
      ? ''
      : Array.isArray(children)
        ? children.map((child) => childToHtml(child)).join('')
        : childToHtml(children)

  return `<${node.type}${style === '' ? '' : ` style="${escapeAttribute(style)}"`}>${inner}</${node.type}>`
}

/**
 * The distance from the top of a line box to the baseline.
 *
 * A browser centres the font's em box inside the line box and puts the baseline
 * `ascent` below the top of that em box — the "half-leading" model. `measureText`
 * is the only way to read the font's own ascent and descent, and it needs no
 * font file to do it.
 */
function baselineOffset(
  context: CanvasRenderingContext2D,
  font: string,
  lineHeight: number,
): number {
  context.font = font
  const metrics = context.measureText('Hxy')
  const ascent = metrics.fontBoundingBoxAscent
  const descent = metrics.fontBoundingBoxDescent
  if (!Number.isFinite(ascent) || !Number.isFinite(descent)) return lineHeight * 0.8
  return (lineHeight - (ascent + descent)) / 2 + ascent
}

/** The CSS shorthand `measureText` wants, built from a computed style. */
function shorthand(style: CSSStyleDeclaration): string {
  return `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
}

/**
 * Measure every laid-out run of text inside `root`.
 *
 * `Range.getClientRects()` returns one rectangle per *line box*, so a text node
 * that wrapped comes back already split at the points the browser chose — which
 * is exactly the granularity an SVG `<text>` element needs. Splitting it
 * ourselves would mean reimplementing line breaking, which is the thing being
 * avoided.
 */
export function measureRuns(
  root: HTMLElement,
  context: CanvasRenderingContext2D,
): ShapedRun[] {
  const origin = root.getBoundingClientRect()
  const runs: ShapedRun[] = []

  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    if (text.trim() === '') continue

    const parent = node.parentElement
    if (parent === null) continue
    const style = getComputedStyle(parent)
    const font = shorthand(style)
    const fontSize = Number.parseFloat(style.fontSize)
    const spacing = Number.parseFloat(style.letterSpacing)

    const range = root.ownerDocument.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0)

    // One rect per line box. Mapping text back onto them by proportion is only
    // safe for a single rect; for wrapped text each line is measured on its own
    // by walking characters until the width matches.
    if (rects.length === 1) {
      const rect = rects[0]!
      runs.push({
        x: rect.left - origin.left,
        y: rect.top - origin.top + baselineOffset(context, font, rect.height),
        width: rect.width,
        height: rect.height,
        text,
        fontFamily: style.fontFamily,
        fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        fill: style.color,
        ...(Number.isFinite(spacing) && spacing !== 0 ? { letterSpacing: spacing } : {}),
      })
      continue
    }

    const slices = lineSlices(node as Text, rects.length)
    for (const [index, rect] of rects.entries()) {
      const slice = slices[index] ?? ''
      if (slice.trim() === '') continue
      runs.push({
        x: rect.left - origin.left,
        y: rect.top - origin.top + baselineOffset(context, font, rect.height),
        width: rect.width,
        height: rect.height,
        text: slice,
        fontFamily: style.fontFamily,
        fontSize,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        fill: style.color,
        ...(Number.isFinite(spacing) && spacing !== 0 ? { letterSpacing: spacing } : {}),
      })
    }
    range.detach()
  }

  return runs
}

/**
 * Split a text node at the points the browser chose to break it.
 *
 * The browser will not say where it broke, so the boundaries are found by
 * asking: what is the longest prefix that still occupies a single line box?
 * Binary search answers that in `log n` layout queries per line, where walking
 * character by character costs one forced layout per character — on a long
 * wrapped paragraph the difference is hundreds of reflows against a couple of
 * dozen.
 *
 * Only called for text that actually wrapped; `toVdom` has already split on
 * `<br>` and block boundaries, so most labels never reach this.
 */
function lineSlices(node: Text, lines: number): string[] {
  const text = node.nodeValue ?? ''
  const probe = node.ownerDocument.createRange()
  const slices: string[] = []
  let start = 0

  try {
    for (let line = 0; line < lines - 1; line += 1) {
      let low = start + 1
      let high = text.length
      let best = start + 1

      while (low <= high) {
        const middle = (low + high) >> 1
        probe.setStart(node, start)
        probe.setEnd(node, middle)
        if (probe.getClientRects().length <= 1) {
          best = middle
          low = middle + 1
        } else {
          high = middle - 1
        }
      }

      slices.push(text.slice(start, best))
      start = best
    }
  } finally {
    probe.detach()
  }

  slices.push(text.slice(start))
  return slices
}

/** Draw the measured runs as SVG `<text>`. */
export function runsToSvg(runs: readonly ShapedRun[], round: (value: number) => number): string {
  return runs
    .map((run) => {
      // The computed style is a whole stack — `Helvetica, sans-serif` — so the
      // first entry has to be taken *before* deciding whether it needs quoting.
      // Testing the stack instead quotes single-word families, because the
      // comma-space makes every stack look multi-word.
      const first = run.fontFamily.split(',')[0]!.replace(/["']/g, '').trim()
      const family = first.includes(' ') ? `&apos;${first}&apos;` : first
      const attributes = [
        `x="${round(run.x)}"`,
        `y="${round(run.y)}"`,
        `width="${round(run.width)}"`,
        `height="${round(run.height)}"`,
        `font-family="${family}"`,
        `font-size="${round(run.fontSize)}"`,
        run.fontWeight === '400' || run.fontWeight === 'normal'
          ? ''
          : `font-weight="${run.fontWeight}"`,
        run.fontStyle === 'normal' ? '' : `font-style="${run.fontStyle}"`,
        `fill="${escapeAttribute(run.fill)}"`,
        run.letterSpacing === undefined ? '' : `letter-spacing="${round(run.letterSpacing)}"`,
        // SVG collapses whitespace in `<text>` the way HTML does, so without
        // this a `white-space: pre` run loses its indentation. The same
        // predicate the Satori path uses, rather than substituting NBSP:
        // measuring one character and drawing another left the output text no
        // longer byte-identical to the label's, and an NBSP-only run no longer
        // looked blank to `postprocessSatori`, so it survived as a ghost
        // element.
        needsSpacePreserved(run.text) ? 'xml:space="preserve"' : '',
      ].filter((part) => part !== '')
      return `<text ${attributes.join(' ')}>${escapeText(run.text)}</text>`
    })
    .join('')
}
