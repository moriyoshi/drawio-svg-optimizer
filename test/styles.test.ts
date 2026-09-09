import { describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../src/index.js'
import { consolidateStyles } from '../src/plugins/consolidateStyles.js'
import { classesDefinedIn, stripStrayClasses } from '../src/plugins/stripStrayClasses.js'
import { createContext } from '../src/core/types.js'
import { count, fixture } from './helpers.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

/** Presentation attributes the consolidator is allowed to move into a rule. */
const PRESENTATION = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-linecap',
  'stroke-linejoin',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'letter-spacing',
  'text-anchor',
  'text-decoration',
  'dominant-baseline',
  'opacity',
  'pointer-events',
  'visibility',
  'color',
]

function parseDeclarations(block: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  let depth = 0
  let start = 0
  const parts: string[] = []
  for (let i = 0; i < block.length; i += 1) {
    const char = block[i]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ';' && depth === 0) {
      parts.push(block.slice(start, i))
      start = i + 1
    }
  }
  parts.push(block.slice(start))
  for (const part of parts) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    const property = part.slice(0, colon).trim()
    const value = part.slice(colon + 1).trim()
    if (property !== '' && value !== '') out.push([property, value])
  }
  return out
}

/**
 * The resolved styling of every element, following the CSS cascade.
 *
 * Folding presentation attributes into classes is only safe because of ordering:
 * a presentation attribute is the *weakest* thing in the author origin and an
 * inline `style` the strongest, so once both become equal-specificity classes,
 * the original precedence survives only if the presentation-derived rules come
 * first. Comparing the fully resolved cascade — attributes, then classes in
 * stylesheet order, then inline style — is the only way to assert that holds.
 */
function resolvedStyles(svg: string): string[] {
  const rules: Array<[string, Array<[string, string]>]> = []
  for (const styleBlock of svg.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    for (const rule of styleBlock[1]!.matchAll(/(?:#[\w-]+\s+)?\.([a-z]+)\{([^}]*)\}/g)) {
      rules.push([rule[1]!, parseDeclarations(rule[2]!)])
    }
  }

  const out: string[] = []
  for (const tag of svg.matchAll(/<([\w:-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const attributes = tag[2] ?? ''
    const resolved = new Map<string, string>()

    // 1. Presentation attributes: weakest.
    for (const name of PRESENTATION) {
      const value = new RegExp(`\\s${name}="([^"]*)"`).exec(attributes)?.[1]
      if (value !== undefined) resolved.set(name, value)
    }

    // 2. Class rules, in stylesheet order.
    const classes = /\sclass="([^"]*)"/.exec(attributes)?.[1]?.split(/\s+/) ?? []
    for (const [name, declarations] of rules) {
      if (!classes.includes(name)) continue
      for (const [property, value] of declarations) resolved.set(property, value)
    }

    // 3. Inline style: strongest.
    const inline = /\sstyle="([^"]*)"/.exec(attributes)?.[1]
    if (inline !== undefined) {
      for (const [property, value] of parseDeclarations(inline)) resolved.set(property, value)
    }

    if (resolved.size === 0) continue
    const serialised = [...resolved]
      .map(([property, value]) => {
        // `font-size="12"` and `font-size: 12px` are the same length; the unit
        // is required in CSS and forbidden as a bare attribute number.
        const normalised = value
          .replace(/&apos;/g, "'")
          .replace(/\s+/g, ' ')
          .replace(/^(-?[\d.]+)px$/, '$1')
          .trim()
        return `${property}:${normalised}`
      })
      .toSorted()
      .join(';')
    out.push(serialised)
  }
  return out.toSorted()
}

describe('style consolidation', () => {
  it.each([
    ['example.svg', EXAMPLE],
    ['text-fallback.svg', TEXT_FALLBACK],
  ])('resolves to the same cascade in %s', async (_name, source) => {
    const plain = await optimizeDrawioSvg(source, { preset: 'aggressive' })
    const folded = await optimizeDrawioSvg(source, {
      preset: 'aggressive',
      consolidateStyles: true,
    })
    expect(resolvedStyles(folded.data)).toEqual(resolvedStyles(plain.data))
  })

  it('folds presentation attributes as well as style attributes', async () => {
    // fill=/stroke= are where most of the repetition lives once labels are SVG
    // text: on this fixture they are the larger half of the saving.
    const plain = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    const styleOnly = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      consolidateStyles: true,
      presentationAttributes: false,
    })
    const both = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      consolidateStyles: true,
    })
    expect(styleOnly.data.length).toBeLessThan(plain.data.length)
    expect(both.data.length).toBeLessThan(styleOnly.data.length * 0.8)
    expect(resolvedStyles(both.data)).toEqual(resolvedStyles(plain.data))
  })

  it('orders presentation rules before style rules, so inline style still wins', async () => {
    // A presentation attribute is the weakest thing in the author origin and an
    // inline style the strongest. Once both are classes of equal specificity,
    // only document order preserves that relationship.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<rect fill="#111111" stroke="#222222" stroke-miterlimit="10" style="fill: #999999; stroke: #888888;"/>'.repeat(
        4,
      ) +
      '</svg>'
    const { svg: out } = consolidateStyles(svg, { context: createContext() })
    const order = [...out.matchAll(/\.([a-z]+)\{([^}]*)\}/g)].map((match) => match[2]!)
    expect(order[0]).toContain('#111111')
    expect(order[1]).toContain('#999999')
    // The winning declaration is still the one the inline style carried.
    expect(resolvedStyles(out)).toEqual(resolvedStyles(svg))
  })

  it('adds a unit when a length property needs one', () => {
    // font-size="12" is twelve user units as an attribute, but `font-size: 12`
    // is invalid CSS: the declaration is dropped and the text falls back to the
    // inherited default, rendering at 16px. Structural checks cannot see this;
    // the browser can.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<text font-size="12" fill="#123456" font-family="Helvetica">x</text>'.repeat(4) +
      '</svg>'
    const rule = /<style[^>]*>([\s\S]*?)<\/style>/.exec(
      consolidateStyles(svg, { context: createContext() }).svg,
    )?.[1]
    expect(rule).toContain('font-size:12px')
  })

  it('leaves bare numbers alone where CSS wants a number', () => {
    // stroke-miterlimit, font-weight and the opacities take unitless numbers;
    // appending px would break them.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M0 0" stroke="#000000" stroke-miterlimit="10" stroke-width="2" fill-opacity="0.5"/>'.repeat(
        4,
      ) +
      '</svg>'
    const rule = /<style[^>]*>([\s\S]*?)<\/style>/.exec(
      consolidateStyles(svg, { context: createContext() }).svg,
    )?.[1]
    expect(rule).toContain('stroke-miterlimit:10')
    expect(rule).not.toContain('stroke-miterlimit:10px')
    expect(rule).toContain('fill-opacity:0.5')
  })

  it('never moves geometry attributes into a rule', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="1" y="2" width="3" height="4" fill="light-dark(#111111, #eeeeee)"/>'.repeat(4) +
      '</svg>'
    const { svg: out } = consolidateStyles(svg, { context: createContext() })
    expect(count(out, /x="1"/g)).toBe(4)
    expect(count(out, /width="3"/g)).toBe(4)
    expect(out).not.toMatch(/\.[a-z]+\{[^}]*width:/)
  })

  it('decodes entities when writing a value into the stylesheet', () => {
    // font-family="&apos;Noto Sans JP&apos;" is right in an attribute but wrong
    // in a <style> body, which is raw text when the SVG is inlined into HTML —
    // and an & there makes a standalone .svg invalid XML.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<text font-family="&apos;Noto Sans JP&apos;" font-size="12" fill="#123456">x</text>'.repeat(4) +
      '</svg>'
    const { svg: out } = consolidateStyles(svg, { context: createContext() })
    const rule = /<style[^>]*>([\s\S]*?)<\/style>/.exec(out)?.[1] ?? ''
    expect(rule).toContain("font-family:'Noto Sans JP'")
    expect(rule).not.toContain('&')
  })

  it('is off by default, because it costs gzip bytes rather than saving them', async () => {
    // Replacing highly-compressible repeated strings with class attributes adds
    // entropy: raw drops 21% on this fixture while gzip grows 2%.
    const plain = await optimizeDrawioSvg(TEXT_FALLBACK, { preset: 'aggressive', stats: true })
    const folded = await optimizeDrawioSvg(TEXT_FALLBACK, {
      preset: 'aggressive',
      consolidateStyles: true,
      stats: true,
    })
    expect(plain.data).not.toContain('class=')
    expect(folded.stats.raw.after).toBeLessThan(plain.stats.raw.after * 0.9)
    expect(folded.stats.gzip.after).toBeGreaterThan(plain.stats.gzip.after * 0.95)
  })

  it('scopes rules under the root id so inline SVG cannot leak them', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      consolidateStyles: true,
    })
    // draw.io already supplies a root id; reusing it keeps its own CSS working.
    expect(result.data).toMatch(/#ge-svg-VzCQW9JUwxfJQkWguAOk\s+\.[a-z]+\{/)
  })

  it('stamps a content-hash id when the document has none', () => {
    const context = createContext()
    const style = 'fill: light-dark(rgb(1, 2, 3), rgb(4, 5, 6));'
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      `<rect style="${style}"/><rect style="${style}"/><rect style="${style}"/>` +
      '</svg>'
    const { svg: out, folded } = consolidateStyles(svg, { context })
    expect(folded).toBe(3)
    expect(out).toMatch(/<svg id="dn-[0-9a-f]{8}"/)
    expect(out).toMatch(/#dn-[0-9a-f]{8}\s+\.a\{/)
  })

  it('can emit short unscoped names for standalone files', () => {
    const style = 'fill: light-dark(rgb(1, 2, 3), rgb(4, 5, 6));'
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      `<rect style="${style}"/><rect style="${style}"/><rect style="${style}"/>` +
      '</svg>'
    const { svg: out } = consolidateStyles(svg, { context: createContext(), unscoped: true })
    expect(out).toContain('.a{')
    expect(out).not.toContain('#dn-')
  })

  it('merges into an existing class attribute rather than replacing it', () => {
    const style = 'fill: light-dark(rgb(1, 2, 3), rgb(4, 5, 6));'
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.keep{}</style>' +
      `<rect class="keep" style="${style}"/><rect style="${style}"/><rect style="${style}"/>` +
      '</svg>'
    const { svg: out } = consolidateStyles(svg, { context: createContext() })
    expect(out).toContain('class="keep a"')
  })

  it('leaves a style that appears only once alone', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill: rgb(1, 2, 3); stroke: red;"/></svg>'
    expect(consolidateStyles(svg, { context: createContext() }).folded).toBe(0)
  })
})

describe('stray class removal', () => {
  it('reads class names out of selectors, not out of declaration values', () => {
    const defined = classesDefinedIn(
      '<svg><style>#root .a, .b-two { margin: .5em; padding: .25rem }</style></svg>',
    )
    expect([...defined].toSorted()).toEqual(['a', 'b-two'])
  })

  it('drops classes no rule defines and keeps the ones that are used', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.used{fill:red}</style>' +
      '<rect class="used stray"/><rect class="alsoStray"/></svg>'
    const context = createContext()
    const out = stripStrayClasses(svg, { context, keep: undefined })
    expect(out).toContain('class="used"')
    expect(out).not.toContain('stray')
    expect(out).not.toContain('alsoStray')
    expect(context.warnings.map((warning) => warning.code)).toContain('stray-classes-removed')
  })

  it('keeps classes the caller vouches for, since external CSS may use them', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect class="js-hook other"/></svg>'
    const out = stripStrayClasses(svg, { context: createContext(), keep: /^js-/ })
    expect(out).toContain('class="js-hook"')
    expect(out).not.toContain('other')
  })

  it('never rewrites class names mentioned inside a <style> body', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:red}</style><rect class="a"/></svg>'
    expect(stripStrayClasses(svg, { context: createContext(), keep: undefined })).toBe(svg)
  })

  it('does not disturb the classes consolidation just created', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      consolidateStyles: true,
    })
    const defined = classesDefinedIn(result.data)
    const referenced = [...result.data.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
      match[1]!.split(/\s+/).filter((name) => name !== ''),
    )
    expect(referenced.length).toBeGreaterThan(0)
    expect(referenced.filter((name) => !defined.has(name))).toEqual([])
  })

  it('leaves an export with no class attributes untouched', async () => {
    // Neither reference export contains a single class attribute.
    expect(count(EXAMPLE, /class=/g)).toBe(0)
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    expect(result.warnings.map((warning) => warning.code)).not.toContain('stray-classes-removed')
  })
})
