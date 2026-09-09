import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { splitCollection } from '../src/fonts/collection.js'
import { familyKey, parseStyleName, pickVariant } from '../src/fonts/systemMatch.js'
import type { FontVariant } from '../src/fonts/systemMatch.js'

const face = (
  id: string,
  weight: number,
  italic = false,
  width?: number,
): FontVariant<string> => ({
  handle: id,
  id,
  weight,
  italic,
  ...(width === undefined ? {} : { width }),
})

const chosen = (variants: FontVariant<string>[], weight: number, italic = false): string | undefined =>
  pickVariant(variants, weight, italic)?.id

describe('family keys', () => {
  it('ignores case and runs of whitespace', async () => {
    expect(familyKey('  Noto  Sans   JP ')).toBe('noto sans jp')
    expect(familyKey('ARIAL')).toBe(familyKey('Arial'))
  })

  it('keeps punctuation, which distinguishes real families', async () => {
    // `PT Sans` and `PTSans` are different families; collapsing them would hand
    // back a face the document did not ask for.
    expect(familyKey('PT Sans')).not.toBe(familyKey('PTSans'))
  })
})

describe('style names', () => {
  it('reads the styles a TrueType collection actually uses', async () => {
    // Verbatim from Helvetica.ttc, which is where macOS keeps Helvetica's bold
    // and oblique — there is no separate file to find them in.
    expect(parseStyleName('Regular')).toEqual({ weight: 400, italic: false })
    expect(parseStyleName('Bold')).toEqual({ weight: 700, italic: false })
    expect(parseStyleName('Oblique')).toEqual({ weight: 400, italic: true })
    expect(parseStyleName('Bold Oblique')).toEqual({ weight: 700, italic: true })
    expect(parseStyleName('Light')).toEqual({ weight: 300, italic: false })
    expect(parseStyleName('Light Oblique')).toEqual({ weight: 300, italic: true })
  })

  it('does not read ExtraBold or SemiBold as Bold', async () => {
    // `bold` is a substring of the intent of both, so word order in the table is
    // load-bearing rather than cosmetic.
    expect(parseStyleName('ExtraBold').weight).toBe(800)
    expect(parseStyleName('SemiBold').weight).toBe(600)
    expect(parseStyleName('Extra Bold').weight).toBe(800)
    expect(parseStyleName('DemiBold').weight).toBe(600)
    expect(parseStyleName('UltraLight').weight).toBe(200)
  })

  it('reads the CJK W-notation', async () => {
    // Hiragino names its weights W0-W9 rather than in words; `W3` is the face
    // macOS ships as the regular one.
    expect(parseStyleName('W3')).toEqual({ weight: 300, italic: false })
    expect(parseStyleName('W6')).toEqual({ weight: 600, italic: false })
  })

  it('falls back to regular for styles that say nothing about weight', async () => {
    // PingFang's faces are named `DefaultText` and `DefaultDisplay`.
    expect(parseStyleName('DefaultText')).toEqual({ weight: 400, italic: false })
    expect(parseStyleName('Condensed')).toEqual({ weight: 400, italic: false })
    expect(parseStyleName('')).toEqual({ weight: 400, italic: false })
  })
})

describe('picking a variant', () => {
  it('has nothing to say about an empty list', async () => {
    expect(pickVariant([], 400, false)).toBeUndefined()
  })

  it('searches upward from a normal weight, not to the nearest', async () => {
    // CSS looks 400->500 before falling back below. Nearest-neighbour would
    // pick 350 here, and would be wrong.
    expect(chosen([face('a', 350), face('b', 500)], 400)).toBe('b')
  })

  it('searches downward from a light weight', async () => {
    // Below 400 the search runs downward first, so 100 beats a nearer 400.
    expect(chosen([face('a', 100), face('b', 400)], 300)).toBe('a')
  })

  it('searches upward from a bold weight', async () => {
    expect(chosen([face('a', 300), face('b', 650)], 600)).toBe('b')
  })

  it('falls below when nothing sits in the 400-500 band', async () => {
    expect(chosen([face('a', 300), face('b', 700)], 400)).toBe('a')
  })

  it('prefers the requested slant even at a worse weight', async () => {
    expect(chosen([face('regular', 400, false), face('italic', 900, true)], 400, true)).toBe('italic')
  })

  it('accepts the wrong slant rather than nothing at all', async () => {
    // A roman face is one synthetic oblique from correct; returning undefined
    // sends the caller to the network for a font the machine already has.
    expect(chosen([face('regular', 400, false)], 400, true)).toBe('regular')
  })

  it('prefers normal width, but takes condensed when that is all there is', async () => {
    expect(chosen([face('narrow', 400, false, 3), face('normal', 400, false, 5)], 400)).toBe('normal')
    expect(chosen([face('narrow', 400, false, 3)], 400)).toBe('narrow')
  })

  it('resolves ties the same way whatever order they arrive in', async () => {
    // Directory and registry enumeration order is not stable across machines,
    // and two runs on the same input have to produce the same bytes.
    const a = face('a-face', 400)
    const b = face('b-face', 400)
    expect(chosen([a, b], 400)).toBe('a-face')
    expect(chosen([b, a], 400)).toBe('a-face')
  })
})

/**
 * The two halves together, against a font nobody in this repo wrote.
 *
 * Helvetica exists on macOS only inside a collection, so this is the exact path
 * that was unreachable before: unpack the container, read each face's style,
 * then choose between them.
 */
const HELVETICA = '/System/Library/Fonts/Helvetica.ttc'
const installed = (() => {
  try {
    return splitCollection(readFileSync(HELVETICA))
  } catch {
    return undefined
  }
})()
const whenInstalled = installed !== undefined && installed.length > 0 ? describe : describe.skip

whenInstalled('choosing among the faces of a real collection', () => {
  it('finds each of the styles Helvetica keeps in one file', async () => {
    // Built inside the test, not in the suite body: `describe.skip` still runs
    // the body to collect what it is skipping, so dereferencing `installed`
    // out here fails the file on every machine without Helvetica.ttc.
    const variants = installed!.map((entry, index) => ({
      handle: index,
      id: entry.subfamily,
      ...parseStyleName(entry.subfamily),
    }))

    expect(pickVariant(variants, 400, false)?.id).toBe('Regular')
    expect(pickVariant(variants, 700, false)?.id).toBe('Bold')
    expect(pickVariant(variants, 400, true)?.id).toBe('Oblique')
    expect(pickVariant(variants, 700, true)?.id).toBe('Bold Oblique')
    expect(pickVariant(variants, 300, false)?.id).toBe('Light')
  })
})
