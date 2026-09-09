import satori from 'satori'
import { findElements } from './scanner.js'
import type { ProtectedRegion } from './protect.js'
import type { PassContext } from './types.js'
import { collectFontUsage } from '../html/label.js'
import type { FontUsage, ParsedLabel } from '../html/label.js'
import { toVdom } from '../html/toVdom.js'
import { measure, place, readTextRuns } from './place.js'
import { postprocessSatori } from './satoriPostprocess.js'
import type { ColorPair } from '../html/normalizeCss.js'
import { resolveFonts } from '../fonts/resolve.js'
import { fallbackFamilyFor } from '../fonts/script.js'
import type { FontMode, FontRequest, ResolvedFont, ResolveOptions } from '../fonts/resolve.js'
import type { FontBackend } from '../fonts/backends.js'
import { toArrayBuffer } from '../fonts/bytes.js'

export interface SatoriStageOptions {
  context: PassContext
  /**
   * Families the document itself names, tried before a script default when a
   * label needs glyphs its declared font lacks.
   */
  declaredFamilies?: string[]
  /** @default 'auto' */
  fontMode?: FontMode
  /** Explicit family -> font file path. */
  fontFiles?: Record<string, string | Uint8Array>
  fontDir?: string
  /** Where installed fonts come from. @default 'auto' */
  fontBackend?: FontBackend
  /** Never touch the network. */
  offline?: boolean
  cacheDir?: string
  timeoutMs?: number
  /**
   * Compact the emitted text: merge abutting runs, hoist shared paint
   * attributes and drop Satori's layout bookkeeping.
   *
   * Turning it off keeps Satori's raw output, whose per-run `width` attributes
   * make the geometry directly measurable. The placement tests rely on that.
   *
   * @default true
   */
  compactText?: boolean
}

/** Shaping canvas for labels draw.io marked as non-wrapping (`width: 1px`). */
const SHAPING_WIDTH = 4000
/** Tall enough that a multi-line label is never clipped during shaping. */
const SHAPING_HEIGHT = 4000

/**
 * Point a `font-family` attribute at the family we actually shaped with.
 *
 * Also records it, so the document's webfont import can be corrected to load
 * that family rather than the one draw.io named.
 */
function rewriteFamilies(
  fragment: string,
  resolved: Map<string, string>,
  used: Set<string>,
): string {
  return fragment.replace(/font-family="([^"]*)"/g, (whole, value: string) => {
    const family = resolved.get(value.trim().toLowerCase())
    if (family === undefined) return whole
    used.add(family)
    return `font-family="${family.includes(' ') ? `&apos;${family}&apos;` : family}"`
  })
}

/** Trim float noise; sub-hundredth pixels are not meaningful here. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

export interface SatoriOutcome {
  /** Slots whose region source is now an SVG fragment instead of HTML. */
  converted: Set<string>
  /** Families the converted text names, for the viewer to load. */
  usedFamilies: Set<string>
  /** Of those, the ones we proved are fetchable from Google Fonts. */
  webFamilies: Set<string>
  /** The face bytes actually used, keyed by the family the output names. */
  faces: Map<string, { data: Uint8Array; weight: number; style: 'normal' | 'italic' }>
}

/** Pull the children out of the `<svg>` document Satori returns. */
function unwrapSvg(document: string): string | undefined {
  const [root] = findElements(document, 'svg')
  if (root === undefined || root.selfClosing) return undefined
  return document.slice(root.innerStart, root.innerEnd)
}

/**
 * Put dark mode back.
 *
 * Satori cannot parse `light-dark()`, so the tree it rendered carries only the
 * light colour. Rewriting each of those back into the pair it came from restores
 * the theme adaptivity that the export had and that the conversion would
 * otherwise silently drop.
 */
function restoreLightDark(fragment: string, pairs: Map<string, ColorPair>): string {
  let out = fragment
  for (const { light, dark } of pairs.values()) {
    if (light === dark) continue
    // Satori writes colours into fill/stroke attributes.
    out = out.replaceAll(`fill="${light}"`, `fill="light-dark(${light}, ${dark})"`)
    out = out.replaceAll(`stroke="${light}"`, `stroke="light-dark(${light}, ${dark})"`)
  }
  return out
}

/**
 * Convert labels to native SVG text with Satori.
 *
 * This runs before SVGO and rewrites `region.source` in place: a converted slot
 * carries an SVG fragment, which `restoreRegions` then splices in where the
 * `<foreignObject>` used to be. The `<switch>` wrapper and any sibling fallback
 * are removed separately, by a plugin that consults the returned slot set.
 *
 * Nothing here is allowed to fail loudly. A label we cannot convert keeps its
 * original HTML, which is a worse-optimised but entirely correct document.
 */
export async function runSatoriStage(
  regions: ProtectedRegion[],
  labels: Map<string, ParsedLabel>,
  options: SatoriStageOptions,
): Promise<SatoriOutcome> {
  const { context } = options
  const converted = new Set<string>()
  const usedFamilies = new Set<string>()
  const webFamilies = new Set<string>()
  // Kept so the caller can embed them, making the output self-contained rather
  // than dependent on a webfont request at render time.
  const faces = new Map<string, { data: Uint8Array; weight: number; style: 'normal' | 'italic' }>()

  /**
   * Family the shaped text must name, keyed by what the document asked for.
   *
   * Satori echoes the requested family into `font-family`, so a label naming a
   * family that was substituted — Lucida Console, say, shaped with Cousine —
   * would tell the viewer to load the wrong face. Since we position
   * every run using the metrics of the font we shaped with, that mismatch shows
   * up as visibly misaligned text, so the output has to name the real family.
   */
  const resolvedFamilyFor = new Map<string, string>()

  const convertible = regions.filter((region) => {
    if (region.kind !== 'subtree') return false
    const label = labels.get(region.token)
    return label !== undefined && label.root !== undefined && label.text.trim() !== ''
  })
  if (convertible.length === 0) return { converted, usedFamilies, webFamilies, faces }

  // Collect every face the document needs, with the exact text each must render,
  // so downloads are subsetted and coverage is verified against real content
  // rather than against characters the face was never going to draw.
  const usageByRegion = new Map<string, Map<string, FontUsage>>()
  const requests: FontRequest[] = []
  for (const region of convertible) {
    const label = labels.get(region.token)!
    const usage = collectFontUsage(label.root!)
    usageByRegion.set(region.token, usage)
    for (const face of usage.values()) {
      if (face.text.trim() === '') continue
      requests.push({ family: face.family, weight: face.weight, style: face.style, text: face.text })
    }
  }

  const resolveOptions: ResolveOptions = { context, mode: options.fontMode ?? 'auto' }
  if (options.fontFiles !== undefined) resolveOptions.fontFiles = options.fontFiles
  if (options.offline !== undefined) resolveOptions.offline = options.offline
  if (options.cacheDir !== undefined) resolveOptions.cacheDir = options.cacheDir
  if (options.fontBackend !== undefined) resolveOptions.fontBackend = options.fontBackend
  if (options.timeoutMs !== undefined) resolveOptions.timeoutMs = options.timeoutMs

  const fonts = await resolveFonts(requests, resolveOptions)
  if (fonts.size === 0) {
    context.warn(
      'satori-skipped',
      'No usable fonts were resolved, so every label was left as HTML.',
    )
    return { converted, usedFamilies, webFamilies, faces }
  }

  /**
   * Cover the characters a face is missing.
   *
   * draw.io labels Japanese text as `Helvetica` and puts `東京都` inside a
   * `Lucida Console` code block; a browser resolves both through the system
   * fallback chain. Satori takes a font list and falls back per character, so we
   * append a face that covers the gap. Families the document itself declares are
   * tried first — the reference export's own `@import` names the very Japanese
   * face its Helvetica-labelled text needs.
   */
  const fallbackCache = new Map<string, ResolvedFont | undefined>()
  const coverGap = async (
    missing: string[],
    weight: number,
    style: 'normal' | 'italic',
  ): Promise<ResolvedFont | undefined> => {
    const text = missing.join('')
    const cacheKey = `${text}|${weight}|${style}`
    const cached = fallbackCache.get(cacheKey)
    if (cached !== undefined || fallbackCache.has(cacheKey)) return cached

    const candidates = [...(options.declaredFamilies ?? [])]
    const byScript = fallbackFamilyFor(text)
    if (byScript !== undefined) candidates.push(byScript)

    for (const family of candidates) {
      const found = await resolveFonts([{ family, weight, style, text }], resolveOptions)
      const result = [...found.values()][0]
      if (result !== undefined && result.missing.length === 0) {
        fallbackCache.set(cacheKey, result.font)
        return result.font
      }
    }
    fallbackCache.set(cacheKey, undefined)
    return undefined
  }

  for (const region of convertible) {
    const label = labels.get(region.token)!
    const box = label.box
    if (box === undefined) {
      context.warn(
        'label-kept-as-html',
        'Kept a label as HTML because its layout box could not be read.',
        label.text.slice(0, 60),
      )
      continue
    }

    const { node, colorPairs } = toVdom(label.root!, box.width)

    // Every face the label uses must resolve, and anything it cannot draw needs
    // a fallback, or Satori renders tofu for that part.
    const usage = usageByRegion.get(region.token)!
    const usable: ResolvedFont[] = []
    let uncovered: string | undefined
    for (const [key, face] of usage) {
      if (face.text.trim() === '') continue
      const result = fonts.get(key)
      if (result === undefined) {
        uncovered = face.family
        break
      }
      usable.push(result.font)
      const primary = result.font.substitutedFor ?? result.font.name
      resolvedFamilyFor.set(face.family.toLowerCase(), primary)
      if (result.font.source === 'webfont') webFamilies.add(primary)
      faces.set(`${primary}|${result.font.weight}|${result.font.style}`, {
        data: result.font.data,
        weight: result.font.weight,
        style: result.font.style,
      })
      if (result.missing.length === 0) continue

      const fallback = await coverGap(result.missing, face.weight, face.style)
      if (fallback === undefined) {
        uncovered = `${face.family}" (no font covers "${result.missing.slice(0, 8).join('')}`
        break
      }
      // Satori matches by name, so the fallback must not shadow the primary.
      const fallbackName = fallback.substitutedFor ?? fallback.name
      usable.push({ ...fallback, name: fallbackName })
      resolvedFamilyFor.set(fallbackName.toLowerCase(), fallbackName)
      if (fallback.source === 'webfont') webFamilies.add(fallbackName)
      faces.set(`${fallbackName}|${fallback.weight}|${fallback.style}`, {
        data: fallback.data,
        weight: fallback.weight,
        style: fallback.style,
      })
    }
    if (uncovered !== undefined || usable.length === 0) {
      context.warn(
        'label-kept-as-html',
        `Kept a label as HTML because "${uncovered ?? 'its font'}" could not be resolved.`,
        label.text.slice(0, 60),
      )
      continue
    }

    try {
      // The scaffold has been stripped, so shape the text in a clean box and
      // place the result ourselves; see `core/place.ts`.
      const rendered = await satori(node as never, {
        width: Math.max(1, Math.ceil(box.width > 1 ? box.width : SHAPING_WIDTH)),
        height: SHAPING_HEIGHT,
        fonts: usable.map((font) => ({
          name: font.name,
          // Satori's `FontOptions.data` is `Buffer | ArrayBuffer`, and a plain
          // `Uint8Array` is assignable to neither.
          data: toArrayBuffer(font.data),
          weight: font.weight as never,
          style: font.style,
        })),
        embedFont: false,
      })

      const fragment = unwrapSvg(rendered)
      if (fragment === undefined || !/<text/.test(fragment)) {
        context.warn(
          'label-kept-as-html',
          'Kept a label as HTML because the conversion produced no text.',
          label.text.slice(0, 60),
        )
        continue
      }

      const bounds = measure(readTextRuns(fragment))
      if (bounds === undefined) {
        context.warn(
          'label-kept-as-html',
          'Kept a label as HTML because the shaped text could not be measured.',
          label.text.slice(0, 60),
        )
        continue
      }
      const { dx, dy } = place(box, bounds)

      // Compact the output and hoist shared paint attributes onto the wrapper,
      // which also carries the placement transform.
      const coloured = restoreLightDark(fragment, colorPairs)
      const { body, groupAttributes } =
        options.compactText === false
          ? { body: coloured, groupAttributes: {} as Record<string, string> }
          : postprocessSatori(coloured)
      const attributes = Object.entries(groupAttributes)
        .map(([name, value]) => ` ${name}="${value}"`)
        .join('')
      region.source = rewriteFamilies(
        `<g transform="translate(${round(dx)} ${round(dy)})"${attributes}>${body}</g>`,
        resolvedFamilyFor,
        usedFamilies,
      )
      converted.add(region.token)
    } catch (error) {
      context.warn(
        'label-kept-as-html',
        'Kept a label as HTML because the conversion failed.',
        `${label.text.slice(0, 40)}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return { converted, usedFamilies, webFamilies, faces }
}
