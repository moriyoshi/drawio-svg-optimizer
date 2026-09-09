/**
 * Finding installed fonts without asking the operating system.
 *
 * The registry back-ends are more faithful — they see deactivated fonts, fonts
 * activated from arbitrary places, and the OS's own idea of a family name. But
 * they need a native binary, and not every install wants one: koffi may be
 * absent because the platform has no prebuild, because `--no-optional` was
 * passed, because a lockfile pruned it, or simply because a native dependency
 * is unwelcome. This tier is what makes that a preference rather than a loss of
 * the feature.
 *
 * It walks the platform's font directories with `font-finder`, which reads each
 * file's `name` and `OS/2` tables in pure JavaScript. Measured on a stock Mac:
 * 194 families in 74 ms.
 *
 * `font-finder` enumerates only `.ttf` and `.otf`, which on macOS misses
 * Helvetica and every CJK family, since those ship as collections. Those are
 * picked up separately through `collection.ts` — but lazily, because a
 * collection scan means reading megabytes per file and the common Latin
 * families never need it.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { splitCollection } from './collection.js'
import { familyKey, parseStyleName } from './systemMatch.js'
import type { SystemFontBackend, SystemFontFace } from './backend.js'

/**
 * Both packages are CommonJS with no `exports` map, and neither is optional —
 * this tier is the guaranteed baseline, so a failure to load one is a real
 * error rather than something to degrade past.
 */
const require = createRequire(import.meta.url)

interface FontFinderFont {
  path: string
  weight: number
  style: string
}

interface FontFinder {
  list(options?: {
    concurrency?: number
    onFontError?: (path: string, error: Error) => void
  }): Promise<Record<string, FontFinderFont[]>>
}

type GetSystemFonts = (options?: {
  extensions?: string[]
  additionalFolders?: string[]
}) => Promise<string[]>

type Index = Map<string, SystemFontFace[]>

function add(index: Index, family: string, face: SystemFontFace): void {
  const key = familyKey(family)
  const existing = index.get(key)
  if (existing === undefined) index.set(key, [face])
  else existing.push(face)
}

export function createScannerBackend(): SystemFontBackend {
  const fontFinder = require('font-finder') as FontFinder
  const getSystemFonts = require('get-system-fonts') as GetSystemFonts

  /**
   * The `.ttf`/`.otf` pass, done at most once.
   *
   * `font-finder.listVariants` exists and is the wrong tool: it re-scans the
   * whole system per call and matches family names case-sensitively. One index,
   * built once and keyed on a normalised name, fixes both.
   */
  let plain: Promise<Index> | undefined

  function scanPlain(): Promise<Index> {
    plain ??= (async () => {
      const index: Index = new Map()
      try {
        const list = await fontFinder.list({
          // Without this a single corrupt file rejects the whole scan and the
          // tier goes dark. A font we cannot parse is a font we could not have
          // used, so it is dropped rather than reported.
          onFontError: () => {},
        })
        for (const [family, faces] of Object.entries(list)) {
          for (const face of faces) {
            add(index, family, {
              path: face.path,
              family,
              style: face.style,
              // font-finder reads a real `usWeightClass`, so the style word is
              // consulted only for slant. Stated beats inferred.
              weight: face.weight,
              italic: parseStyleName(face.style).italic,
            })
          }
        }
      } catch {
        // No font directories at all: an unsupported platform, or a container
        // built without any. The tier simply has nothing to offer.
      }
      return index
    })()
    return plain
  }

  /**
   * The `.ttc` pass, deferred until something actually misses.
   *
   * Collections are where macOS keeps Helvetica, Hiragino and PingFang, so
   * skipping them would leave the scanner unable to find exactly the families
   * that matter most here. But reading them is expensive — Hiragino alone is
   * ~7 MB per file — and a request for Arial never needs it.
   */
  let collections: Promise<Index> | undefined

  function scanCollections(): Promise<Index> {
    collections ??= (async () => {
      const index: Index = new Map()
      let paths: string[]
      try {
        paths = await getSystemFonts({ extensions: ['ttc'] })
      } catch {
        return index
      }

      for (const path of paths) {
        try {
          const faces = splitCollection(await readFile(path))
          if (faces === undefined) continue
          for (const face of faces) {
            const { weight, italic } = parseStyleName(face.subfamily)
            add(index, face.family, {
              path,
              family: face.family,
              style: face.subfamily,
              weight,
              italic,
            })
          }
        } catch {
          // Unreadable or malformed: skip it, exactly as the plain pass does.
          continue
        }
      }
      return index
    })()
    return collections
  }

  return {
    name: 'scanner',

    async facesOf(family: string): Promise<SystemFontFace[]> {
      const key = familyKey(family)

      const fromPlain = (await scanPlain()).get(key)
      if (fromPlain !== undefined) return fromPlain

      // Only now is the expensive pass worth its cost.
      return (await scanCollections()).get(key) ?? []
    },
  }
}

let cached: SystemFontBackend | undefined

/** The scanner, built once per process. Its scans are cached inside it. */
export function scannerBackend(): SystemFontBackend {
  cached ??= createScannerBackend()
  return cached
}

/** @internal Drops the cached scanner, and with it both scans. Tests only. */
export function resetScannerCache(): void {
  cached = undefined
}
