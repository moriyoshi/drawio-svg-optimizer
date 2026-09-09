/**
 * The `system` tier: a font the machine already has.
 *
 * This used to shell out to fontconfig's `fc-match`, which meant the tier
 * worked on Linux and nowhere else — no macOS install has that binary unless
 * someone went looking for it, and Windows has no fontconfig at all. It is now
 * two tiers behind one function:
 *
 * - the platform's own font registry, through `backends.ts` — CoreText,
 *   DirectWrite or fontconfig, whichever the machine has;
 * - failing that, a walk of the font directories.
 *
 * Both answer the same question and neither substitutes: a family that is not
 * installed comes back empty, because choosing a stand-in belongs to
 * `resolve.ts` and is reported to the user when it happens.
 */
import { readFile } from 'node:fs/promises'
import { loadFontBackend } from './backends.js'
import type { FontBackend } from './backends.js'
import { splitCollection } from './collection.js'
import { familyKey, parseStyleName, pickVariant } from './systemMatch.js'
import type { FontVariant } from './systemMatch.js'
import type { SystemFontFace } from './backend.js'

/**
 * Font formats Satori can parse. WOFF2 is deliberately absent — it cannot.
 *
 * `.ttc` stays because a collection is unpacked below rather than handed over
 * whole; a registry will happily report `.dfont` and other formats that
 * `@shuding/opentype.js` has never been able to read.
 */
const USABLE = /\.(?:ttf|otf|ttc)$/i

/**
 * Describe a face for matching.
 *
 * Weight and slant are taken as stated when the source states them — DirectWrite
 * and fontconfig both do, and `font-finder` reads a real `usWeightClass` — and
 * inferred from the style name only when it does not, which is CoreText and the
 * faces inside a collection.
 */
function toVariant(face: SystemFontFace): FontVariant<SystemFontFace> {
  const parsed = parseStyleName(face.style ?? '')
  return {
    handle: face,
    id: `${face.path}#${face.style ?? ''}`,
    weight: face.weight ?? parsed.weight,
    italic: face.italic ?? parsed.italic,
  }
}

/**
 * Locate an installed font for `family`, or nothing.
 *
 * The family is matched exactly, case and spacing aside. Registries apply their
 * own alias rules — fontconfig especially — so a result whose family is not the
 * one asked for is discarded rather than accepted as a lucky guess.
 */
export async function findSystemFont(
  family: string,
  weight: number,
  italic: boolean,
  source: FontBackend = 'auto',
): Promise<Uint8Array | undefined> {
  const wanted = familyKey(family)

  const backend = await loadFontBackend({ native: source !== 'scanner' })
  const faces = (await backend.facesOf(family)).filter(
    (face) => familyKey(face.family) === wanted && USABLE.test(face.path),
  )
  if (faces.length === 0) return undefined

  const chosen = pickVariant(faces.map(toVariant), weight, italic)
  if (chosen === undefined) return undefined

  let bytes: Uint8Array
  try {
    bytes = await readFile(chosen.handle.path)
  } catch {
    // Enumerated but since removed, or unreadable. The next tier can try.
    return undefined
  }

  // A collection is several fonts — often several *families* — in one file, so
  // the path alone does not identify a face. macOS keeps Helvetica and every
  // CJK family this way, which is why the tier was useless there before.
  const collection = splitCollection(bytes)
  if (collection === undefined) return bytes

  const inside = collection
    .filter((face) => familyKey(face.family) === wanted)
    .map((face) => ({
      handle: face,
      id: face.subfamily,
      ...parseStyleName(face.subfamily),
    }))

  return pickVariant(inside, weight, italic)?.handle.extract()
}
