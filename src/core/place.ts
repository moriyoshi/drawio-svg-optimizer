import type { LabelBox } from '../html/label.js'

/**
 * Placement of Satori-rendered text into diagram coordinates.
 *
 * Satori is used here purely as a text-shaping engine, not as a layout engine
 * for draw.io's positioning scaffold. That scaffold is a degenerate flex box —
 *
 *   width: 628px; height: 1px; padding-top: 72px; margin-left: 221px;
 *   align-items: unsafe center; justify-content: unsafe center;
 *
 * — whose meaning is "centre the label on the point (221 + 628/2, 72)". Yoga
 * does not reproduce a browser's handling of a 1px-high box with an overflowing
 * child: feeding it the scaffold verbatim yields the right `y` but ignores
 * `justify-content`, and removing the height fixes `x` while breaking `y`.
 *
 * So we strip the scaffold, shape the text in a clean box, and compute the
 * offset ourselves. The arithmetic is plain CSS box alignment, and it is checked
 * against draw.io's own `<text>` coordinates in the tests — the one ground truth
 * available for what these labels are supposed to look like.
 */

export interface TextRun {
  x: number
  y: number
  width: number
  height: number
}

export interface ContentBounds {
  left: number
  right: number
  /** Baseline of the first line. */
  firstBaseline: number
  /** Baseline of the last line. */
  lastBaseline: number
  /** Line box height of the first run. */
  lineHeight: number
}

/** Read the geometry of the `<text>` runs Satori emitted. */
export function readTextRuns(fragment: string): TextRun[] {
  const runs: TextRun[] = []
  for (const match of fragment.matchAll(/<text\b([^>]*)>/g)) {
    const attributes = match[1]!
    const read = (name: string): number | undefined => {
      const found = new RegExp(`\\b${name}="([\\d.eE+-]+)"`).exec(attributes)
      return found === null ? undefined : Number(found[1])
    }
    const x = read('x')
    const y = read('y')
    if (x === undefined || y === undefined) continue
    runs.push({ x, y, width: read('width') ?? 0, height: read('height') ?? 0 })
  }
  return runs
}

export function measure(runs: TextRun[]): ContentBounds | undefined {
  if (runs.length === 0) return undefined

  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let firstBaseline = Number.POSITIVE_INFINITY
  let lastBaseline = Number.NEGATIVE_INFINITY
  let lineHeight = 0

  for (const run of runs) {
    left = Math.min(left, run.x)
    right = Math.max(right, run.x + run.width)
    if (run.y < firstBaseline) {
      firstBaseline = run.y
      lineHeight = run.height
    }
    lastBaseline = Math.max(lastBaseline, run.y)
  }

  return { left, right, firstBaseline, lastBaseline, lineHeight }
}

export interface Placement {
  dx: number
  dy: number
}

/**
 * Offset that moves shaped text from render space into diagram space.
 *
 * The content is shaped with no margin or padding, so its block starts at y = 0
 * in render space and the first baseline sits a fixed distance below that.
 * Vertically the box is draw.io's anchor line; with `height: 1px` and
 * `align-items: center`, `(height - contentHeight) / 2` is exactly "centre the
 * text on that line".
 */
export function place(box: LabelBox, bounds: ContentBounds): Placement {
  const contentWidth = bounds.right - bounds.left
  const contentHeight = bounds.lastBaseline - bounds.firstBaseline + bounds.lineHeight

  const horizontal =
    box.justify === 'center'
      ? (box.width - contentWidth) / 2
      : box.justify === 'end'
        ? box.width - contentWidth
        : 0

  const vertical =
    box.align === 'center'
      ? (box.height - contentHeight) / 2
      : box.align === 'end'
        ? box.height - contentHeight
        : 0

  return {
    // `bounds.left` is where the shaper happened to start the text.
    dx: box.marginLeft + horizontal - bounds.left,
    dy: box.paddingTop + vertical,
  }
}
