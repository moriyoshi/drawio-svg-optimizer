import type { LabelNode } from './label.js'
import { normalizeStyle } from './normalizeCss.js'
import type { ColorPair } from './normalizeCss.js'

/**
 * Satori's input shape. It accepts JSX elements or these plain objects; it does
 * *not* accept HTML strings, which is why this conversion exists at all.
 */
export interface VNode {
  type: string
  props: {
    style?: Record<string, string | number>
    children?: Array<VNode | string> | VNode | string
  }
}

export interface VdomResult {
  node: VNode
  /** Light colour -> `light-dark()` pair, for restoring dark mode after render. */
  colorPairs: Map<string, ColorPair>
  /** Every font family the tree references. */
  fontFamilies: Set<string>
}

/**
 * Properties that position draw.io's wrapper rather than style its content.
 *
 * These are removed and reapplied as a transform afterwards; see `core/place.ts`
 * for why Satori cannot be trusted to honour them.
 */
const SCAFFOLD_PROPERTIES = [
  'marginLeft',
  'marginTop',
  'paddingTop',
  'height',
  'alignItems',
  'justifyContent',
] as const

/**
 * The characters CSS actually collapses.
 *
 * Deliberately not `\s`: that also matches U+3000 IDEOGRAPHIC SPACE, which CSS
 * treats as an ordinary character. draw.io uses it to indent the continuation
 * lines of Japanese labels, so collapsing it would quietly reflow them.
 */
const COLLAPSIBLE = /[ \t\n\r\f]+/g

/** Style properties a text run inherits from its ancestors. */
const INHERITED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'color',
  'letterSpacing',
  'lineHeight',
  'whiteSpace',
  'textDecoration',
  'textTransform',
] as const

interface Run {
  text: string
  style: Record<string, string | number>
  /** Resolved from the raw CSS, where the unit is still known. */
  lineHeightPx: number
  /**
   * Horizontal alignment of the block that contains this run.
   *
   * `text-align` centres each line *individually*, so it has to reach the
   * column that stacks them. Centring only the block as a whole leaves every
   * line flush left inside it, which moved one label fifteen pixels.
   */
  align: 'flex-start' | 'center' | 'flex-end'
  /**
   * Line-height of the block that contains this run.
   *
   * CSS gives every line box a strut from its *containing block*, so a line is
   * never shorter than that even when every inline box in it is smaller. The
   * code blocks depend on it: their spans say `line-height: 5px` while the div
   * around them says `100%` of an 8px font, and the browser spaces the lines 8px
   * apart. Taking the strut from the outermost wrapper instead would space them
   * by its 14.4px and overflow the shape.
   */
  strutPx: number
}

/**
 * Resolve a `line-height` declaration to pixels.
 *
 * The unit matters and is lost by the time a value reaches Satori, which folds
 * everything into a multiplier. draw.io's code blocks set `line-height: 5px` on
 * spans whose font is 8px — a real length, smaller than the text — while the
 * enclosing div says `line-height: 100%`. Treating the `5` as a multiplier makes
 * lines forty pixels apart; treating a bare `1.2` as pixels crushes them
 * together. So this reads the raw declaration, before normalisation drops it.
 */
function resolveLineHeight(raw: string | undefined, fontSize: number): number | undefined {
  if (raw === undefined) return undefined
  const value = raw.trim().toLowerCase()
  if (value === 'normal') return fontSize * 1.2
  const percent = /^([\d.]+)%$/.exec(value)
  if (percent !== null) return (Number(percent[1]) / 100) * fontSize
  const pixels = /^([\d.]+)px$/.exec(value)
  if (pixels !== null) return Number(pixels[1])
  const multiplier = /^([\d.]+)$/.exec(value)
  if (multiplier !== null) return Number(multiplier[1]) * fontSize
  return undefined
}

function resolveAlign(
  raw: string | undefined,
  inherited: 'flex-start' | 'center' | 'flex-end',
): 'flex-start' | 'center' | 'flex-end' {
  switch (raw?.trim().toLowerCase()) {
    case 'center':
      return 'center'
    case 'right':
    case 'end':
      return 'flex-end'
    case 'left':
    case 'start':
      return 'flex-start'
    default:
      return inherited
  }
}

function resolveFontSize(raw: string | undefined, inherited: number): number {
  if (raw === undefined) return inherited
  const pixels = /^([\d.]+)px$/.exec(raw.trim())
  if (pixels === null) return inherited
  const size = Number(pixels[1])
  // `font-size: 0` is draw.io's wrapper sentinel, not a real size.
  return size === 0 ? inherited : size
}

/**
 * Split a label into lines of styled runs.
 *
 * This exists because Satori has no inline formatting context: `display: block`
 * is mapped onto flex, so every `<span>` and every text node inside a div becomes
 * a *flex item laid out in a row*. A `<br>` cannot break anything, and a
 * syntax-highlighted code block — which is nothing but adjacent styled spans —
 * comes out as one very long line.
 *
 * So the line structure is resolved here instead: the tree is flattened into
 * runs carrying their inherited style, `<br>` starts a new line, and the caller
 * stacks the lines in a column of rows. That is the layout the browser would
 * produce for the markup draw.io emits, which is all `div`, `span` and `br`.
 */
function flattenToLines(
  root: LabelNode,
  pairs: Map<string, ColorPair>,
  families: Set<string>,
): Run[][] {
  const lines: Run[][] = [[]]
  const rootFontSize = resolveFontSize(root.style['font-size'], 12)

  const walk = (
    node: LabelNode,
    inherited: Record<string, string | number>,
    fontSize: number,
    lineHeight: number,
    strut: number,
    align: 'flex-start' | 'center' | 'flex-end',
  ): void => {
    const { style } = normalizeStyle(node.style, pairs)

    const family = style['fontFamily']
    if (typeof family === 'string') {
      for (const each of family.split(',')) {
        const trimmed = each.trim()
        if (trimmed !== '') families.add(trimmed)
      }
    }

    const effective = { ...inherited }
    for (const property of INHERITED) {
      const value = style[property]
      if (value !== undefined) effective[property] = value
    }

    const nextFontSize = resolveFontSize(node.style['font-size'], fontSize)
    const nextLineHeight =
      resolveLineHeight(node.style['line-height'], nextFontSize) ??
      (nextFontSize === fontSize ? lineHeight : nextFontSize * 1.2)
    // Entering a block establishes a new strut for the lines inside it.
    const isBlockNode = node.tag === 'div' || node.tag === 'p' || /^h[1-6]$/.test(node.tag)
    const nextStrut = isBlockNode ? nextLineHeight : strut
    const nextAlign = resolveAlign(node.style['text-align'], align)

    // CSS collapses whitespace unless the run preserves it. This is not a
    // nicety: a pretty-printed export indents its label markup, so the text
    // nodes around each `<span>` are runs of newlines and spaces. Rendering them
    // verbatim pushes every label right by its own indentation.
    const preserves = String(effective['whiteSpace'] ?? '').startsWith('pre')

    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child === '') continue
        const line = lines.at(-1)!
        let text = child
        if (!preserves) {
          text = child.replace(COLLAPSIBLE, ' ')
          // Whitespace at the start of a line box collapses away entirely.
          if (text === ' ' && line.length === 0) continue
        }
        line.push({
          text,
          style: effective,
          lineHeightPx: nextLineHeight,
          strutPx: nextStrut,
          align: nextAlign,
        })
        continue
      }
      if (child.tag === 'br') {
        lines.push([])
        continue
      }
      // A block-level child forces its own line, as it would in the browser.
      const childStyle = normalizeStyle(child.style, pairs).style
      const isBlock =
        child.tag === 'div' || child.tag === 'p' || /^h[1-6]$/.test(child.tag)
      const startsBlock = isBlock && lines.at(-1)!.length > 0 && childStyle['display'] !== 'flex'
      if (startsBlock) lines.push([])
      walk(child, effective, nextFontSize, nextLineHeight, nextStrut, nextAlign)
      if (isBlock && lines.at(-1)!.length > 0) lines.push([])
    }
  }

  walk(root, {}, rootFontSize, rootFontSize * 1.2, 0, 'flex-start')

  // Whitespace at the end of a line box collapses too.
  for (const line of lines) {
    while (line.length > 0) {
      const last = line.at(-1)!
      if (String(last.style['whiteSpace'] ?? '').startsWith('pre')) break
      if (last.text !== ' ') break
      line.pop()
    }
  }

  // Drop trailing empties created by block handling, but keep interior blank
  // lines: draw.io uses them for deliberate spacing.
  while (lines.length > 0 && lines.at(-1)!.length === 0) lines.pop()
  return lines
}

function runNode(run: Run): VNode {
  const style: Record<string, string | number> = { ...run.style }
  // `white-space` is left exactly as the document set it. Forcing `pre` here
  // would preserve spacing at the cost of disabling line wrapping, and CJK text
  // wraps between almost any two characters — a 58px box holding 84px of
  // Japanese becomes two lines in a browser and one long line without it.
  style['display'] = 'flex'
  style['flexShrink'] = 0
  return { type: 'span', props: { style, children: [run.text] } }
}

/**
 * Convert a parsed draw.io label into the tree Satori renders.
 *
 * `boxWidth` is kept on the root so that a single-run line wraps where the
 * browser would wrap it; everything else about the wrapper's position is removed
 * and recomputed later.
 */
export function toVdom(root: LabelNode, boxWidth?: number): VdomResult {
  const colorPairs = new Map<string, ColorPair>()
  const fontFamilies = new Set<string>()
  const lines = flattenToLines(root, colorPairs, fontFamilies)

  const rootStyle = normalizeStyle(root.style, colorPairs).style
  for (const property of SCAFFOLD_PROPERTIES) delete rootStyle[property]
  rootStyle['display'] = 'flex'
  rootStyle['flexDirection'] = 'column'
  // Lines stay full width and align their own contents. Aligning them on the
  // column's cross axis instead would shrink each line to fit its text, leaving
  // no width for the text to wrap against — and CJK wraps between almost any
  // two characters, so a narrow box full of Japanese must be free to break.
  const alignment = lines.flat()[0]?.align ?? 'flex-start'

  // A 1px-wide box is draw.io's way of saying "do not wrap"; anything else is a
  // real wrapping width.
  const wraps = boxWidth !== undefined && boxWidth > 1
  if (wraps) rootStyle['width'] = boxWidth
  else delete rootStyle['width']

  const children: VNode[] = lines.map((runs) => {
    // A line box is as tall as its tallest inline box, but never shorter than
    // its own block's strut — which is what keeps draw.io's 5px code-block spans
    // from overlapping without spacing them by the outer wrapper's 14.4px.
    const height = Math.max(
      ...runs.map((run) => Math.max(run.lineHeightPx, run.strutPx)),
      0,
    )
    const lineStyle: Record<string, string | number> = {
      display: 'flex',
      flexDirection: 'row',
      // Runs of different sizes sit on a shared baseline, as in a text line.
      alignItems: 'baseline',
      justifyContent: alignment,
    }
    if (height > 0) lineStyle['height'] = height
    if (runs.length === 0) {
      // A blank line still occupies its height.
      return { type: 'div', props: { style: { ...lineStyle, height: height || 12 }, children: [' '] } }
    }

    // A lone run may wrap; Satori handles that itself given a width. The
    // wrapped lines are positioned by `text-align`, not by the flex alignment,
    // which only places the box.
    const lonePreserves = String(runs[0]?.style['whiteSpace'] ?? '').startsWith('pre')
    if (runs.length === 1 && wraps && !lonePreserves) {
      const style = { ...runs[0]!.style, display: 'flex', width: boxWidth }
      delete lineStyle['height']
      const textAlign =
        alignment === 'center' ? 'center' : alignment === 'flex-end' ? 'right' : 'left'
      return {
        type: 'div',
        props: { style: { ...lineStyle, ...style, textAlign }, children: [runs[0]!.text] },
      }
    }

    return { type: 'div', props: { style: lineStyle, children: runs.map(runNode) } }
  })

  return {
    node: { type: 'div', props: { style: rootStyle, children } },
    colorPairs,
    fontFamilies,
  }
}
