import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loadNativeBackend } from '../src/fonts/native/index.js'
import { splitCollection } from '../src/fonts/collection.js'
import { missingGlyphs } from '../src/fonts/coverage.js'
import { familyKey, parseStyleName, pickVariant } from '../src/fonts/systemMatch.js'

/**
 * The registry is a capability, not a guarantee.
 *
 * It needs Node 26.1 with `--experimental-ffi` (vitest.config.ts supplies the
 * flag where the runtime understands it) and a platform with a back-end.
 * Without one these specs skip and the directory scanner carries the tier — so
 * the suite stays green without ever pretending it exercised code it could not
 * reach.
 *
 * A back-end existing is not the same as the fonts being there, though: every
 * assertion below about *which* faces come back names something Apple ships
 * (Helvetica as a collection, Hiragino for CJK), so those specs want darwin and
 * not merely CoreText. Linux has a back-end — fontconfig — but its font set is
 * whatever the distro installed, which on a bare CI runner is close to nothing;
 * the fontconfig and DirectWrite halves are driven against real registries by
 * `npm run test:e2e:fonts` instead, where the Docker image controls what is
 * installed.
 */
const backend = await loadNativeBackend()
const whenNative = backend === undefined ? describe.skip : describe
const whenAppleFonts = backend !== undefined && process.platform === 'darwin' ? describe : describe.skip

describe('native back-end availability', () => {
  it('degrades to undefined rather than throwing', async () => {
    // The contract every caller depends on: unsupported platform, old Node,
    // missing flag and a failed symbol bind all look the same from outside.
    await expect(loadNativeBackend()).resolves.not.toThrow()
  })

  it('is memoised, because failure is structural rather than transient', async () => {
    // An unflagged runtime does not become flagged mid-process, so a retry per
    // family would pay for a failed dynamic import on every lookup.
    expect(await loadNativeBackend()).toBe(await loadNativeBackend())
  })
})

whenNative('the platform font registry', () => {
  it('says nothing at all about a family that is not installed', async () => {
    // This is the property the old fc-match guard existed to enforce.
    // `CTFontCreateWithName` would answer Helvetica here; the descriptor API
    // returns NULL, which is why it is the one we call.
    expect(await backend!.facesOf('Definitely Not A Real Typeface')).toEqual([])
  })

  it('reports the family it matched, so a substitute can be caught', async () => {
    for (const face of await backend!.facesOf('Arial')) {
      expect(familyKey(face.family)).toBe('arial')
      expect(face.path).toMatch(/\.(?:ttf|otf|ttc)$/i)
    }
  })
})

whenAppleFonts('the platform font registry, against the fonts macOS ships', () => {
  it('finds faces a directory scan cannot reach', async () => {
    // Helvetica exists on macOS only inside a collection. Every one of its
    // styles lives in the same file, so a scan keyed on filenames sees at most
    // one face and more usually none.
    const faces = await backend!.facesOf('Helvetica')
    expect(faces.length).toBeGreaterThan(1)
    expect(new Set(faces.map((face) => face.path)).size).toBe(1)
    expect(faces.map((face) => face.style)).toContain('Bold Oblique')
  })

  it('resolves a request end to end, through the collection', async () => {
    // The whole chain: registry -> style parsing -> CSS matching -> unpack the
    // container -> a font the renderer will accept.
    const faces = await backend!.facesOf('Helvetica')
    const variants = faces.map((face) => ({
      handle: face,
      id: `${face.path}#${face.style ?? ''}`,
      ...parseStyleName(face.style ?? ''),
    }))

    const bold = pickVariant(variants, 700, false)
    expect(bold?.handle.style).toBe('Bold')

    const bytes = readFileSync(bold!.handle.path)
    const collection = splitCollection(bytes)
    expect(collection).toBeDefined()

    const matching = collection!.filter((face) => familyKey(face.family) === 'helvetica')
    const chosen = pickVariant(
      matching.map((face) => ({
        handle: face,
        id: face.subfamily,
        ...parseStyleName(face.subfamily),
      })),
      700,
      false,
    )
    expect(chosen?.handle.subfamily).toBe('Bold')
    expect(missingGlyphs(chosen!.handle.extract(), 'Hello')).toEqual([])
  })

  it('sees the CJK families the scanner misses entirely', async () => {
    // Hiragino is the reason `needsWideCoverage` exists in aliases.ts: before
    // this, no system font could render Japanese, so those labels were left as
    // HTML rather than risking tofu.
    const faces = await backend!.facesOf('Hiragino Sans')
    expect(faces.length).toBeGreaterThan(0)

    const regular = pickVariant(
      faces.map((face) => ({
        handle: face,
        id: face.style ?? face.path,
        ...parseStyleName(face.style ?? ''),
      })),
      400,
      false,
    )
    const collection = splitCollection(readFileSync(regular!.handle.path))!
    const japanese = collection.find((face) => familyKey(face.family) === 'hiragino sans')
    expect(missingGlyphs(japanese!.extract(), 'ケンオール')).toEqual([])
  })
})
