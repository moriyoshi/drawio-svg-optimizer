import { describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../src/index.js'
import { count, fixture, labelText } from './helpers.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

describe('drop-raster-fallback', () => {
  it('removes the base64 label fallbacks, which are 91% of the reference export', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, { stats: true })

    expect(count(EXAMPLE, /<image/g)).toBe(19)
    expect(count(result.data, /<image/g)).toBe(0)
    expect(result.stats.raw.after).toBeLessThan(50_000)
    // Base64 PNG is incompressible, so this is where nearly all the gzip win is.
    expect(result.stats.gzip.after).toBeLessThan(result.stats.gzip.before / 50)
  })

  it('keeps every label and every foreignObject intact', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE)
    expect(labelText(result.data)).toBe(labelText(EXAMPLE))
    expect(count(result.data, /<foreignObject/g)).toBe(19)
    expect(count(result.data, /<switch/g)).toBe(19)
  })

  it('leaves an export that has no raster fallbacks alone', async () => {
    const result = await optimizeDrawioSvg(TEXT_FALLBACK, { collapseSwitches: false })
    expect(count(result.data, /<image/g)).toBe(0)
    expect(count(result.data, /<text[ >]/g)).toBe(count(TEXT_FALLBACK, /<text[ >]/g))
    expect(labelText(result.data)).toBe(labelText(TEXT_FALLBACK))
  })

  it('never touches an <image> that is real diagram content', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<image href="data:image/png;base64,AAAA" width="10" height="10"/>' +
      '<g><image href="data:image/png;base64,BBBB" width="10" height="10"/></g>' +
      '</svg>'
    expect(count((await optimizeDrawioSvg(svg)).data, /<image/g)).toBe(2)
  })

  it('keeps a linked fallback, because a URL is content we cannot reproduce', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><switch>' +
      '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>' +
      '<image href="https://example.com/label.png" width="10" height="10"/>' +
      '</switch></svg>'
    const result = await optimizeDrawioSvg(svg)
    expect(count(result.data, /<image/g)).toBe(1)
    expect(result.warnings.map((warning) => warning.code)).toContain('raster-fallback-kept')
  })

  it('can be turned off', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, { dropRasterFallback: false })
    expect(count(result.data, /<image/g)).toBe(19)
  })
})
