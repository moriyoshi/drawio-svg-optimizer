import { Parser } from 'htmlparser2'

/**
 * A parsed diagrams.net label.
 *
 * draw.io wraps every HTML label in a fixed three-div scaffold:
 *
 *   <div style="display:flex; align-items:unsafe center; justify-content:unsafe center;
 *               width:628px; height:1px; padding-top:72px; margin-left:221px">
 *     <div style="box-sizing:border-box; font-size:0; text-align:center; color:#000">
 *       <div style="display:inline-block; font-size:12px; font-family:Helvetica; ...">TEXT</div>
 *     </div>
 *   </div>
 *
 * The outer div's geometry is the label's layout box, which is what we need to
 * place converted text; the innermost div carries the typography.
 */
export interface LabelNode {
  tag: string
  style: Record<string, string>
  children: Array<LabelNode | string>
}

export interface LabelBox {
  width: number
  height: number
  paddingTop: number
  marginLeft: number
  /** Horizontal placement of the content within the box. */
  justify: 'start' | 'center' | 'end'
  /** Vertical placement of the content relative to the box. */
  align: 'start' | 'center' | 'end'
}

export interface ParsedLabel {
  root: LabelNode | undefined
  /** Visible text, with `<br>` rendered as a newline. */
  text: string
  /** Geometry from the outermost wrapper div, when it matches the known scaffold. */
  box: LabelBox | undefined
  /** Distinct `font-family` values referenced anywhere in the label. */
  fontFamilies: string[]
  /** Element names used, lowercased. */
  tags: Set<string>
  /** True when the label is a single unstyled text run that a <text> element can carry. */
  simple: boolean
}

/** Split a `style` attribute into declarations, tolerating draw.io's trailing `;`. */
export function parseStyle(style: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (style === undefined) return out

  // Split on `;` that is not inside parentheses, so `light-dark(a, b)` survives.
  let depth = 0
  let start = 0
  const parts: string[] = []
  for (let i = 0; i < style.length; i += 1) {
    const ch = style[i]
    if (ch === '(') depth += 1
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      parts.push(style.slice(start, i))
      start = i + 1
    }
  }
  parts.push(style.slice(start))

  for (const part of parts) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    const property = part.slice(0, colon).trim().toLowerCase()
    const value = part.slice(colon + 1).trim()
    if (property !== '' && value !== '') out[property] = value
  }
  return out
}

function parsePx(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const match = /^(-?[\d.]+)px$/.exec(value.trim())
  return match ? Number(match[1]) : undefined
}

/** Strip CSS quoting from a font-family list and return each family name. */
export function parseFontFamilies(value: string): string[] {
  return value
    .split(',')
    .map((family) => family.trim().replace(/^["']|["']$/g, '').replace(/&quot;/g, '').trim())
    .filter((family) => family !== '')
}

/** Parse the XHTML inside a `<foreignObject>`. */
export function parseLabel(foreignObjectSource: string): ParsedLabel {
  const stack: LabelNode[] = []
  let root: LabelNode | undefined
  let depth = 0
  const tags = new Set<string>()
  const fontFamilies = new Set<string>()

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        depth += 1
        // Skip the foreignObject element itself; we want its HTML children.
        if (depth === 1 && name.toLowerCase() === 'foreignobject') return

        const tag = name.toLowerCase()
        tags.add(tag)
        const style = parseStyle(attributes['style'])
        const family = style['font-family']
        if (family !== undefined) {
          for (const each of parseFontFamilies(family)) fontFamilies.add(each)
        }

        const node: LabelNode = { tag, style, children: [] }
        const parent = stack.at(-1)
        if (parent === undefined) root ??= node
        else parent.children.push(node)
        if (tag !== 'br') stack.push(node)
      },
      ontext(text) {
        const parent = stack.at(-1)
        if (parent === undefined) return
        // Coalesce adjacent text. htmlparser2 reports every decoded character
        // reference as its own text event, and some draw.io exports write all
        // their Japanese as `&#x30B5;`-style references — leaving one text node
        // per character, which later becomes one <span> per character: unable to
        // wrap, and shaped without kerning between neighbours.
        const last = parent.children.at(-1)
        if (typeof last === 'string') parent.children[parent.children.length - 1] = last + text
        else parent.children.push(text)
      },
      onclosetag(name) {
        depth -= 1
        if (name.toLowerCase() === 'br') return
        if (depth === 0 && name.toLowerCase() === 'foreignobject') return
        stack.pop()
      },
    },
    { xmlMode: false, decodeEntities: true, lowerCaseTags: true },
  )
  parser.write(foreignObjectSource)
  parser.end()

  const text = root === undefined ? '' : flattenText(root)
  return {
    root,
    text,
    box: root === undefined ? undefined : readBox(root),
    fontFamilies: [...fontFamilies],
    tags,
    simple: root !== undefined && isSimple(root),
  }
}

/** One typeface the label uses, and the exact text set in it. */
export interface FontUsage {
  family: string
  weight: number
  style: 'normal' | 'italic'
  text: string
}

function readWeight(value: string | undefined, inherited: number): number {
  if (value === undefined) return inherited
  if (value === 'bold' || value === 'bolder') return 700
  if (value === 'normal' || value === 'lighter') return 400
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : inherited
}

/**
 * Attribute each character to the font that will actually render it.
 *
 * draw.io mixes typefaces within a single label — a Helvetica wrapper around
 * Lucida Console code spans, or around Japanese set in Noto Sans. Asking every
 * family to cover the whole label's text makes each one fail the glyph-coverage
 * check for characters it was never going to draw, and the label is needlessly
 * left as HTML. Following CSS inheritance gives each face exactly its own text,
 * which also keeps the webfont subsets minimal.
 */
export function collectFontUsage(
  root: LabelNode,
  fallbackFamily = 'Helvetica',
): Map<string, FontUsage> {
  const usage = new Map<string, FontUsage>()

  const walk = (
    node: LabelNode,
    family: string,
    weight: number,
    style: 'normal' | 'italic',
  ): void => {
    const declared = node.style['font-family']
    // Only the first family in the stack is used; the rest are CSS fallbacks we
    // have no way to select between without measuring coverage per character.
    const nextFamily = declared === undefined ? family : (parseFontFamilies(declared)[0] ?? family)
    const nextWeight = readWeight(node.style['font-weight'], weight)
    const nextStyle = node.style['font-style'] === 'italic' ? 'italic' : style

    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child === '') continue
        const key = `${nextFamily}|${nextWeight}|${nextStyle}`
        const existing = usage.get(key)
        if (existing === undefined) {
          usage.set(key, { family: nextFamily, weight: nextWeight, style: nextStyle, text: child })
        } else {
          existing.text += child
        }
        continue
      }
      if (child.tag === 'br') continue
      walk(child, nextFamily, nextWeight, nextStyle)
    }
  }

  walk(root, fallbackFamily, 400, 'normal')
  return usage
}

function flattenText(node: LabelNode): string {
  let out = ''
  for (const child of node.children) {
    if (typeof child === 'string') out += child
    else if (child.tag === 'br') out += '\n'
    else out += flattenText(child)
  }
  return out
}

/** Map a flex alignment keyword, ignoring the `safe`/`unsafe` overflow prefix. */
function readAlignment(value: string | undefined): 'start' | 'center' | 'end' {
  const keyword = (value ?? '').replace(/\b(un)?safe\s+/gi, '').trim()
  if (keyword === 'center') return 'center'
  if (keyword === 'flex-end' || keyword === 'end' || keyword === 'right') return 'end'
  return 'start'
}

function readBox(root: LabelNode): LabelBox | undefined {
  const width = parsePx(root.style['width'])
  const height = parsePx(root.style['height'])
  const paddingTop = parsePx(root.style['padding-top'])
  const marginLeft = parsePx(root.style['margin-left'])
  if (width === undefined || height === undefined) return undefined
  return {
    width,
    height,
    paddingTop: paddingTop ?? 0,
    marginLeft: marginLeft ?? 0,
    justify: readAlignment(root.style['justify-content']),
    align: readAlignment(root.style['align-items']),
  }
}

/**
 * A label is "simple" when a single `<text>` element can represent it exactly:
 * one text run, no line breaks, and no nested element that changes the styling
 * partway through.
 */
function isSimple(root: LabelNode): boolean {
  let runs = 0
  let styledDescendants = 0

  const walk = (node: LabelNode, insideLeaf: boolean): void => {
    for (const child of node.children) {
      if (typeof child === 'string') {
        if (child.trim() !== '') runs += insideLeaf ? 0 : 1
        continue
      }
      if (child.tag === 'br') {
        styledDescendants += 1
        continue
      }
      // A span/font inside the innermost div means per-run styling.
      if (child.tag === 'span' || child.tag === 'font' || child.tag === 'b' || child.tag === 'i') {
        styledDescendants += 1
      }
      walk(child, insideLeaf)
    }
  }

  walk(root, false)
  return styledDescendants === 0 && runs <= 1
}
