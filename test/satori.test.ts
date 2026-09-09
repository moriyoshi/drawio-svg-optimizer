import { describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../src/index.js'
import { measure, place } from '../src/core/place.js'
import { postprocessSatori } from '../src/core/satoriPostprocess.js'
import { normalizeStyle } from '../src/html/normalizeCss.js'
import { collectFontUsage, parseLabel } from '../src/html/label.js'
import { fallbackFamilyFor, familiesDeclaredIn } from '../src/fonts/script.js'
import { count, fixture, labelText } from './helpers.js'
import { absoluteTextRuns } from './geometry.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

const online = await fetch('https://fonts.googleapis.com/css2?family=Arimo')
  .then((response) => response.ok)
  .catch(() => false)
const whenOnline = online ? it : it.skip

describe('CSS normalisation for Satori', () => {
  it('resolves light-dark() and remembers the dark half', () => {
    const pairs = new Map()
    const { style } = normalizeStyle({ color: 'light-dark(#000000, #ffffff)' }, pairs)
    expect(style['color']).toBe('#000000')
    expect(pairs.get('#000000')).toEqual({ light: '#000000', dark: '#ffffff' })
  })

  it("drops draw.io's invalid values instead of passing them to Satori", () => {
    // Satori throws on values it cannot parse, and one bad declaration would
    // cost the whole label.
    expect(normalizeStyle({ 'background-color': 'default' }).style).toEqual({})
    expect(normalizeStyle({ 'background-color': 'light-dark(default, #32a0ae)' }).style).toEqual({})
  })

  it('strips the unsafe/safe overflow-alignment keywords', () => {
    const { style } = normalizeStyle({
      'align-items': 'unsafe center',
      'justify-content': 'unsafe flex-start',
    })
    expect(style['alignItems']).toBe('center')
    expect(style['justifyContent']).toBe('flex-start')
  })

  it('turns inline-block into a flex column, which Satori does support', () => {
    const { style } = normalizeStyle({ display: 'inline-block' })
    expect(style).toEqual({ display: 'flex', flexDirection: 'column' })
  })

  it('drops zero-width borders, which carry the unsupported currentcolor', () => {
    expect(
      normalizeStyle({ border: '0px solid light-dark(currentcolor, rgb(237, 237, 237))' }).style,
    ).toEqual({})
  })

  it('drops the font-size: 0 wrapper sentinel that would hide the text', () => {
    expect(normalizeStyle({ 'font-size': '0' }).style['fontSize']).toBeUndefined()
    expect(normalizeStyle({ 'font-size': '12px' }).style['fontSize']).toBe(12)
  })

  it('unquotes the &quot;-wrapped families draw.io writes', () => {
    expect(normalizeStyle({ 'font-family': '&quot;Lucida Console&quot;' }).style['fontFamily']).toBe(
      'Lucida Console',
    )
  })
})

describe('font attribution', () => {
  it('gives each face only the text it actually renders', () => {
    // Asking every family to cover the whole label makes each fail the coverage
    // check for characters it was never going to draw.
    const label = parseLabel(
      '<foreignObject><div style="font-family: Helvetica">outer' +
        '<span style="font-family: Lucida Console">code</span></div></foreignObject>',
    )
    const usage = collectFontUsage(label.root!)
    expect(usage.get('Helvetica|400|normal')?.text).toBe('outer')
    expect(usage.get('Lucida Console|400|normal')?.text).toBe('code')
  })

  it('inherits family and weight down the tree', () => {
    const label = parseLabel(
      '<foreignObject><div style="font-family: Arial; font-weight: bold">' +
        '<span>inherited</span></div></foreignObject>',
    )
    expect([...collectFontUsage(label.root!).keys()]).toEqual(['Arial|700|normal'])
  })
})

describe('script fallback', () => {
  it('picks a Japanese face for kana and a base face for other non-Latin text', () => {
    expect(fallbackFamilyFor('ケンオール')).toBe('Noto Sans JP')
    expect(fallbackFamilyFor('①②③')).toBe('Noto Sans JP')
    expect(fallbackFamilyFor('plain ascii')).toBeUndefined()
  })

  it('reads the families the document itself declares, including from its @import', () => {
    // The `@import` URL is a source of family names in its own right, not just
    // the `font-family` declarations — this is the case that proves the URL is
    // parsed too.
    const families = familiesDeclaredIn(EXAMPLE)
    expect(families).toContain('Noto Sans JP')
    expect(families).toContain('Lucida Console')
  })

  it('stops a presentation attribute at its own quote, not at a semicolon', () => {
    // A declaration ends at `;`; an attribute ends at its closing quote, and
    // there is no `;` before the next attribute. Treating both the same way ran
    // the match on through the rest of the attribute list, so
    // `font-family="Helvetica" font-size="12px" text-anchor="middle"` came back
    // as one family called `Helvetica font-size=12px text-anchor=middle`.
    //
    // These are fed to `runSatoriStage` as preferred fallback candidates, so a
    // bogus name is tried before the real one — and a browser consumer pays a
    // failed Google Fonts request for each, with no CORS headers on the 400 and
    // so a console error it cannot suppress.
    const families = familiesDeclaredIn(
      '<text font-family="&quot;Helvetica&quot;" font-size="12px" text-anchor="middle"' +
        ' font-weight="bold">x</text>',
    )
    expect(families).toEqual(['Helvetica'])
  })

  it('keeps a quoted family that contains a space', () => {
    // The trap in fixing the above: entity decoding has to run for the
    // declaration case, but doing it first turns
    // `font-family="&quot;Lucida Console&quot;"` into `font-family=""Lucida
    // Console""`, where the attribute delimiter and the CSS quoting are no
    // longer distinguishable — and a naive quote-delimited match captures the
    // empty string between them.
    expect(familiesDeclaredIn('<text font-family="&quot;Lucida Console&quot;">x</text>')).toEqual([
      'Lucida Console',
    ])
    expect(familiesDeclaredIn('<style>.a{font-family:&quot;Lucida Console&quot;;}</style>')).toEqual(
      ['Lucida Console'],
    )
  })

  it('reads declarations in a style attribute, which end at the attribute quote', () => {
    // No trailing `;`, so the value runs to the closing quote of `style`.
    expect(familiesDeclaredIn('<div style="font-family:Helvetica">x</div>')).toEqual(['Helvetica'])
    expect(
      familiesDeclaredIn('<div style="font-family:Helvetica" data-x="font-size:9">x</div>'),
    ).toEqual(['Helvetica'])
  })

  it('takes only the first family of a stack', () => {
    expect(familiesDeclaredIn('<text font-family="Helvetica, Arial, sans-serif">x</text>')).toEqual([
      'Helvetica',
    ])
  })

  it('finds nothing to report in a document that names no family', () => {
    expect(familiesDeclaredIn('<svg><rect width="1" height="1"/></svg>')).toEqual([])
  })
})

describe('Satori output post-processing', () => {
  it('removes the masks, which are unreferenced and share one id per label', () => {
    const { body } = postprocessSatori(
      '<mask id="satori_om-id"><rect width="1" height="1"/></mask><text x="0" y="10">a</text>',
    )
    expect(body).not.toContain('<mask')
    expect(body).toContain('>a<')
  })

  it('merges abutting runs that share a style', () => {
    const { body } = postprocessSatori(
      '<text x="0" y="10" width="48" font-size="12" fill="#000">Countac</text>' +
        '<text x="48" y="10" width="3" font-size="12" fill="#000"> </text>' +
        '<text x="51" y="10" width="31" font-size="12" fill="#000">Proxy</text>',
    )
    expect(count(body, /<text/g)).toBe(1)
    expect(body).toContain('>Countac Proxy<')
  })

  it('keeps runs separate when they do not abut or differ in style', () => {
    const gap = postprocessSatori(
      '<text x="0" y="10" width="10" fill="#000">a</text>' +
        '<text x="90" y="10" width="10" fill="#000">b</text>',
    )
    expect(count(gap.body, /<text/g)).toBe(2)

    const styled = postprocessSatori(
      '<text x="0" y="10" width="10" fill="#000">a</text>' +
        '<text x="10" y="10" width="10" fill="#f00">b</text>',
    )
    expect(count(styled.body, /<text/g)).toBe(2)
  })

  it('preserves whitespace SVG would otherwise strip', () => {
    // `xml:space="default"` — the default — makes a renderer strip leading and
    // trailing spaces and collapse internal runs, so the indentation of a
    // `white-space: pre` code block silently disappears.
    const { body } = postprocessSatori(
      '<text x="0" y="10" width="40" fill="#000">    {</text>',
    )
    expect(body).toContain('xml:space="preserve"')
    expect(body).toContain('>    {<')
  })

  it('leaves ordinary text without the preserve attribute', () => {
    const { body } = postprocessSatori('<text x="0" y="10" width="40" fill="#000">a b</text>')
    expect(body).not.toContain('xml:space')
  })

  it('folds a blank run into a neighbour it shares a style with', () => {
    const { body } = postprocessSatori(
      '<text x="0" y="10" width="9" fill="#000">  </text>' +
        '<text x="9" y="10" width="20" fill="#000">x</text>',
    )
    expect(count(body, /<text/g)).toBe(1)
    // Merged, so the leading spaces are now inside a run and must be preserved.
    expect(body).toContain('xml:space="preserve"')
    expect(body).toContain('>  x<')
  })

  it('drops a blank run that cannot merge, since it draws nothing', () => {
    // A code block's indent sits between two differently coloured tokens, so it
    // survives merging as a run of its own. The next run's absolute position
    // already expresses the gap.
    const { body } = postprocessSatori(
      '<text x="0" y="10" width="9" fill="#000">  </text>' +
        '<text x="9" y="10" width="20" fill="#f00">x</text>',
    )
    expect(count(body, /<text/g)).toBe(1)
    expect(body).toContain('>x<')
    expect(body).toContain('x="9"')
  })

  it('keeps U+3000 runs, which are content rather than whitespace', () => {
    const { body } = postprocessSatori('<text x="0" y="10" width="9" fill="#000">　</text>')
    expect(count(body, /<text/g)).toBe(1)
  })

  it('hoists shared paint attributes and drops SVG defaults', () => {
    const { body, groupAttributes } = postprocessSatori(
      '<text x="0" y="10" width="5" font-family="X" font-style="normal" fill="#000">a</text>' +
        '<text x="0" y="30" width="5" font-family="X" font-style="normal" fill="#000">b</text>',
    )
    expect(groupAttributes).toEqual({ 'font-family': 'X', fill: '#000' })
    expect(body).not.toContain('font-family')
    expect(body).not.toContain('font-style')
    // width is Satori layout bookkeeping that SVG ignores on <text>.
    expect(body).not.toContain('width=')
  })
})

describe('placement arithmetic', () => {
  it('centres content on the anchor line of a 1px-high box', () => {
    // draw.io's `height: 1px; align-items: center` means "centre on this line".
    const bounds = { left: 0, right: 84, firstBaseline: 10, lastBaseline: 10, lineHeight: 14.4 }
    const placement = place(
      { width: 628, height: 1, paddingTop: 72, marginLeft: 221, justify: 'center', align: 'center' },
      bounds,
    )
    expect(placement.dx).toBeCloseTo(221 + (628 - 84) / 2, 5)
    expect(placement.dy).toBeCloseTo(72 + (1 - 14.4) / 2, 5)
  })

  it('left-aligns without shifting when the box says start', () => {
    const bounds = { left: 5, right: 55, firstBaseline: 10, lastBaseline: 10, lineHeight: 14.4 }
    const placement = place(
      { width: 100, height: 1, paddingTop: 0, marginLeft: 30, justify: 'start', align: 'start' },
      bounds,
    )
    // `bounds.left` is where the shaper started, so it is subtracted back out.
    expect(placement.dx).toBe(25)
  })

  it('measures multi-line content across its baselines', () => {
    const bounds = measure([
      { x: 0, y: 10, width: 20, height: 14 },
      { x: 0, y: 24, width: 30, height: 14 },
    ])
    expect(bounds).toEqual({ left: 0, right: 30, firstBaseline: 10, lastBaseline: 24, lineHeight: 14 })
  })
})

describe('label conversion end to end', () => {
  whenOnline('places converted text where draw.io placed its own', async () => {
    // draw.io's <text> fallback is the only ground truth available for what
    // these labels should look like, so the conversion is measured against it —
    // in absolute coordinates, because draw.io wraps labels in a
    // `translate(-0.5 -0.5)` that a pass could otherwise drop unnoticed.
    const truth = new Map<string, { x: number; y: number; anchor: string }>()
    for (const run of absoluteTextRuns(TEXT_FALLBACK)) {
      const found = new RegExp(
        `<text[^>]*>${run.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</text>`,
      ).exec(TEXT_FALLBACK)
      const anchor = /text-anchor="(\w+)"/.exec(found?.[0] ?? '')?.[1] ?? 'start'
      truth.set(run.text, { x: run.x, y: run.y, anchor })
    }

    // Raw output keeps the per-run `width`, which makes the geometry measurable.
    const result = await optimizeDrawioSvg(TEXT_FALLBACK, {
      preset: 'aggressive',
      compactText: false,
    })

    // Group per label *and* baseline: two unrelated labels at the same height
    // must not be concatenated into one line.
    const lines = new Map<string, Array<{ text: string; x: number; width: number }>>()
    for (const run of absoluteTextRuns(result.data)) {
      const key = `${run.group}@${run.y.toFixed(2)}`
      const line = lines.get(key) ?? []
      line.push({ text: run.text, x: run.x, width: run.width })
      lines.set(key, line)
    }

    let compared = 0
    for (const [key, runs] of lines) {
      const sorted = runs.toSorted((a, b) => a.x - b.x)
      const text = sorted.map((run) => run.text).join('')
      const expected = truth.get(text)
      if (expected === undefined) continue

      const left = sorted[0]!.x
      const right = Math.max(...sorted.map((run) => run.x + run.width))
      const got =
        expected.anchor === 'middle' ? (left + right) / 2 : expected.anchor === 'end' ? right : left

      expect(Math.abs(got - expected.x)).toBeLessThan(1)
      expect(Math.abs(Number(key.split('@')[1]) - expected.y)).toBeLessThan(1)
      compared += 1
    }
    expect(compared).toBeGreaterThan(10)
  }, 60_000)

  whenOnline('keeps multi-line labels on separate lines', async () => {
    // Satori has no inline formatting context, so every span and text node in a
    // div becomes a flex item in a row: without explicit line splitting a
    // three-line label renders as one overlapping smear, and a syntax
    // highlighted code block becomes a single very long line.
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    const baselines = new Set(absoluteTextRuns(result.data).map((run) => run.y.toFixed(2)))
    // The fixture has nineteen labels, several of them multi-line, plus two
    // code blocks of a dozen lines each.
    expect(baselines.size).toBeGreaterThan(40)
  }, 60_000)

  whenOnline('gives a code block one line per source line, in order', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    const runs = absoluteTextRuns(result.data)
    const version = runs.find((run) => run.text.includes('2026-08-31'))
    const chiyoda = runs.find((run) => run.text.includes('Chiyoda-ku'))
    expect(version).toBeDefined()
    expect(chiyoda).toBeDefined()
    // "version" is the first line of the JSON, "Chiyoda-ku" one of the last.
    expect(chiyoda!.y).toBeGreaterThan(version!.y)
  }, 60_000)

  whenOnline('removes every foreignObject without losing a character', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    expect(count(result.data, /<foreignObject/g)).toBe(0)
    expect(count(result.data, /<switch/g)).toBe(0)

    const visible = [...new Set(labelText(EXAMPLE))].filter((char) => !/\s/.test(char))
    const rendered = new Set(result.data.replace(/<[^>]+>/g, ''))
    expect(visible.filter((char) => !rendered.has(char))).toEqual([])
  })

  whenOnline('renders Japanese labels that draw.io could only rasterise', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    expect(result.data).toContain('ケンオール')
    // Names the family it was actually shaped with, not the one the document
    // asked for — they differ whenever a substitution happened.
    expect(result.data).toMatch(/font-family="&apos;Noto Sans JP&apos;"/)
    expect(result.data).not.toMatch(/font-family="[^"]*CJK/)
  })

  whenOnline('keeps dark mode alive through the conversion', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    // Satori cannot parse light-dark(), so the pairs are restored afterwards.
    expect(count(result.data, /fill="light-dark\(/g)).toBeGreaterThan(0)
  })

  whenOnline('rewrites the webfont import to the families actually used', async () => {
    // The fixture's own import names only `Noto Sans JP`, but the document also
    // uses Lucida Console, for which Cousine is substituted. The rewritten
    // import has to name what the converted text *ends up* naming, or a viewer
    // loads the wrong set — and since every run is positioned with the metrics
    // of the face it was shaped with, a missing family shows as misaligned text
    // rather than as a fallback that merely looks different.
    //
    // Writing any import at all requires allowing the host; the default emits
    // nothing external.
    const result = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      fontDelivery: 'import',
      allowedHosts: ['fonts.googleapis.com'],
    })
    expect(result.data).toMatch(/fonts\.googleapis\.com\/css2\?[^"]*family=Noto\+Sans\+JP/)
    expect(result.data).toMatch(/fonts\.googleapis\.com\/css2\?[^"]*family=Cousine/)
    expect(result.warnings.map((warning) => warning.code)).toContain('font-import-rewritten')
  })

  whenOnline('is a large net win on both reference exports', async () => {
    const raster = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive', stats: true })
    expect(raster.stats.raw.after).toBeLessThan(30_000)
    expect(raster.stats.gzip.after).toBeLessThan(4_000)

    const fallback = await optimizeDrawioSvg(TEXT_FALLBACK, { preset: 'aggressive', stats: true })
    expect(fallback.stats.raw.after).toBeLessThan(30_000)
    expect(fallback.stats.gzip.after).toBeLessThan(3_500)
  })

  it('leaves labels as HTML rather than risk tofu when fonts are unavailable', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      fontMode: 'bundled',
      offline: true,
    })
    // No fonts resolve, so nothing is converted and nothing is lost.
    expect(count(result.data, /<foreignObject/g)).toBe(19)
    expect(labelText(result.data)).toBe(labelText(EXAMPLE))
  })
})
