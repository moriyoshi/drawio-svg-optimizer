import { describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../src/index.js'
import { parseLabel } from '../src/html/label.js'
import { toVdom } from '../src/html/toVdom.js'
import { protectRegions } from '../src/core/protect.js'
import { absoluteTextRuns } from './geometry.js'
import { count, fixture, PRETTY_FIXTURES } from './helpers.js'

const online = await fetch('https://fonts.googleapis.com/css2?family=Arimo')
  .then((response) => response.ok)
  .catch(() => false)
const whenOnline = online ? it : it.skip

const ENTITIES = fixture('pretty-entities.svg')
const LARGE = fixture('pretty-large.svg')

/** The first label whose text contains `needle`. */
function labelContaining(svg: string, needle: string) {
  const { regions } = protectRegions(svg)
  for (const region of regions) {
    if (region.kind !== 'subtree') continue
    const label = parseLabel(region.source)
    if (label.root !== undefined && label.text.includes(needle)) return label
  }
  return undefined
}

describe('pretty-printed exports', () => {
  it('these fixtures really are indented, and have no fallback at all', () => {
    // The minified fixtures hid three separate bugs simply by not having
    // whitespace between their tags.
    for (const name of PRETTY_FIXTURES) {
      const svg = fixture(name)
      expect(svg).toMatch(/>\n\s+</)
      expect(count(svg, /<text[ >]/g)).toBe(0)
      expect(count(svg, /<image/g)).toBe(0)
      expect(count(svg, /<foreignObject/g)).toBeGreaterThan(0)
    }
  })

  it('treats markup indentation as collapsible whitespace, not content', () => {
    // Rendering the indentation verbatim shifted every label right by it.
    const label = labelContaining(LARGE, 'APIサーバー')!
    const { node } = toVdom(label.root!, label.box?.width)
    const lines = node.props.children as Array<{ props: { children: unknown } }>
    const first = JSON.stringify(lines[0])
    expect(first).not.toMatch(/\\n\s+/)
    expect(first).toContain('APIサーバー')
  })

  it('keeps U+3000 as content, because CSS does not collapse it', () => {
    // `\s` matches the ideographic space; the CSS white-space set does not.
    // draw.io indents Japanese continuation lines with it.
    const label = labelContaining(LARGE, '　')
    if (label === undefined) return
    const { node } = toVdom(label.root!, label.box?.width)
    expect(JSON.stringify(node)).toContain('　')
  })

  it('coalesces text split across numeric character references', () => {
    // htmlparser2 reports each decoded reference as its own text event, and this
    // export writes all its Japanese that way. One span per character cannot
    // wrap and is shaped without kerning.
    expect(ENTITIES).toMatch(/&#x30[0-9A-F]{2};/)
    const label = labelContaining(ENTITIES, 'サービス利用者')!
    const { node } = toVdom(label.root!, label.box?.width)
    const serialised = JSON.stringify(node)
    expect(serialised).toContain('サービス利用者')
    // Not seven separate one-character runs.
    expect(count(serialised, /"サ"/g)).toBe(0)
  })

  whenOnline('wraps a label whose text overflows its box, as the browser does', async () => {
    // "サービス利用者" is about 84px of Japanese in a 58px box. CJK breaks
    // between almost any two characters, so the browser makes two lines; forcing
    // `white-space: pre` on every run made one long line instead.
    const result = await optimizeDrawioSvg(ENTITIES, { preset: 'aggressive' })
    const runs = absoluteTextRuns(result.data).filter((run) => 'サービス利用者'.includes(run.text))
    const baselines = new Set(runs.map((run) => run.y.toFixed(1)))
    expect(baselines.size).toBeGreaterThan(1)
  }, 60_000)

  whenOnline('keeps the indentation of a pre-formatted code block', async () => {
    // The label sets `white-space: pre` and indents its JSON, but SVG strips
    // leading whitespace from a <text> unless told not to.
    const result = await optimizeDrawioSvg(LARGE, { preset: 'aggressive' })
    const runs = absoluteTextRuns(result.data)
    const shallow = runs.find((run) => run.text.includes('"version"'))
    const deep = runs.find((run) => run.text.includes('"jisx0402"'))
    expect(shallow).toBeDefined()
    expect(deep).toBeDefined()

    // Four extra spaces of indent at 8px monospace is roughly 19px.
    const indent = deep!.x - shallow!.x
    expect(indent).toBeGreaterThan(12)
    expect(indent).toBeLessThan(26)
  }, 60_000)

  whenOnline.each(PRETTY_FIXTURES)('converts every label in %s', async (name) => {
    const source = fixture(name)
    const result = await optimizeDrawioSvg(source, { preset: 'aggressive' })
    expect(count(result.data, /<foreignObject/g)).toBe(0)
    expect(result.data.length).toBeLessThan(source.length)

    // Nothing visible may be lost. Compared on *decoded label text*: reading the
    // raw source would pick up CSS and the literal `&#x30B5;` of an entity, and
    // would flag the deliberately rewritten font name as missing content.
    const { regions } = protectRegions(source)
    const labels = regions
      .filter((region) => region.kind === 'subtree')
      .map((region) => parseLabel(region.source).text)
      .join('')
    const visible = [...new Set(labels)].filter((char) => !/\s/.test(char))
    expect(visible.length).toBeGreaterThan(10)

    const rendered = new Set(result.data.replace(/<[^>]+>/g, ''))
    expect(visible.filter((char) => !rendered.has(char))).toEqual([])
  }, 120_000)
})
