import { describe, expect, it } from 'vitest'
import { optimize, _collections } from 'svgo'
import {
  createContext,
  drawioJs2Svg,
  drawioPlugins,
  patchTextElements,
  styleCdata,
} from '../src/svgo/plugins.js'
import { maxBoxDelta, pathBoxes } from './geometry.js'
import { count, fixture, labelText } from './helpers.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

/** Run a document the way a consumer's `svgo.config.js` would. */
function run(svg: string, options: Parameters<typeof drawioPlugins>[0] = {}): string {
  return optimize(svg, {
    plugins: drawioPlugins(options),
    js2svg: { pretty: false, ...drawioJs2Svg() },
  }).data
}

describe('use as SVGO plugins', () => {
  it('optimizes through the plain SVGO API', () => {
    const out = run(EXAMPLE)
    expect(out.length).toBeLessThan(EXAMPLE.length / 10)
    expect(count(out, /<image/g)).toBe(0)
    expect(count(out, /data-cell-id/g)).toBe(0)
    expect(count(out, /<g[ >]/g)).toBeLessThan(count(EXAMPLE, /<g[ >]/g) / 4)
  })

  it('produces well-formed XML', () => {
    for (const source of [EXAMPLE, TEXT_FALLBACK]) {
      const out = run(source)
      expect(() => optimize(out, { plugins: [] })).not.toThrow()
    }
  })

  it.each([
    ['example.svg', EXAMPLE],
    ['text-fallback.svg', TEXT_FALLBACK],
  ])('does not move any shape in %s', (_name, source) => {
    expect(maxBoxDelta(pathBoxes(source), pathBoxes(run(source, { floatPrecision: 5 })))).toBeLessThan(
      0.001,
    )
  })

  it('collapses switches onto a faithful <text> fallback', () => {
    const out = run(TEXT_FALLBACK)
    expect(count(out, /<foreignObject/g)).toBeLessThan(12)
    expect(count(out, /<text[ >]/g)).toBe(count(TEXT_FALLBACK, /<text[ >]/g))
  })

  it('refuses to collapse when draw.io truncated the fallback', () => {
    const context = createContext()
    const out = run(TEXT_FALLBACK, { context })
    expect(context.warnings.map((warning) => warning.code)).toContain('fallback-mismatch')
    expect(out).toContain('AWS Firehose Sink')
  })
})

describe('the parser patch these plugins depend on', () => {
  it('is what stops SVGO destroying label whitespace', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject width="10" height="10">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="white-space:pre">a<br />    indented</div>' +
      '</foreignObject></svg>'

    // The patch is global and idempotent, so the "before" state can only be
    // observed on an element deliberately left out of it.
    expect(_collections.textElems.has('section')).toBe(false)
    const unpatched = optimize(
      svg.replace(/div/g, 'section'),
      { plugins: [], js2svg: { pretty: false } },
    ).data
    expect(unpatched).not.toContain('    indented')

    patchTextElements()
    expect(optimize(svg, { plugins: [], js2svg: { pretty: false } }).data).toContain('    indented')
  })

  it('keeps label text byte-identical through a full run', () => {
    const out = run(EXAMPLE)
    // Includes the U+3000 ideographic spaces and the code-block indentation.
    expect(labelText(out)).toBe(labelText(EXAMPLE))
    expect(count(out, /　/g)).toBe(count(EXAMPLE, /　/g))
  })
})

describe('<style> handling', () => {
  it('keeps CSS readable when it contains characters SVGO would escape', () => {
    // stringifyText escapes [&'"<>] in every text node, which breaks a rule when
    // the SVG is inlined into HTML, where <style> is a raw-text element.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<style>@import url("http://example.com/?a=1&amp;b=2");</style></svg>'
    const out = optimize(svg, { plugins: [styleCdata()], js2svg: { pretty: false } }).data

    expect(out).toContain('url("http://example.com/?a=1&b=2")')
    expect(out).not.toContain('&quot;')
    // The comment guard makes the CDATA invisible to a CSS parser.
    expect(out).toContain('/*')
    expect(() => optimize(out, { plugins: [] })).not.toThrow()
  })

  it('leaves CSS alone when it needs no escaping', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style></svg>'
    const out = optimize(svg, { plugins: [styleCdata()], js2svg: { pretty: false } }).data
    expect(out).not.toContain('CDATA')
  })

  it('stops quotes in label text being escaped for no reason', () => {
    // Correctness is not at stake — both XML and HTML decode &quot; in text —
    // but the JSON code-block labels grow by about 45% without this.
    const withDefaults = optimize(EXAMPLE, {
      plugins: drawioPlugins(),
      js2svg: { pretty: false },
    }).data
    const patched = run(EXAMPLE)

    // Attribute values keep the stricter escaping, which they need, so compare
    // text content rather than the whole document.
    expect(labelText(withDefaults)).toContain('&quot;')
    expect(labelText(patched)).not.toContain('&quot;')
    expect(patched.length).toBeLessThan(withDefaults.length)
  })
})

describe('what cannot be a plugin', () => {
  it('confirms SVGO discards asynchronous plugin work', () => {
    // This is why label conversion stays in the async pipeline: optimize() is
    // synchronous and never awaits a visitor, so the mutation lands after the
    // tree has already been stringified.
    const asyncPlugin = {
      name: 'async-probe',
      fn: () => ({
        element: {
          enter: async (node: { name: string; attributes: Record<string, string> }) => {
            await Promise.resolve()
            if (node.name === 'svg') node.attributes['data-async'] = 'yes'
          },
        },
      }),
    }
    const out = optimize('<svg xmlns="http://www.w3.org/2000/svg"/>', {
      // eslint-disable-next-line
      plugins: [asyncPlugin as never],
    }).data
    expect(out).not.toContain('data-async')
  })
})
