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
})
