/**
 * Converting HTML labels to SVG text, in a browser, without Satori.
 *
 * Same signature as the Node stage and the same output — a `<g>` carrying a
 * placement transform around `<text>` runs — reached a different way. Satori
 * shapes text from font *files*; this measures what the browser has already
 * laid out. See `domShape.ts` for why that is the better trade here.
 *
 * The practical consequence is that no font has to be fetched, parsed or even
 * be parseable by us. A WOFF2 from Google Fonts, which `@shuding/opentype.js`
 * rejects outright, measures here without trouble. The cost is that there are
 * no font bytes to embed, so `fontDelivery: 'inline'` has nothing to work with.
 */
import { toArrayBuffer } from '../fonts/bytes.js'
import { measure, place } from './place.js'
import { measureRuns, runsToSvg, vnodeToHtml } from './domShape.js'
import { toVdom } from '../html/toVdom.js'
import { postprocessSatori } from './satoriPostprocess.js'
import type { ColorPair } from '../html/normalizeCss.js'
import type { ShapedRun } from './domShape.js'
import type { ParsedLabel } from '../html/label.js'
import type { ProtectedRegion } from './protect.js'
import type { SatoriOutcome, SatoriStageOptions } from './satoriStage.js'

/** Width given to labels draw.io marked as non-wrapping (`width: 1px`). */
const SHAPING_WIDTH = 4000

/** Trim float noise; sub-hundredth pixels are not meaningful here. */
function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * A container that lays out exactly like the page but is never seen.
 *
 * `visibility: hidden` rather than `display: none`: a display-none subtree has
 * no layout at all, so every rectangle would come back zero. Positioning it far
 * off-screen keeps it from affecting scroll extents.
 */
function createStage(document: Document): HTMLElement {
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  // No `contain: size`. It makes the element size itself as if it had no
  // contents, which collapses the box the runs are measured against and
  // produced line baselines 1.2px apart where they should have been 14.4.
  host.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;' +
    'margin:0;padding:0;border:0;line-height:normal'
  document.body.append(host)
  return host
}

/**
 * Put dark mode back.
 *
 * `normalizeStyle` resolves `light-dark()` to its light half before the tree is
 * ever laid out — Satori cannot parse the function, and both backends share that
 * front half — so the colour measured here is always the light one, whatever
 * theme the host page is in. Rewriting it back into the pair it came from is
 * what keeps a converted label adapting to the theme; `example.svg` uses
 * `light-dark()` 199 times, so dropping it is not an edge case.
 *
 * The Node stage matches on the colour string the export authored, because that
 * is what Satori was handed and what it writes back out. Here the colour arrives
 * from `getComputedStyle`, already serialised the browser's way — `#8fb0dc`
 * comes back as `rgb(143, 176, 220)` — so the authored halves have to go through
 * the same serialisation before they can be compared. The browser is the only
 * thing that knows that mapping, and it is right here.
 */
function lightDarkByComputedColor(
  document: Document,
  pairs: Map<string, ColorPair>,
): Map<string, string> {
  const restored = new Map<string, string>()
  if (pairs.size === 0) return restored

  const probe = document.createElement('span')
  probe.setAttribute('aria-hidden', 'true')
  probe.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden'
  document.body.append(probe)
  try {
    for (const { light, dark } of pairs.values()) {
      if (light === dark) continue
      // `currentColor` resolves against whatever element it sits on, so there is
      // no single colour to key it by. Leaving those runs alone loses the dark
      // half, which is what happened before this existed; guessing would lose
      // the light one too.
      if (/\bcurrentcolor\b/i.test(light)) continue

      probe.style.color = ''
      probe.style.color = light
      // An unparseable colour leaves the property unset rather than throwing,
      // and reading the computed style then reports the inherited colour — which
      // would map an unrelated black onto this pair.
      if (probe.style.color === '') continue
      const computed = getComputedStyle(probe).color
      if (computed === '') continue
      restored.set(computed, `light-dark(${light}, ${dark})`)
    }
  } finally {
    probe.remove()
  }
  return restored
}

/** Rewrite each measured fill into the `light-dark()` pair it was resolved from. */
function restoreLightDark(runs: ShapedRun[], restored: Map<string, string>): void {
  if (restored.size === 0) return
  for (const run of runs) {
    const pair = restored.get(run.fill)
    if (pair !== undefined) run.fill = pair
  }
}

/**
 * Make the caller's own fonts available to the layout engine, and keep the
 * bytes so the same faces can be embedded afterwards.
 *
 * This is what makes browser output portable. Measuring with the browser's
 * fonts and then embedding bytes from somewhere else would be worse than
 * embedding nothing — the positions would come from one face and the embedded
 * font would be another, so every run would land wrong with an air of
 * authority. Registering the supplied bytes first means the face that is
 * measured and the face that is shipped are the same one.
 *
 * A single file serves every weight of a family, matching how `fontFiles`
 * already behaves on Node.
 */
async function registerSuppliedFonts(
  fontFiles: SatoriStageOptions['fontFiles'],
  faces: SatoriOutcome['faces'],
  context: SatoriStageOptions['context'],
): Promise<void> {
  for (const [family, source] of Object.entries(fontFiles ?? {})) {
    if (typeof source === 'string') {
      context.warn(
        'font-config-unreadable',
        `Could not read the configured font for ${family}: a browser has no filesystem, so fontFiles needs the bytes rather than a path.`,
        source,
      )
      continue
    }
    try {
      const face = new FontFace(family, toArrayBuffer(source))
      await face.load()
      globalThis.document.fonts.add(face)
      faces.set(`${family}|400|normal`, { data: source, weight: 400, style: 'normal' })
    } catch (error) {
      context.warn(
        'font-config-unreadable',
        `Could not load the supplied font for ${family}.`,
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

export async function runSatoriStage(
  regions: ProtectedRegion[],
  labels: Map<string, ParsedLabel>,
  options: SatoriStageOptions,
): Promise<SatoriOutcome> {
  const { context } = options
  const converted = new Set<string>()
  const usedFamilies = new Set<string>()
  const webFamilies = new Set<string>()
  const faces: SatoriOutcome['faces'] = new Map()

  const host = createStage(globalThis.document)
  const canvas = globalThis.document.createElement('canvas').getContext('2d')
  if (canvas === null) {
    context.warn(
      'label-kept-as-html',
      'Kept every label as HTML because a 2D canvas context was refused, and text cannot be measured without one.',
    )
    host.remove()
    return { converted, usedFamilies, webFamilies, faces }
  }

  await registerSuppliedFonts(options.fontFiles, faces, context)

  // Webfonts the page declared may still be in flight. Measuring before they
  // land would size every run against a fallback face and place the text wrong
  // in a way nothing downstream could detect.
  try {
    await globalThis.document.fonts.ready
  } catch {
    // No FontFaceSet: measure with whatever is available.
  }

  try {
    for (const region of regions) {
      if (region.kind !== 'subtree') continue
      const label = labels.get(region.token)
      if (label?.root === undefined || label.box === undefined) continue
      const box = label.box

      const { node, fontFamilies, colorPairs } = toVdom(label.root, box.width)
      for (const family of fontFamilies) usedFamilies.add(family)

      host.style.width = `${Math.max(1, Math.ceil(box.width > 1 ? box.width : SHAPING_WIDTH))}px`
      host.innerHTML = vnodeToHtml(node)

      const runs = measureRuns(host, canvas)
      if (runs.length === 0) {
        context.warn(
          'label-kept-as-html',
          'Kept a label as HTML because the conversion produced no text.',
          label.text.slice(0, 60),
        )
        continue
      }

      const bounds = measure(runs)
      if (bounds === undefined) {
        context.warn(
          'label-kept-as-html',
          'Kept a label as HTML because the shaped text could not be measured.',
          label.text.slice(0, 60),
        )
        continue
      }
      const { dx, dy } = place(box, bounds)

      // After measuring and placing: a `light-dark()` fill is not a colour the
      // geometry ever needed, and `measure` reads nothing but rectangles.
      restoreLightDark(runs, lightDarkByComputedColor(globalThis.document, colorPairs))

      const fragment = runsToSvg(runs, round)
      const { body, groupAttributes } =
        options.compactText === false
          ? { body: fragment, groupAttributes: {} as Record<string, string> }
          : postprocessSatori(fragment)
      const attributes = Object.entries(groupAttributes)
        .map(([name, value]) => ` ${name}="${value}"`)
        .join('')

      region.source = `<g transform="translate(${round(dx)} ${round(dy)})"${attributes}>${body}</g>`
      converted.add(region.token)
    }
  } finally {
    host.remove()
  }

  // Only when there is genuinely nothing to embed. With supplied bytes the
  // generic `fonts-not-supplied` warning already covers the delivery choice,
  // and two warnings saying nearly the same thing is worse than one.
  if (converted.size > 0 && faces.size === 0) {
    context.warn(
      'fonts-measured-locally',
      'Text was shaped with this browser’s own fonts, so there are no font bytes to embed and a viewer without the same fonts will see slightly different widths. Pass the bytes as `fontFiles` to embed them.',
      [...usedFamilies].join(', '),
    )
  }

  return { converted, usedFamilies, webFamilies, faces }
}
