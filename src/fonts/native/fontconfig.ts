/**
 * The Linux font registry, read through fontconfig.
 *
 * This replaces the `fc-match` subprocess the resolver used to shell out to,
 * and is a straight improvement on it: no process spawn per family, no parsing
 * of formatted output, and access to the numeric weight and slant rather than
 * the two buckets a format string could carry.
 *
 * It also fixes the directory problem a scanner cannot. fontconfig's font
 * directories are *configuration* — `/etc/fonts/fonts.conf` and `conf.d` can
 * point anywhere, and distributions and containers routinely do. Asking
 * fontconfig is the only way to see what the system actually considers
 * installed.
 *
 * Plain C throughout: no vtables, no COM, no calling-convention question. The
 * only sharp edges are ownership — `FcFontList` hands back a set the caller
 * must destroy — and the weight scale, which is fontconfig's own and not CSS's.
 */
import type Koffi from 'koffi'
import type { SystemFontBackend, SystemFontFace } from '../backend.js'

/** `.so.1` is the ABI-stable name; the bare `.so` is a development symlink. */
const LIBRARY_NAMES = ['libfontconfig.so.1', 'libfontconfig.so']

/** `FcResult`: 0 is `FcResultMatch`, everything else is a miss. */
const FC_RESULT_MATCH = 0

/** `FcSlant`: 0 roman, 100 italic, 110 oblique. Anything non-zero is sloped. */
const FC_SLANT_ROMAN = 0

/**
 * fontconfig's weight scale is its own: 80 is regular and 200 is bold, not 400
 * and 700. `FcWeightToOpenType` converts, and has existed since 2015 — but on
 * anything older this table is the fallback, keyed by the named constants.
 */
const FALLBACK_WEIGHTS: ReadonlyArray<readonly [number, number]> = [
  [0, 100], // THIN
  [40, 200], // EXTRALIGHT
  [50, 300], // LIGHT
  [75, 380], // BOOK
  [80, 400], // REGULAR
  [100, 500], // MEDIUM
  [180, 600], // SEMIBOLD
  [200, 700], // BOLD
  [205, 800], // EXTRABOLD
  [210, 900], // BLACK
]

function fallbackWeight(value: number): number {
  let best = 400
  let distance = Number.POSITIVE_INFINITY
  for (const [fc, css] of FALLBACK_WEIGHTS) {
    const gap = Math.abs(fc - value)
    if (gap < distance) {
      distance = gap
      best = css
    }
  }
  return best
}

/**
 * Register `FcFontSet`, once per process.
 *
 * koffi registers struct names globally and throws on a duplicate, so a second
 * back-end in the same process would fail without this guard — exactly the bug
 * the Wine harness surfaced in `com.ts`.
 */
function registerTypes(koffi: typeof Koffi): void {
  try {
    koffi.struct('FcFontSet', { nfont: 'int', sfont: 'int', fonts: 'void*' })
  } catch {
    // Already registered by an earlier back-end in this process.
  }
}

function load(koffi: typeof Koffi): ReturnType<typeof Koffi.load> {
  let last: unknown
  for (const name of LIBRARY_NAMES) {
    try {
      return koffi.load(name)
    } catch (error) {
      last = error
    }
  }
  throw last instanceof Error ? last : new Error('fontconfig is not installed')
}

export function createFontconfigBackend(koffi: typeof Koffi): SystemFontBackend {
  registerTypes(koffi)
  const fc = load(koffi)

  const initConfig = fc.func('void* FcInitLoadConfigAndFonts()')
  const patternCreate = fc.func('void* FcPatternCreate()')
  const patternAddString = fc.func('int FcPatternAddString(void*, const char*, const char*)')
  const patternDestroy = fc.func('void FcPatternDestroy(void*)')
  const objectSetCreate = fc.func('void* FcObjectSetCreate()')
  const objectSetAdd = fc.func('int FcObjectSetAdd(void*, const char*)')
  const objectSetDestroy = fc.func('void FcObjectSetDestroy(void*)')
  const fontList = fc.func('FcFontSet* FcFontList(void*, void*, void*)')
  const fontSetDestroy = fc.func('void FcFontSetDestroy(FcFontSet*)')

  // `_Out_ char**` rather than `_Out_ void**` is load-bearing: it makes koffi
  // marshal the string itself. Decoding the raw pointer afterwards segfaults,
  // because koffi reads a `str` type as a pointer *to* a string and would
  // dereference one level too far.
  const patternGetString = fc.func(
    'int FcPatternGetString(void*, const char*, int, _Out_ char**)',
  )
  const patternGetInteger = fc.func('int FcPatternGetInteger(void*, const char*, int, _Out_ int*)')

  // Present since fontconfig 2.11.91 (2015), but absent on genuinely old
  // systems, where the table above stands in.
  let toOpenTypeWeight: ((value: number) => number) | undefined
  try {
    const symbol = fc.func('int FcWeightToOpenType(int)')
    toOpenTypeWeight = (value) => symbol(value) as number
  } catch {
    toOpenTypeWeight = undefined
  }

  const config = initConfig()

  const pointerSize = koffi.sizeof('void*')
  const WANTED = ['family', 'file', 'weight', 'slant', 'width', 'style'] as const

  const readString = (pattern: unknown, property: string): string | undefined => {
    const out = [null] as unknown[]
    if ((patternGetString(pattern, property, 0, out) as number) !== FC_RESULT_MATCH) {
      return undefined
    }
    return typeof out[0] === 'string' ? out[0] : undefined
  }

  const readInteger = (pattern: unknown, property: string): number | undefined => {
    const out = [0]
    if ((patternGetInteger(pattern, property, 0, out) as number) !== FC_RESULT_MATCH) {
      return undefined
    }
    return out[0]
  }

  return {
    name: 'fontconfig',

    async facesOf(family: string): Promise<SystemFontFace[]> {
      if (!config) return []

      let pattern: unknown
      let objects: unknown
      let set: unknown
      try {
        pattern = patternCreate()
        if (!pattern) return []
        patternAddString(pattern, 'family', family)

        objects = objectSetCreate()
        if (!objects) return []
        for (const property of WANTED) objectSetAdd(objects, property)

        // `FcFontList` selects the fonts matching the pattern rather than
        // finding a best substitute the way `FcFontMatch` does. That is the
        // behaviour we want: a family that is not installed must come back
        // empty, because substituting is a later tier's decision.
        set = fontList(config, pattern, objects)
        if (!set) return []

        const header = koffi.decode(set, 'FcFontSet') as { nfont: number; fonts: unknown }
        const faces: SystemFontFace[] = []
        for (let i = 0; i < header.nfont; i += 1) {
          const entry = koffi.decode(header.fonts, i * pointerSize, 'void*')
          if (!entry) continue

          const path = readString(entry, 'file')
          const matched = readString(entry, 'family')
          if (path === undefined || matched === undefined) continue

          const raw = readInteger(entry, 'weight')
          const slant = readInteger(entry, 'slant') ?? FC_SLANT_ROMAN
          const style = readString(entry, 'style')

          faces.push({
            path,
            family: matched,
            ...(style === undefined ? {} : { style }),
            weight:
              raw === undefined ? 400 : (toOpenTypeWeight?.(raw) ?? fallbackWeight(raw)),
            italic: slant !== FC_SLANT_ROMAN,
          })
        }
        return faces
      } finally {
        // `FcFontList` transfers ownership of the set; the pattern and object
        // set are ours from the moment they are created.
        if (set) fontSetDestroy(set)
        if (objects) objectSetDestroy(objects)
        if (pattern) patternDestroy(pattern)
      }
    },
  }
}
