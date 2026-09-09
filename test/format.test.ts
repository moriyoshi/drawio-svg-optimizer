import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fontFormat } from '../src/fonts/format.js'
import { inlineFontFaces } from '../src/plugins/fontImports.js'
import { createContext } from '../src/core/types.js'

const tagged = (tag: string, rest = 64): Uint8Array => {
  const bytes = new Uint8Array(4 + rest)
  bytes.set(new TextEncoder().encode(tag), 0)
  return bytes
}

describe('identifying a font by its bytes', () => {
  it('reads the four-byte signature, not a file extension', async () => {
    // The bytes are not always ours. `fontFiles` takes whatever the caller
    // hands over and an API response has no filename at all, so the signature
    // is the only thing that can be trusted.
    expect(fontFormat(tagged('wOF2'))).toEqual({ mime: 'font/woff2', hint: 'woff2' })
    expect(fontFormat(tagged('wOFF'))).toEqual({ mime: 'font/woff', hint: 'woff' })
    expect(fontFormat(tagged('OTTO'))).toEqual({ mime: 'font/otf', hint: 'opentype' })
    expect(fontFormat(tagged('true'))).toEqual({ mime: 'font/ttf', hint: 'truetype' })
  })

  it('recognises the TrueType version number, which is not a tag', async () => {
    const sfnt = new Uint8Array(16)
    new DataView(sfnt.buffer).setUint32(0, 0x00_01_00_00)
    expect(fontFormat(sfnt)).toEqual({ mime: 'font/ttf', hint: 'truetype' })
  })

  it('gives a collection no format hint rather than a wrong one', async () => {
    // `@font-face` cannot say *which* font in a collection it means. One
    // reaching here means `collection.ts` did not unpack it, which is a bug —
    // and a wrong label would hide it.
    expect(fontFormat(tagged('ttcf'))).toEqual({ mime: 'font/collection' })
  })

  it('falls back to TrueType for anything it cannot place', async () => {
    expect(fontFormat(new Uint8Array(0)).hint).toBe('truetype')
    expect(fontFormat(new TextEncoder().encode('not a font')).hint).toBe('truetype')
  })

  it('identifies a real font off the disk', async () => {
    // Guards against the signature table being right in theory and wrong about
    // what an actual file opens with.
    for (const path of [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]) {
      try {
        expect(fontFormat(readFileSync(path)).hint).toBe('truetype')
        return
      } catch {
        continue
      }
    }
  })
})

describe('embedding faces', () => {
  const embed = (data: Uint8Array): string =>
    inlineFontFaces(
      '<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      new Map([['Test|400|normal', { data, weight: 400, style: 'normal' as const }]]),
      createContext(),
    )

  it('declares WOFF2 as WOFF2', async () => {
    // Chromium sniffs the bytes and loads a mislabelled face regardless —
    // measured, not assumed — so this is about declaring the truth rather than
    // about fixing a rendering failure. The hint is one a user agent is
    // permitted to trust, and other engines need not be as forgiving.
    const svg = embed(tagged('wOF2'))
    expect(svg).toContain('data:font/woff2;base64,')
    expect(svg).toContain("format('woff2')")
    expect(svg).not.toContain('truetype')
  })

  it('declares CFF outlines as opentype', async () => {
    const svg = embed(tagged('OTTO'))
    expect(svg).toContain('data:font/otf;base64,')
    expect(svg).toContain("format('opentype')")
  })

  it('still declares TrueType as truetype', async () => {
    const sfnt = new Uint8Array(64)
    new DataView(sfnt.buffer).setUint32(0, 0x00_01_00_00)
    const svg = embed(sfnt)
    expect(svg).toContain('data:font/ttf;base64,')
    expect(svg).toContain("format('truetype')")
  })

  it('omits the hint entirely rather than emitting an empty one', async () => {
    const svg = embed(tagged('ttcf'))
    expect(svg).toContain('data:font/collection;base64,')
    expect(svg).not.toContain('format()')
    expect(svg).not.toContain("format('')")
  })
})
