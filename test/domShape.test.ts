import { describe, expect, it } from 'vitest'
import { runsToSvg, vnodeToHtml } from '../src/core/domShape.js'
import type { ShapedRun } from '../src/core/domShape.js'

/**
 * These cover the pure half of the browser shaping stage. Measuring needs a
 * real layout engine and lives in `test/visual/browser.test.ts`; everything
 * here is string work that can be checked anywhere.
 */
describe('rendering the vdom as HTML', () => {
  it('keeps unitless CSS properties unitless', async () => {
    // `toVdom` writes styles in the convention Satori and React share, where a
    // bare number means pixels — except for these. `lineHeight: 1.2` is a
    // multiplier of the font size, and rendering it as `1.2px` collapsed every
    // line box to a pixel, stacked baselines 1.2px apart instead of 14.4, and
    // placed every multi-line label 6.6px wrong. It read as a baseline
    // arithmetic bug for a long time before it read as a unit one.
    const html = vnodeToHtml({
      type: 'div',
      props: { style: { fontSize: 12, lineHeight: 1.2, fontWeight: 700, opacity: 1 } },
    })
    expect(html).toContain('font-size:12px')
    expect(html).toContain('line-height:1.2;')
    expect(html).toContain('font-weight:700')
    expect(html).not.toContain('line-height:1.2px')
    expect(html).not.toContain('font-weight:700px')
  })

  it('supplies the flex direction Satori defaults to and CSS does not', async () => {
    // Satori defaults `flex-direction` to column; CSS defaults it to row. A tree
    // built for Satori lays its lines out side by side in a browser without this.
    expect(vnodeToHtml({ type: 'div', props: { style: { display: 'flex' } } })).toContain(
      'flex-direction:column',
    )
    // An explicit direction must survive untouched.
    const row = vnodeToHtml({
      type: 'div',
      props: { style: { display: 'flex', flexDirection: 'row' } },
    })
    expect(row).toContain('flex-direction:row')
    expect(row).not.toContain('flex-direction:column')
  })

  it('hyphenates camel-cased properties', async () => {
    expect(vnodeToHtml({ type: 'div', props: { style: { justifyContent: 'center' } } })).toContain(
      'justify-content:center',
    )
  })

  it('gives a whitespace-only run an element of its own', async () => {
    // Flexbox does not render an anonymous flex item that is nothing but
    // whitespace, and that holds even under `white-space: pre`. Satori has no
    // such rule, so a code block's indentation — which draw.io puts in a span of
    // its own — laid out correctly there and collapsed to zero width here,
    // leaving every nested line of a `pre` JSON block flush against the margin.
    const html = vnodeToHtml({
      type: 'div',
      props: {
        style: { display: 'flex', flexDirection: 'row' },
        children: [
          { type: 'span', props: { style: { whiteSpace: 'pre', display: 'flex' }, children: ['      '] } },
          { type: 'span', props: { style: { whiteSpace: 'pre', display: 'flex' }, children: ['"key"'] } },
        ],
      },
    })
    expect(html).toContain('<span>      </span>')
    // Text with ink in it already gets an anonymous item and must not be wrapped.
    expect(html).not.toContain('<span>"key"</span>')
  })

  it('leaves U+3000 alone, which CSS never collapses', async () => {
    // Not whitespace as far as the white-space property is concerned, so it
    // renders as an ordinary anonymous flex item and needs no wrapper.
    const html = vnodeToHtml({
      type: 'span',
      props: { style: { display: 'flex' }, children: ['　'] },
    })
    expect(html).toBe('<span style="display:flex;flex-direction:column">　</span>')
  })

  it('escapes text and attributes', async () => {
    const html = vnodeToHtml({
      type: 'div',
      props: { style: { fontFamily: '"a" & <b>' }, children: ['x < y & z'] },
    })
    expect(html).toContain('x &lt; y &amp; z')
    expect(html).not.toMatch(/style="[^"]*"[^>]*"/)
  })
})

describe('drawing measured runs', () => {
  const run = (over: Partial<ShapedRun> = {}): ShapedRun => ({
    x: 1.234,
    y: 10.567,
    width: 20,
    height: 14,
    text: 'Hi',
    fontFamily: 'Helvetica, sans-serif',
    fontSize: 12,
    fontWeight: '400',
    fontStyle: 'normal',
    fill: 'rgb(0, 0, 0)',
    ...over,
  })
  const round = (value: number): number => Math.round(value * 100) / 100

  it('names only the first family, the way the resolver reports it', async () => {
    expect(runsToSvg([run()], round)).toContain('font-family="Helvetica"')
  })

  it('omits attributes that match the default', async () => {
    const svg = runsToSvg([run()], round)
    expect(svg).not.toContain('font-weight')
    expect(svg).not.toContain('font-style')
  })

  it('emits weight and slant when they differ', async () => {
    const svg = runsToSvg([run({ fontWeight: '700', fontStyle: 'italic' })], round)
    expect(svg).toContain('font-weight="700"')
    expect(svg).toContain('font-style="italic"')
  })

  it('rounds coordinates to hundredths', async () => {
    expect(runsToSvg([run({ x: 1.23456, y: 9.87654 })], round)).toContain('x="1.23" y="9.88"')
  })

  it('preserves whitespace SVG would otherwise strip, the way the Satori path does', async () => {
    // `xml:space="default"` strips leading and trailing spaces from a `<text>`
    // and collapses internal runs, so the indent of a `white-space: pre` block
    // disappears. Substituting NBSP instead measured one character and drew
    // another, left the text no longer byte-identical to the label's, and hid
    // a blank run from `postprocessSatori`, which then shipped it as a ghost
    // element. A single leading space was not covered by it at all.
    const indented = runsToSvg([run({ text: '    {' })], round)
    expect(indented).toContain('xml:space="preserve"')
    expect(indented).toContain('>    {<')
    expect(runsToSvg([run({ text: ' /v1/postalcode' })], round)).toContain('xml:space="preserve"')
    // No U+00A0 anywhere: the output names the same characters the label did.
    expect(indented).not.toContain('\u00a0')
  })

  it('leaves ordinary text without the preserve attribute', async () => {
    expect(runsToSvg([run({ text: 'Hi there' })], round)).not.toContain('xml:space')
  })
})
