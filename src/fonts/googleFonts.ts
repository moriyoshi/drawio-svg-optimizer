import { createFontCache } from './fontCache.js'
import { isAllowedFontUrl } from '../security/policy.js'

export { defaultCacheDir } from './fontCache.js'

/**
 * Fetch fonts from the Google Fonts CSS API in a format Satori can read.
 *
 * Satori accepts TTF, OTF and WOFF, but *not* WOFF2 — and the CSS API decides
 * which to serve from the `User-Agent`. A modern browser UA gets WOFF2, which is
 * useless to us; a bare `Mozilla/5.0` gets TrueType. That is the whole trick,
 * and it is why the UA below must not be "improved" into something realistic.
 */
const TRUETYPE_USER_AGENT = 'Mozilla/5.0'

export interface FontFace {
  family: string
  weight: number
  style: 'normal' | 'italic'
  url: string
}

export interface FetchOptions {
  /**
   * Restrict the download to the characters actually used.
   *
   * Google Fonts answers a plain CJK request with a Latin-only subset, so for
   * non-Latin text this is not an optimisation but a correctness requirement.
   * It also shrinks a Japanese face from 34 KB to about 3 KB.
   */
  text?: string
  /** Directory for the on-disk font cache. */
  cacheDir?: string
  /** Milliseconds before a network request is abandoned. @default 10000 */
  timeoutMs?: number
  /** Never touch the network; serve only what is already cached. @default false */
  offline?: boolean
}

async function withTimeout(url: string, headers: Record<string, string>, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { headers, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Parse the `@font-face` blocks the CSS API returns. */
export function parseFontFaceCss(css: string): FontFace[] {
  const faces: FontFace[] = []
  for (const match of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const block = match[1]!
    const family = /font-family:\s*['"]?([^;'"]+)['"]?\s*;/.exec(block)?.[1]?.trim()
    const url = /src:[^;]*url\(([^)]+)\)/.exec(block)?.[1]?.replace(/['"]/g, '').trim()
    if (family === undefined || url === undefined) continue
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1] ?? '400')
    const style = /font-style:\s*italic/.test(block) ? 'italic' : 'normal'
    faces.push({ family, weight, style, url })
  }
  return faces
}

/**
 * Look up a family on Google Fonts.
 *
 * Returns `undefined` rather than throwing when the family does not exist: an
 * unknown family is an ordinary outcome — a document may name anything, and a
 * misspelt or private family simply answers 400 — and the caller has other
 * tiers to try.
 */
export async function fetchGoogleFontFaces(
  family: string,
  weights: number[],
  options: FetchOptions = {},
): Promise<FontFace[] | undefined> {
  if (options.offline === true) return undefined

  const spec = `${family.replace(/\s+/g, '+')}:${[...new Set(weights)].toSorted((a, b) => a - b).join(',')}`
  const subset =
    options.text === undefined || options.text === ''
      ? ''
      : `&text=${encodeURIComponent([...new Set(options.text)].join(''))}`
  const url = `https://fonts.googleapis.com/css?family=${spec}${subset}`

  try {
    const response = await withTimeout(
      url,
      { 'User-Agent': TRUETYPE_USER_AGENT },
      options.timeoutMs ?? 10_000,
    )
    if (!response.ok) return undefined
    const css = await response.text()
    // Only keep faces we would be allowed to fetch.
    const faces = parseFontFaceCss(css).filter((face) => isAllowedFontUrl(face.url))
    return faces.length > 0 ? faces : undefined
  } catch {
    // Offline, DNS failure, timeout: indistinguishable here and all recoverable.
    return undefined
  }
}

/**
 * Download a font file, memoised on disk so repeated runs stay offline-capable.
 *
 * The URL comes from a CSS response rather than from us, so it is checked
 * against the font host allowlist before being fetched. Nothing in a document
 * being optimized reaches this code — family *names* are extracted and a URL is
 * built here — but a redirect or a compromised response must not be able to
 * turn font resolution into a request to somewhere else.
 */
export async function downloadFont(
  face: FontFace,
  options: FetchOptions = {},
): Promise<Uint8Array | undefined> {
  if (!isAllowedFontUrl(face.url)) return undefined
  const cache = createFontCache(options.cacheDir)

  const cached = await cache.get(face.url)
  if (cached !== undefined) return cached

  if (options.offline === true) return undefined

  try {
    const response = await withTimeout(face.url, {}, options.timeoutMs ?? 10_000)
    if (!response.ok) return undefined
    const data = new Uint8Array(await response.arrayBuffer())
    await cache.set(face.url, data)
    return data
  } catch {
    return undefined
  }
}
