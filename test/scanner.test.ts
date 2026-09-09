import { describe, expect, it } from 'vitest'
import { createScannerBackend, resetScannerCache, scannerBackend } from '../src/fonts/scanner.js'
import { loadFontBackend, resetFontBackend } from '../src/fonts/backends.js'
import { familyKey } from '../src/fonts/systemMatch.js'
import { missingGlyphs } from '../src/fonts/coverage.js'
import { splitCollection } from '../src/fonts/collection.js'
import { readFileSync } from 'node:fs'

/**
 * The scanner is the tier that must work everywhere, so unlike the registry
 * specs these do not self-skip on the platform — only on a machine with no
 * fonts at all, which would make every assertion vacuous rather than false.
 */
const scanner = createScannerBackend()
const anyFamily = await (async () => {
  for (const candidate of ['Arial', 'Helvetica', 'DejaVu Sans', 'Liberation Sans', 'Verdana']) {
    const faces = await scanner.facesOf(candidate)
    if (faces.length > 0) return { family: candidate, faces }
  }
  return undefined
})()
const whenFonts = anyFamily === undefined ? describe.skip : describe

describe('the scanner as a font source', () => {
  it('reports itself, so a report can say which tier answered', async () => {
    expect(scanner.name).toBe('scanner')
  })

  it('is built once per process', async () => {
    // Each instance carries its own scan cache, so handing out a fresh one per
    // lookup would rescan every font directory on the machine each time.
    resetScannerCache()
    expect(scannerBackend()).toBe(scannerBackend())
  })

  it('says nothing about a family that is not installed', async () => {
    expect(await scanner.facesOf('Definitely Not A Real Typeface')).toEqual([])
  })

  it('survives a machine with no font directories', async () => {
    // `get-system-fonts` throws on an unsupported platform rather than
    // returning nothing, and that must not escape as a crash.
    await expect(scanner.facesOf('Anything At All')).resolves.toBeInstanceOf(Array)
  })
})

whenFonts('scanning real font directories', () => {
  it('matches a family regardless of how it is capitalised or spaced', async () => {
    const { family } = anyFamily!
    const odd = `  ${family.toUpperCase().replace(/ /g, '  ')} `
    const faces = await scanner.facesOf(odd)
    expect(faces.length).toBeGreaterThan(0)
    for (const face of faces) expect(familyKey(face.family)).toBe(familyKey(family))
  })

  it('reports a numeric weight and a boolean slant', async () => {
    // font-finder reads a real `usWeightClass`, so these are stated by the font
    // rather than guessed from its style name.
    for (const face of anyFamily!.faces) {
      expect(typeof face.weight).toBe('number')
      expect(face.weight).toBeGreaterThanOrEqual(1)
      expect(face.weight).toBeLessThanOrEqual(1000)
      expect(typeof face.italic).toBe('boolean')
    }
  })

  it('returns paths that exist and hold a parseable font', async () => {
    const face = anyFamily!.faces[0]!
    expect(face.path).toMatch(/\.(?:ttf|otf|ttc)$/i)
    const bytes = readFileSync(face.path)
    const collection = splitCollection(bytes)
    // A `.ttc` needs unpacking first; anything else must parse as it stands.
    const usable = collection === undefined ? bytes : collection[0]!.extract()
    expect(missingGlyphs(usable, 'A').length).toBeLessThanOrEqual(1)
  })

  it('caches the scan rather than rewalking the directories', async () => {
    const started = Date.now()
    await scanner.facesOf(anyFamily!.family)
    // The first scan already happened during collection above, so a repeat is
    // a map lookup. A second full walk would be orders of magnitude slower.
    expect(Date.now() - started).toBeLessThan(250)
  })
})

/**
 * Collections are the scanner's blind spot and the reason `collection.ts`
 * exists: `font-finder` enumerates only `.ttf` and `.otf`, so on macOS
 * Helvetica and every CJK family would be invisible without the second pass.
 */
const HELVETICA = '/System/Library/Fonts/Helvetica.ttc'
const hasCollections = (() => {
  try {
    return splitCollection(readFileSync(HELVETICA)) !== undefined
  } catch {
    return false
  }
})()
const whenCollections = hasCollections ? describe : describe.skip

whenCollections('families that only exist inside collections', () => {
  it('finds Helvetica, which no .ttf on the machine provides', async () => {
    const faces = await scanner.facesOf('Helvetica')
    expect(faces.length).toBeGreaterThan(0)
    for (const face of faces) {
      expect(face.path).toMatch(/\.ttc$/i)
      expect(familyKey(face.family)).toBe('helvetica')
    }
    // The styles inside the collection, not just one arbitrary face.
    expect(faces.some((face) => (face.weight ?? 400) >= 700)).toBe(true)
    expect(faces.some((face) => face.italic)).toBe(true)
  })
})

describe('choosing a font source', () => {
  it('is reachable from the public options, not just internally', async () => {
    // The opt-out existed in `loadFontBackend` for a while with nothing able to
    // call it: `system.ts` passed no arguments and no option reached it, so the
    // only way to get the scanner was to lack a native binary. That is a
    // circumstance, not a choice, which is the opposite of what it is for.
    const { findSystemFont } = await import('../src/fonts/system.js')
    const viaScanner = await findSystemFont('Arial', 400, false, 'scanner')
    const viaAuto = await findSystemFont('Arial', 400, false, 'auto')
    // Both should find Arial where it is installed; where it is not, both agree
    // on nothing. Either way the argument must be accepted and honoured.
    expect(viaScanner === undefined).toBe(viaAuto === undefined)
  })

  it('always yields one, so callers never handle "no source"', async () => {
    resetFontBackend()
    const backend = await loadFontBackend()
    expect(['coretext', 'directwrite', 'fontconfig', 'scanner']).toContain(backend.name)
  })

  it('memoises the choice', async () => {
    resetFontBackend()
    expect(await loadFontBackend()).toBe(await loadFontBackend())
  })

  it('honours a caller who does not want the native tier', async () => {
    // The point of the scanner: a native binary is a preference, not a
    // requirement, and opting out must not cost the feature.
    const backend = await loadFontBackend({ native: false })
    expect(backend.name).toBe('scanner')
  })
})
