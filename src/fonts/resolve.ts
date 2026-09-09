import { readBundledFont, readFontFile } from './fileFonts.js'
import type { FontBackend } from './backends.js'
import { needsWideCoverage, repairFamily, substituteFamily } from './aliases.js'
import { downloadFont, fetchGoogleFontFaces } from './googleFonts.js'
import type { FetchOptions } from './googleFonts.js'
import { findSystemFont } from './system.js'
import { missingGlyphs } from './coverage.js'
import type { PassContext } from '../core/types.js'

export type FontMode = 'auto' | 'webfont' | 'system' | 'bundled' | 'off'

export interface FontRequest {
  family: string
  weight: number
  style: 'normal' | 'italic'
  /**
   * Every character this face must render.
   *
   * Used both to subset the download and to verify the result: a font that
   * cannot render the label is worse than no font, because Satori would emit
   * tofu rather than fail.
   */
  text?: string
}

/** A font in the shape Satori wants, plus provenance for reporting. */
export interface ResolvedFont {
  name: string
  data: Uint8Array
  weight: number
  style: 'normal' | 'italic'
  source: 'config' | 'bundled' | 'system' | 'webfont'
  /** Set when this is not the family that was asked for. */
  substitutedFor?: string
  /** False when the substitution changes advance widths, i.e. reflows the text. */
  metricCompatible: boolean
}

export interface ResolveOptions extends FetchOptions {
  context: PassContext
  /** @default 'auto' */
  mode?: FontMode
  /**
   * Explicit family -> font, taking precedence over every tier.
   *
   * A string is a file path, which only Node can read. Bytes are accepted
   * everywhere, and are how a page supplies its own faces.
   */
  fontFiles?: Record<string, string | Uint8Array>
  /**
   * Directory the `bundled` tier reads, holding `<Family>-Regular.ttf` and
   * `<Family>-Bold.ttf`. Defaults to a `fonts/` directory beside the package,
   * which is rarely writable once installed.
   */
  fontDir?: string
  /**
   * Where installed fonts come from. `auto` prefers the platform registry,
   * `scanner` walks the font directories instead.
   *
   * @default 'auto'
   */
  fontBackend?: FontBackend
}

async function fromWebfont(
  family: string,
  weight: number,
  style: 'normal' | 'italic',
  options: ResolveOptions & { text?: string },
): Promise<Uint8Array | undefined> {
  const faces = await fetchGoogleFontFaces(family, [weight], options)
  if (faces === undefined) return undefined
  // Prefer an exact style/weight match, else take whatever came back.
  const face =
    faces.find((candidate) => candidate.style === style && candidate.weight === weight) ??
    faces.find((candidate) => candidate.style === style) ??
    faces[0]!
  return downloadFont(face, options)
}

/**
 * Resolve one font through the tiers, in fidelity order.
 *
 * The exact family is tried first from every source, because the real typeface
 * is always the most faithful answer. Only once it is unavailable do we
 * substitute — and a substitution that changes advance widths is reported, since
 * it moves every glyph on the label.
 */
async function resolveOne(
  request: FontRequest,
  options: ResolveOptions,
): Promise<ResolvedFont | undefined> {
  const { context } = options
  const mode = options.mode ?? 'auto'
  if (mode === 'off') return undefined

  const italic = request.style === 'italic'
  const text = request.text ?? ''
  const allow = (tier: FontMode): boolean => mode === 'auto' || mode === tier

  const build = (
    data: Uint8Array,
    source: ResolvedFont['source'],
    family: string,
    metricCompatible: boolean,
  ): ResolvedFont => {
    const font: ResolvedFont = {
      // Satori matches on this name, so it must stay the *requested* family.
      name: request.family,
      data,
      weight: request.weight,
      style: request.style,
      source,
      metricCompatible,
    }
    if (family !== request.family) font.substitutedFor = family
    return font
  }

  const explicit = options.fontFiles?.[request.family]
  if (explicit !== undefined) {
    const data = await readFontFile(explicit)
    if (data !== undefined) return build(data, 'config', request.family, true)
    context.warn(
      'font-config-unreadable',
      `Could not read the configured font for ${request.family}.`,
      typeof explicit === 'string' ? explicit : '(bytes)',
    )
  }

  /** Try one source for one family, accepting it only if it covers the text. */
  const attempt = async (family: string, tier: 'bundled' | 'system' | 'webfont') => {
    if (!allow(tier)) return undefined
    const data =
      tier === 'bundled'
        ? await readBundledFont(family, request.weight, italic, options.fontDir)
        : tier === 'system'
          ? await findSystemFont(family, request.weight, italic, options.fontBackend)
          : await fromWebfont(family, request.weight, request.style, { ...options, text })
    return data
  }

  /** Prefer a tier that covers everything, but accept partial coverage. */
  const attemptCovering = async (family: string) => {
    let partial: { data: Uint8Array; tier: 'bundled' | 'system' | 'webfont' } | undefined
    for (const tier of ['bundled', 'system', 'webfont'] as const) {
      const data = await attempt(family, tier)
      if (data === undefined) continue
      if (missingGlyphs(data, text).length === 0) return { data, tier }
      partial ??= { data, tier }
    }
    return partial
  }

  // Normalised, not corrected — see `aliases.ts`. Kept as a separate candidate
  // so the shape of the search does not depend on what `repairFamily` does.
  const repaired = repairFamily(request.family)
  if (repaired !== request.family) {
    context.warn('font-name-repaired', `Resolved "${request.family}" as "${repaired}".`, repaired)
  }

  const candidates = repaired === request.family ? [request.family] : [request.family, repaired]
  for (const family of candidates) {
    const found = await attemptCovering(family)
    if (found !== undefined) return build(found.data, found.tier, family, true)
  }

  // Every substitute we have is a Latin face, so standing one in for a CJK
  // family would produce tofu. The caller adds a script-appropriate fallback
  // instead, driven by the coverage gap we report.
  if (needsWideCoverage(request.family)) {
    context.warn(
      'font-coverage-missing',
      `"${request.family}" needs non-Latin coverage no substitute provides; labels using it are left as HTML.`,
      request.family,
    )
    return undefined
  }

  const substitution = substituteFamily(request.family)
  if (substitution === undefined) {
    context.warn(
      'font-unavailable',
      `No font could be found for "${request.family}"; labels using it are left as HTML.`,
      request.family,
    )
    return undefined
  }

  const substituted = await attemptCovering(substitution.family)
  if (substituted !== undefined) {
    context.warn(
      substitution.metricCompatible ? 'font-substituted' : 'font-substituted-metrics',
      substitution.metricCompatible
        ? `Substituted "${substitution.family}" for "${request.family}" (metric-compatible).`
        : `Substituted "${substitution.family}" for "${request.family}"; advance widths differ, so text will shift.`,
      request.family,
    )
    return build(substituted.data, substituted.tier, substitution.family, substitution.metricCompatible)
  }

  context.warn(
    'font-unavailable',
    `No font could be found for "${request.family}"; labels using it are left as HTML.`,
    request.family,
  )
  return undefined
}

/** A resolved face together with whatever it still cannot draw. */
export interface FaceResult {
  font: ResolvedFont
  /** Characters the face lacks, for which the caller must supply a fallback. */
  missing: string[]
}

/** Resolve every requested face, de-duplicated and resolved once per run. */
export async function resolveFonts(
  requests: FontRequest[],
  options: ResolveOptions,
): Promise<Map<string, FaceResult>> {
  // Merge the text of every request for the same face, so one download covers
  // all of them and coverage is checked against everything it must render.
  const seen = new Map<string, FontRequest>()
  for (const request of requests) {
    const key = `${request.family}|${request.weight}|${request.style}`
    const existing = seen.get(key)
    if (existing === undefined) seen.set(key, { ...request, text: request.text ?? '' })
    else existing.text = `${existing.text ?? ''}${request.text ?? ''}`
  }

  const resolved = new Map<string, FaceResult>()
  for (const [key, request] of seen) {
    const font = await resolveOne(request, options)
    if (font === undefined) continue
    resolved.set(key, { font, missing: missingGlyphs(font.data, request.text ?? '') })
  }
  return resolved
}
