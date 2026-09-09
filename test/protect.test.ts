import { describe, expect, it } from 'vitest'
import { optimize } from 'svgo'
import { protectRegions, restoreRegions } from '../src/core/protect.js'
import { findElements } from '../src/core/scanner.js'
import { count, fixture, labelText } from './helpers.js'

const EXAMPLE = fixture('example.svg')

describe('scanner', () => {
  it('matches nested elements of the same name without terminating early', async () => {
    const spans = findElements('<g><g><g/></g></g>', 'g')
    expect(spans).toHaveLength(1)
    expect(spans[0]!.end).toBe(18)
  })

  it('does not mistake a longer tag name for the target', async () => {
    expect(findElements('<foreignObjectX/><foreignObject/>', 'foreignObject')).toHaveLength(1)
  })

  it('ignores tags inside comments and CDATA', async () => {
    expect(findElements('<!-- <style>x</style> --><style>y</style>', 'style')).toHaveLength(1)
    expect(findElements('<![CDATA[<style>x</style>]]>', 'style')).toHaveLength(0)
  })

  it('leaves an unterminated element alone rather than guessing', async () => {
    expect(findElements('<style>never closed', 'style')).toHaveLength(0)
  })
})

describe('protectRegions', () => {
  it('round-trips the document through SVGO without losing content', async () => {
    // Guards against two SVGO bugs that would otherwise corrupt every export:
    // the parser trims text in non-`textElems` elements (destroying
    // `white-space: pre` indentation and U+3000), and the stringifier escapes
    // quotes in `<style>` text (breaking `@import url("...")` in inline SVG).
    const { svg, regions } = protectRegions(EXAMPLE)
    const optimized = optimize(svg, { plugins: [], js2svg: { pretty: false } }).data
    const restored = restoreRegions(optimized, regions).svg

    expect(labelText(restored)).toBe(labelText(EXAMPLE))
    expect(count(restored, /　/g)).toBe(count(EXAMPLE, /　/g))
    expect(restored).toContain('@import url("https://fonts.googleapis.com')
    expect(restored).not.toMatch(/<style[^>]*>[^<]*&quot;/)
  })

  it('preserves the leading indentation of white-space: pre code blocks', async () => {
    const { svg, regions } = protectRegions(EXAMPLE)
    const restored = restoreRegions(
      optimize(svg, { plugins: [], js2svg: { pretty: false } }).data,
      regions,
    ).svg
    // The JSON code-block labels indent with runs of spaces after a <br />.
    expect(count(restored, /<br \/>\s{2,}/g)).toBe(count(EXAMPLE, /<br \/>\s{2,}/g))
    expect(count(restored, /<br \/>\s{2,}/g)).toBeGreaterThan(0)
  })

  it('protects every foreignObject subtree and non-empty style text', async () => {
    const { regions } = protectRegions(EXAMPLE)
    expect(regions.filter((region) => region.kind === 'subtree')).toHaveLength(19)
    // Three <style> elements, but one is empty and therefore not worth a slot.
    expect(regions.filter((region) => region.kind === 'text')).toHaveLength(2)
  })

  it('drops a region whose placeholder a pass deliberately removed', async () => {
    const { regions } = protectRegions('<svg><foreignObject><div>x</div></foreignObject></svg>')
    const restored = restoreRegions('<svg></svg>', regions)
    expect(restored.svg).toBe('<svg></svg>')
    // Reported rather than silently swallowed, so an accidental loss is visible.
    expect(restored.missing).toHaveLength(1)
  })

  it('restores every region when there are more than ten of them', async () => {
    // Regression: an undelimited token `SLOT-1` is a prefix of `SLOT-10`, so a
    // substring match spliced one region's source into another's placeholder
    // and silently dropped a label. Tokens are delimited and matched exactly.
    const labels = Array.from(
      { length: 24 },
      (_, index) =>
        `<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">label-${index}</div></foreignObject>`,
    )
    const source = `<svg xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`
    const { svg, regions } = protectRegions(source)
    const restored = restoreRegions(
      optimize(svg, { plugins: [], js2svg: { pretty: false } }).data,
      regions,
    ).svg
    for (let index = 0; index < 24; index += 1) {
      expect(restored).toContain(`label-${index}<`)
    }
  })

  it('is a no-op on a document with nothing to protect', async () => {
    const plain = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
    const { svg, regions } = protectRegions(plain)
    expect(svg).toBe(plain)
    expect(regions).toHaveLength(0)
    expect(restoreRegions(svg, regions).svg).toBe(plain)
  })
})
