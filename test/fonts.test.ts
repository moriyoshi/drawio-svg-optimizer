import { describe, expect, it } from 'vitest'
import { needsWideCoverage, repairFamily, substituteFamily } from '../src/fonts/aliases.js'
import { covers, missingGlyphs } from '../src/fonts/coverage.js'
import { parseFontFaceCss } from '../src/fonts/googleFonts.js'
import { resolveFonts } from '../src/fonts/resolve.js'
import { createContext } from '../src/core/types.js'

/** Network tests are informative, not gating: CI may well be offline. */
const online = await fetch('https://fonts.googleapis.com/css?family=Arimo', {
  headers: { 'User-Agent': 'Mozilla/5.0' },
})
  .then((response) => response.ok)
  .catch(() => false)
const whenOnline = online ? it : it.skip

describe('family aliases', () => {
  it('normalises a family name without correcting it', async () => {
    // The repair table is gone. `repairFamily` is kept for the `./fonts`
    // surface and for the resolver's candidate list, but it only trims now — a
    // misspelt family is passed through unchanged and simply does not resolve.
    expect(repairFamily('Noto Sans CJK JP')).toBe('Noto Sans CJK JP')
    expect(repairFamily('  Helvetica  ')).toBe('Helvetica')
  })

  it('separates metric-compatible substitutions from reflowing ones', async () => {
    expect(substituteFamily('Helvetica')).toEqual({ family: 'Arimo', metricCompatible: true })
    expect(substituteFamily('Lucida Console')).toEqual({ family: 'Cousine', metricCompatible: false })
    expect(substituteFamily('Noto Sans JP')).toBeUndefined()
  })

  it('flags families that need non-Latin coverage', async () => {
    expect(needsWideCoverage('Noto Sans CJK JP')).toBe(true)
    expect(needsWideCoverage('Helvetica')).toBe(false)
  })
})

describe('glyph coverage', () => {
  it('reports every character as missing for a buffer that is not a font', async () => {
    expect(missingGlyphs(new TextEncoder().encode('not a font at all'), 'abc')).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('ignores whitespace, which has no glyph to miss', async () => {
    expect(covers(new Uint8Array(0), ' \n\t')).toBe(true)
  })
})

describe('Google Fonts CSS parsing', () => {
  it('extracts family, weight, style and url from @font-face', async () => {
    const faces = parseFontFaceCss(
      "@font-face { font-family: 'Noto Sans JP'; font-style: italic; font-weight: 700;" +
        " src: url(https://fonts.gstatic.com/x.ttf) format('truetype'); }",
    )
    expect(faces).toEqual([
      {
        family: 'Noto Sans JP',
        weight: 700,
        style: 'italic',
        url: 'https://fonts.gstatic.com/x.ttf',
      },
    ])
  })
})

/**
 * These specs are about repair, substitution and webfont behaviour — not about
 * the system tier — so they pin `mode: 'webfont'` to keep it out of the way.
 *
 * Without that they depend on what the test machine has installed, which was
 * hidden for as long as the system tier was a `fc-match` shell-out that no Mac
 * or Windows box could satisfy. Now that the tier reads the platform registry,
 * an unpinned run would find `Lucida Console` on Windows and report it as
 * metric-compatible, or find a local `Noto Sans JP` and blow the size budget
 * below.
 */
describe('font resolution', () => {
  it('gives up cleanly on a family that does not exist anywhere', async () => {
    const context = createContext()
    const fonts = await resolveFonts(
      [{ family: 'Definitely Not A Real Typeface', weight: 400, style: 'normal', text: 'abc' }],
      { context, offline: true, mode: 'webfont' },
    )
    expect(fonts.size).toBe(0)
    expect(context.warnings.map((warning) => warning.code)).toContain('font-unavailable')
  })

  it('refuses to substitute a Latin face for a CJK family', async () => {
    // Rendering Japanese with Arimo would emit tofu, which is worse than
    // leaving the label as HTML.
    const context = createContext()
    const fonts = await resolveFonts(
      [{ family: 'Hiragino Kaku Gothic', weight: 400, style: 'normal', text: 'ケンオール' }],
      { context, offline: true, mode: 'webfont' },
    )
    expect(fonts.size).toBe(0)
    expect(context.warnings.map((warning) => warning.code)).toContain('font-coverage-missing')
  })

  whenOnline('fetches a CJK subset that covers the text, for a family that exists', async () => {
    const context = createContext()
    const text = 'ケンオール'
    const fonts = await resolveFonts(
      [{ family: 'Noto Sans JP', weight: 400, style: 'normal', text }],
      { context, mode: 'webfont' },
    )
    const font = [...fonts.values()][0]?.font
    expect(font).toBeDefined()
    // Satori matches on the family the document asked for.
    expect(font!.name).toBe('Noto Sans JP')
    expect(missingGlyphs(font!.data, text)).toEqual([])
  })

  it('gives a misspelt CJK family no font at all, rather than a Latin one', async () => {
    // Nothing corrects a family name any more, so a document naming one that
    // does not exist gets nothing back. `needsWideCoverage` is what keeps that
    // from becoming a Latin substitute rendered as tofu: the label stays as
    // HTML instead — degraded, but not wrong.
    const context = createContext()
    const fonts = await resolveFonts(
      [{ family: 'Noto Sans CJK JP', weight: 400, style: 'normal', text: 'ケン' }],
      { context, offline: true, mode: 'webfont' },
    )
    expect(fonts.size).toBe(0)
    expect(context.warnings.map((warning) => warning.code)).toContain('font-coverage-missing')
  })

  whenOnline('reports a metric-incompatible substitution rather than hiding it', async () => {
    const context = createContext()
    const fonts = await resolveFonts(
      [{ family: 'Lucida Console', weight: 400, style: 'normal', text: '{"a": 1}' }],
      { context, mode: 'webfont' },
    )
    expect([...fonts.values()][0]!.font.metricCompatible).toBe(false)
    expect(context.warnings.map((warning) => warning.code)).toContain('font-substituted-metrics')
  })

  whenOnline('subsets the download to the characters actually used', async () => {
    // A plain request for a CJK family returns a Latin-only subset that covers
    // "A" but no kana; `text=` is a correctness requirement, not a size tweak.
    const context = createContext()
    const fonts = await resolveFonts(
      [{ family: 'Noto Sans JP', weight: 400, style: 'normal', text: 'ケン' }],
      { context, mode: 'webfont' },
    )
    const result = [...fonts.values()][0]!
    expect(result.missing).toEqual([])
    expect(covers(result.font.data, 'ケン')).toBe(true)
    expect(result.font.data.length).toBeLessThan(200_000)
  })
})
