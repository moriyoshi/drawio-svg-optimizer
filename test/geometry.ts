// svgo does not export its path parser, and the internal module ships no
// declarations. Reaching for it is deliberate: re-implementing path parsing to
// assert geometric losslessness would risk agreeing with a bug in our own copy.
// @ts-expect-error -- untyped svgo internal
import { parsePathData } from '../node_modules/svgo/lib/path.js'

/**
 * Absolute bounding box of every `<path>`, with enclosing transforms applied.
 *
 * The structural pass rewrites path data freely — `M 220 83 L 220 60 L 850 60`
 * becomes `M220 83V60h630`, groups collapse, and a group's transform may end up
 * on the path itself. All of that is supposed to be geometrically identical, and
 * comparing the resolved boxes is the only way to say so with confidence rather
 * than by eye.
 *
 * Only `translate` is resolved, which is all draw.io emits; a fixture that grows
 * a rotation or scale would need this extended rather than trusted.
 */
export function pathBoxes(svg: string): Array<[number, number, number, number]> {
  const boxes: Array<[number, number, number, number]> = []
  const stack: Array<[number, number]> = [[0, 0]]
  const translate = /transform="translate\(\s*([-\d.]*)[\s,]+([-\d.]*)\s*\)"/

  for (const match of svg.matchAll(/<(\/?)([\w:-]+)([^>]*?)(\/?)>/g)) {
    const [, closing, name, attributes, selfClosing] = match

    if (closing === '/') {
      if (name === 'g') stack.pop()
      continue
    }

    if (name === 'g') {
      const found = translate.exec(attributes!)
      const top = stack.at(-1)!
      stack.push(
        found === null
          ? [top[0], top[1]]
          : [top[0] + Number(found[1] || 0), top[1] + Number(found[2] || 0)],
      )
      if (selfClosing === '/') stack.pop()
      continue
    }

    if (name !== 'path') continue
    const data = / d="([^"]*)"/.exec(attributes!)
    if (data === null) continue

    const top = stack.at(-1)!
    let offsetX = top[0]
    let offsetY = top[1]
    // Collapsing a group can move its transform onto the path.
    const own = translate.exec(attributes!)
    if (own !== null) {
      offsetX += Number(own[1] || 0)
      offsetY += Number(own[2] || 0)
    }

    let x = 0
    let y = 0
    let startX = 0
    let startY = 0
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const record = (): void => {
      minX = Math.min(minX, x + offsetX)
      maxX = Math.max(maxX, x + offsetX)
      minY = Math.min(minY, y + offsetY)
      maxY = Math.max(maxY, y + offsetY)
    }

    for (const command of parsePathData(data[1]!) as Array<{ command: string; args: number[] }>) {
      const args = command.args
      const relative = command.command === command.command.toLowerCase()
      switch (command.command.toUpperCase()) {
        case 'M':
          x = relative ? x + args[0]! : args[0]!
          y = relative ? y + args[1]! : args[1]!
          startX = x
          startY = y
          break
        case 'L':
        case 'T':
          x = relative ? x + args[0]! : args[0]!
          y = relative ? y + args[1]! : args[1]!
          break
        case 'H':
          x = relative ? x + args[0]! : args[0]!
          break
        case 'V':
          y = relative ? y + args[0]! : args[0]!
          break
        case 'C':
          x = relative ? x + args[4]! : args[4]!
          y = relative ? y + args[5]! : args[5]!
          break
        case 'S':
        case 'Q':
          x = relative ? x + args[2]! : args[2]!
          y = relative ? y + args[3]! : args[3]!
          break
        case 'A':
          x = relative ? x + args[5]! : args[5]!
          y = relative ? y + args[6]! : args[6]!
          break
        case 'Z':
          x = startX
          y = startY
          break
        default:
          continue
      }
      record()
    }

    boxes.push([minX, minY, maxX, maxY])
  }

  return boxes
}

/** Largest difference between two box lists, or `Infinity` if they differ in length. */
export function maxBoxDelta(
  a: Array<[number, number, number, number]>,
  b: Array<[number, number, number, number]>,
): number {
  if (a.length !== b.length) return Infinity
  let worst = 0
  for (const [index, box] of a.entries()) {
    for (const [corner, value] of box.entries()) {
      worst = Math.max(worst, Math.abs(value - b[index]![corner]!))
    }
  }
  return worst
}

export interface AbsoluteRun {
  text: string
  /** Absolute position, with every ancestor transform applied. */
  x: number
  y: number
  /** Satori's own advance width, present only when `compactText` is off. */
  width: number
  /**
   * Identity of the innermost enclosing `<g>`.
   *
   * Runs must be grouped per label, not per baseline: two unrelated labels
   * sitting at the same height would otherwise be concatenated into one line.
   */
  group: number
}

/**
 * Every `<text>` run with ancestor transforms resolved.
 *
 * Reading the innermost `transform` alone is not enough, and the difference is
 * not academic: draw.io wraps labels in `translate(-0.5 -0.5)` for crisp
 * strokes, so a pass that loses that wrapper shifts all text by half a pixel
 * while every innermost coordinate still looks right.
 */
export function absoluteTextRuns(svg: string): AbsoluteRun[] {
  const runs: AbsoluteRun[] = []
  const stack: Array<[number, number]> = [[0, 0]]
  const groups: number[] = [0]
  let nextGroup = 0
  const translate = /transform="translate\(\s*([-\d.]*)[\s,]+([-\d.]*)\s*\)"/
  const pattern = /<(\/?)([\w:-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g

  let pending: { x: number; y: number; width: number; group: number } | undefined

  for (const match of svg.matchAll(pattern)) {
    const text = match[5]
    if (text !== undefined) {
      if (pending !== undefined) {
        runs.push({
          text,
          x: pending.x,
          y: pending.y,
          width: pending.width,
          group: pending.group,
        })
        pending = undefined
      }
      continue
    }

    const [, closing, name, attributes, selfClosing] = match
    if (closing === '/') {
      if (name === 'g') {
        stack.pop()
        groups.pop()
      }
      continue
    }
    if (name === 'g') {
      const found = translate.exec(attributes!)
      const top = stack.at(-1)!
      stack.push(
        found === null
          ? [top[0], top[1]]
          : [top[0] + Number(found[1] || 0), top[1] + Number(found[2] || 0)],
      )
      nextGroup += 1
      groups.push(nextGroup)
      if (selfClosing === '/') {
        stack.pop()
        groups.pop()
      }
      continue
    }
    if (name !== 'text') continue

    const top = stack.at(-1)!
    const own = translate.exec(attributes!)
    const offsetX = top[0] + (own === null ? 0 : Number(own[1] || 0))
    const offsetY = top[1] + (own === null ? 0 : Number(own[2] || 0))
    pending = {
      x: offsetX + Number(/\bx="([-\d.]+)"/.exec(attributes!)?.[1] ?? 0),
      y: offsetY + Number(/\by="([-\d.]+)"/.exec(attributes!)?.[1] ?? 0),
      width: Number(/\bwidth="([-\d.]+)"/.exec(attributes!)?.[1] ?? 0),
      group: groups.at(-1)!,
    }
  }

  return runs
}
