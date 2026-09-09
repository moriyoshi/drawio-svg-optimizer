import { describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../src/index.js'
import { collectReferencedIds } from '../src/core/references.js'
import { parseLabel, parseStyle } from '../src/html/label.js'
import { count, fixture, labelText } from './helpers.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

describe('switch-collapse', () => {
  it("hoists draw.io's own <text> fallback and drops the HTML branch", async () => {
    const result = await optimizeDrawioSvg(TEXT_FALLBACK)
    expect(count(TEXT_FALLBACK, /<foreignObject/g)).toBe(29)
    expect(count(result.data, /<foreignObject/g)).toBeLessThan(12)
    // Every label still has an SVG rendering.
    expect(count(result.data, /<text[ >]/g)).toBe(count(TEXT_FALLBACK, /<text[ >]/g))
  })

  it('refuses to collapse when draw.io truncated the fallback', async () => {
    // draw.io ellipsises the <text> fallback when the label overflows its shape
    // ("AWS Firehose Sink" -> "AWS Firehose S..."). Collapsing onto that would
    // silently corrupt the label, so the text-equivalence check is a hard
    // precondition rather than a formality.
    const result = await optimizeDrawioSvg(TEXT_FALLBACK)
    const mismatches = result.warnings.filter((warning) => warning.code === 'fallback-mismatch')
    expect(mismatches.length).toBeGreaterThan(0)
    for (const mismatch of mismatches) {
      expect(result.data).toContain(mismatch.detail!)
    }
    expect(labelText(result.data)).toContain('AWS Firehose Sink')
  })

  it('leaves labels alone when there is no fallback to collapse onto', async () => {
    // example.svg rasterises its labels instead of emitting <text>, so there is
    // nothing to hoist; only Satori can eliminate these.
    const result = await optimizeDrawioSvg(EXAMPLE)
    expect(count(result.data, /<foreignObject/g)).toBe(19)
  })
})

describe('strip-metadata', () => {
  it('removes data-cell-id, which cleanupIds cannot see', async () => {
    expect(count(EXAMPLE, /data-cell-id/g)).toBe(29)
    expect(count((await optimizeDrawioSvg(EXAMPLE)).data, /data-cell-id/g)).toBe(0)
  })

  it('removes the embedded mxfile source and says so', async () => {
    const result = await optimizeDrawioSvg(TEXT_FALLBACK)
    expect(result.data).not.toContain('&lt;mxfile&gt;')
    expect(result.warnings.map((warning) => warning.code)).toContain('diagram-source-removed')
  })

  it('keeps the diagram re-editable under the safe preset', async () => {
    const result = await optimizeDrawioSvg(TEXT_FALLBACK, { preset: 'safe' })
    expect(result.data).toContain('&lt;mxfile&gt;')
    expect(count(result.data, /data-cell-id/g)).toBe(count(TEXT_FALLBACK, /data-cell-id/g))
  })

  it('keeps color-scheme while dropping the redundant transparent background', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE)
    const root = /<svg[^>]*>/.exec(result.data)![0]
    expect(root).toContain('color-scheme: light dark')
    expect(root).not.toMatch(/background(-color)?:\s*transparent/)
    // The declaration is legitimate inside labels and must survive there.
    expect(result.data).toMatch(/background-color/)
  })

  it('drops the empty <style/> but keeps the ones with rules', async () => {
    expect(count(EXAMPLE, /<style/g)).toBe(3)
    // Sanitizing removes the webfont @import, which empties a second one.
    const kept = await optimizeDrawioSvg(EXAMPLE, { sanitize: false })
    expect(count(kept.data, /<style/g)).toBe(2)
    expect(count((await optimizeDrawioSvg(EXAMPLE)).data, /<style/g)).toBe(1)
  })
})

describe('id cleanup', () => {
  it('preserves a root id that only the CSS refers to', async () => {
    // #ge-svg-… is referenced solely from an @supports rule inside <style>, and
    // drives the adaptive background. SVGO cannot see that CSS because we
    // withhold it, so we scan for references ourselves.
    expect(collectReferencedIds(EXAMPLE)).toContain('ge-svg-VzCQW9JUwxfJQkWguAOk')
    expect((await optimizeDrawioSvg(EXAMPLE)).data).toContain('ge-svg-VzCQW9JUwxfJQkWguAOk')
  })

  it('finds references in url(), href, aria and animation timing', async () => {
    const ids = collectReferencedIds(
      '<svg><rect fill="url(#grad)" clip-path="url( \'#clip\' )" aria-labelledby="t1 t2"/>' +
        '<use xlink:href="#shape"/><animate begin="go.click;other.end"/></svg>',
    )
    expect([...ids].toSorted()).toEqual(['clip', 'go', 'grad', 'other', 'shape', 't1', 't2'])
  })
})

describe('label parsing', () => {
  it('splits style declarations without breaking light-dark()', async () => {
    const style = parseStyle('color: light-dark(#000000, #ffffff); font-size: 12px;')
    expect(style['color']).toBe('light-dark(#000000, #ffffff)')
    expect(style['font-size']).toBe('12px')
  })

  it('reads the layout box from draw.io\'s wrapper div', () => {
    const label = parseLabel(
      '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml" style="width: 628px; height: 1px; padding-top: 72px; margin-left: 221px;">x</div></foreignObject>',
    )
    expect(label.box).toEqual({
      width: 628,
      height: 1,
      paddingTop: 72,
      marginLeft: 221,
      justify: 'start',
      align: 'start',
    })
  })

  it('treats <br> and styled runs as not-simple', async () => {
    expect(parseLabel('<foreignObject><div>plain</div></foreignObject>').simple).toBe(true)
    expect(parseLabel('<foreignObject><div>a<br/>b</div></foreignObject>').simple).toBe(false)
    expect(
      parseLabel('<foreignObject><div><span style="color:red">a</span></div></foreignObject>').simple,
    ).toBe(false)
  })

  it('renders <br> as a newline and keeps pre-formatted indentation', async () => {
    const label = parseLabel('<foreignObject><div>{<br />  "a": 1<br />}</div></foreignObject>')
    expect(label.text).toBe('{\n  "a": 1\n}')
  })
})
