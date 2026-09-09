import { chromium } from 'playwright'
import type { Browser, Page } from 'playwright'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import { resolveFonts } from '../../src/fonts/resolve.js'
import type { FontRequest } from '../../src/fonts/resolve.js'
import { createContext } from '../../src/core/types.js'
import { toBase64 } from '../../src/fonts/bytes.js'

/**
 * Render an SVG in a real browser and compare it against another.
 *
 * The point of this harness is to check that converting labels to SVG text
 * produces the *same picture* as the `<foreignObject>` it replaced — something
 * the numeric placement tests cannot show, since they only compare coordinates
 * and never ask whether a glyph appears at all.
 *
 * Making that comparison fair takes some care. The reference exports name
 * `Noto Sans JP`, `Helvetica` and `Lucida Console`, none of which exist on a
 * typical Linux box; rendering as-is would compare Chromium's font-fallback
 * behaviour rather than the conversion. So both renders are given the *same*
 * faces — the exact ones the converter shaped with — via `@font-face`, with the
 * original's family names aliased onto them. What is left in the diff is then
 * attributable to the conversion.
 */

/** Families the reference exports name, mapped onto the face that serves them. */
const FONT_ALIASES: Record<string, string> = {
  'Lucida Console': 'Cousine',
}

export interface FontFaceRule {
  family: string
  weight: number
  base64: string
  /** Restricts the face to a subset of characters, making a family composite. */
  unicodeRange?: string
}

/**
 * The ranges a Latin face has to hand off to a CJK one.
 *
 * draw.io labels Japanese text as `Helvetica`, and a browser on a machine with
 * Japanese fonts resolves the missing glyphs through the OS fallback chain. CSS
 * only follows the declared `font-family` list, so the harness reproduces that
 * chain by registering the CJK face under the *same* family name over these
 * ranges — which is exactly the per-character fallback the converter performs.
 * Without it the comparison measures which font Chromium happened to fall back
 * to, not whether the conversion is faithful.
 */
const CJK_RANGES =
  'U+2460-24FF, U+2E80-2EFF, U+3000-303F, U+3040-309F, U+30A0-30FF, ' +
  'U+3200-32FF, U+3400-4DBF, U+4E00-9FFF, U+F900-FAFF, U+FF00-FFEF'

/**
 * Fetch the faces a document needs, through the converter's own resolver.
 *
 * Using `resolveFonts` rather than a separate download is deliberate: the test
 * then renders with precisely the bytes Satori measured, so a mismatch means the
 * conversion is wrong rather than that the test picked a different font.
 */
export async function collectFaces(requests: FontRequest[]): Promise<FontFaceRule[]> {
  const context = createContext()
  const resolved = await resolveFonts(requests, { context })

  const faces: FontFaceRule[] = []
  const latinFamilies = new Set<string>()
  // The widest Japanese face available: the resolver returns per-label subsets,
  // and a subset covering one label would leave the others falling back.
  let japanese: { base64: string; size: number } | undefined

  for (const [key, result] of resolved) {
    const [family, weight] = key.split('|')
    const base64 = toBase64(result.font.data)
    faces.push({ family: family!, weight: Number(weight), base64 })

    if (family === 'Noto Sans JP' || result.font.substitutedFor === 'Noto Sans JP') {
      if (japanese === undefined || result.font.data.length > japanese.size) {
        japanese = { base64, size: result.font.data.length }
      }
    } else {
      latinFamilies.add(family!)
    }

    // Serve the alias under the name the document actually writes.
    for (const [alias, target] of Object.entries(FONT_ALIASES)) {
      if (target === family || result.font.substitutedFor === target) {
        faces.push({ family: alias, weight: Number(weight), base64 })
        if (target !== 'Noto Sans JP') latinFamilies.add(alias)
      }
    }
  }

  // Give every Latin family a CJK companion over the ranges it cannot cover.
  if (japanese !== undefined) {
    for (const family of latinFamilies) {
      for (const weight of [400, 700]) {
        faces.push({
          family,
          weight,
          base64: japanese.base64,
          unicodeRange: CJK_RANGES,
        })
      }
    }
  }

  return faces
}

function fontCss(faces: FontFaceRule[]): string {
  return faces
    .map(
      (face) =>
        `@font-face{font-family:'${face.family}';font-weight:${face.weight};` +
        `src:url(data:font/ttf;base64,${face.base64}) format('truetype');font-display:block` +
        `${face.unicodeRange === undefined ? '' : `;unicode-range:${face.unicodeRange}`}}`,
    )
    .join('')
}

/**
 * Prepare an SVG to be served as its own document.
 *
 * These files are consumed as standalone `.svg`, and that is not a detail: a
 * draw.io export whose labels are `<foreignObject>` renders *differently* when
 * pasted into an HTML page. On `example3.svg` the inline rendering loses more
 * than half its ink — the label boxes, which are `width="100%" height="100%"`,
 * paint over the shapes beneath them. Comparing an optimized file against an
 * inline rendering of the original would therefore measure that bug rather than
 * the conversion, and would score a faithful conversion as a large regression.
 *
 * So the fonts are injected into the SVG's own `<style>` and the document is
 * served with an SVG content type. The original `@import` is dropped: it would
 * pull a face over the network mid-render, making the result depend on timing
 * and on Google's current build of the font rather than on this code.
 */
export function svgDocument(svg: string, faces: FontFaceRule[], hideText = false): string {
  const withoutImports = svg.replace(/@import\s+url\([^)]*\)\s*;?/g, '')
  // Hiding text isolates the shapes, which must be pixel-identical: any
  // difference there is a real geometry change rather than a rasterisation one.
  const hide = hideText ? 'text,foreignObject{visibility:hidden!important}' : ''
  const injected = `<style type="text/css">${fontCss(faces)}${hide}</style>`

  const open = /<svg\b[^>]*>/.exec(withoutImports)
  if (open === null) return withoutImports
  const at = open.index + open[0].length
  return withoutImports.slice(0, at) + injected + withoutImports.slice(at)
}

/** Any URL will do; it only has to be intercepted consistently. */
const DOCUMENT_URL = 'https://drawio-svgo.test/diagram.svg'

export interface Shot {
  png: PNG
  width: number
  height: number
}

async function shoot(
  browser: Browser,
  svg: string,
  faces: FontFaceRule[],
  colorScheme: 'light' | 'dark',
  scale: number,
  hideText = false,
): Promise<Shot> {
  const context = await browser.newContext({ deviceScaleFactor: scale, colorScheme })
  const body = svgDocument(svg, faces, hideText)

  // Serve the document with an SVG content type so the browser treats it as a
  // standalone image, and refuse everything else: nothing should reach the
  // network, and a silent substitution of a different font would invalidate the
  // comparison.
  await context.route('**/*', (route) => {
    if (route.request().url() === DOCUMENT_URL) {
      void route.fulfill({ status: 200, contentType: 'image/svg+xml', body })
      return
    }
    void route.abort()
  })

  const tab: Page = await context.newPage()
  await tab.goto(DOCUMENT_URL, { waitUntil: 'load' })
  await tab.evaluate(() => document.fonts.ready)

  const element = await tab.$('svg')
  if (element === null) throw new Error('no <svg> element in the rendered page')
  const buffer = await element.screenshot({ type: 'png' })
  await context.close()

  const png = PNG.sync.read(buffer)
  return { png, width: png.width, height: png.height }
}

export interface Comparison {
  differing: number
  total: number
  ratio: number
  diff: PNG
}

export async function compare(
  a: string,
  b: string,
  faces: FontFaceRule[],
  options: {
    colorScheme?: 'light' | 'dark'
    scale?: number
    threshold?: number
    /** Average NxN blocks before comparing, to ignore antialiasing differences. */
    downscale?: number
    /** Hide all text, leaving only the shapes. */
    hideText?: boolean
  } = {},
): Promise<Comparison> {
  const browser = await chromium.launch()
  try {
    const scale = options.scale ?? 2
    const scheme = options.colorScheme ?? 'light'
    const hideText = options.hideText ?? false
    const left = await shoot(browser, a, faces, scheme, scale, hideText)
    const right = await shoot(browser, b, faces, scheme, scale, hideText)

    if (left.width !== right.width || left.height !== right.height) {
      throw new Error(
        `rendered sizes differ: ${left.width}x${left.height} vs ${right.width}x${right.height}`,
      )
    }

    const factor = options.downscale ?? 1
    const before = factor > 1 ? downsample(left.png, factor) : left.png
    const after = factor > 1 ? downsample(right.png, factor) : right.png

    const diff = new PNG({ width: before.width, height: before.height })
    const differing = pixelmatch(before.data, after.data, diff.data, before.width, before.height, {
      threshold: options.threshold ?? 0.1,
    })
    return {
      differing,
      total: before.width * before.height,
      ratio: differing / (before.width * before.height),
      diff,
    }
  } finally {
    await browser.close()
  }
}

/** Screenshot one SVG, for checks that do not need a comparison. */
export async function render(
  svg: string,
  faces: FontFaceRule[],
  options: { colorScheme?: 'light' | 'dark'; scale?: number } = {},
): Promise<Shot> {
  const browser = await chromium.launch()
  try {
    return await shoot(
      browser,
      svg,
      faces,
      options.colorScheme ?? 'light',
      options.scale ?? 2,
    )
  } finally {
    await browser.close()
  }
}

/**
 * Box-filter downscale.
 *
 * Chromium rasterises HTML text and SVG text through different antialiasing
 * paths, so the same glyph at the same coordinates still differs by a few
 * percent of edge pixels. Averaging blocks together cancels that while leaving
 * any real displacement, omission or reflow plainly visible — it is the
 * difference between "the text is drawn slightly differently" and "the text
 * moved".
 */
export function downsample(png: PNG, factor: number): PNG {
  const width = Math.max(1, Math.floor(png.width / factor))
  const height = Math.max(1, Math.floor(png.height / factor))
  const out = new PNG({ width, height })

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let dy = 0; dy < factor; dy += 1) {
        for (let dx = 0; dx < factor; dx += 1) {
          const sx = x * factor + dx
          const sy = y * factor + dy
          if (sx >= png.width || sy >= png.height) continue
          const index = (sy * png.width + sx) << 2
          r += png.data[index]!
          g += png.data[index + 1]!
          b += png.data[index + 2]!
          n += 1
        }
      }
      const index = (y * width + x) << 2
      out.data[index] = Math.round(r / n)
      out.data[index + 1] = Math.round(g / n)
      out.data[index + 2] = Math.round(b / n)
      out.data[index + 3] = 255
    }
  }
  return out
}

/** Count of pixels that are not the white background. */
export function inkedPixels(png: PNG): number {
  let inked = 0
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]!
    const g = png.data[i + 1]!
    const b = png.data[i + 2]!
    const a = png.data[i + 3]!
    if (a > 8 && (r < 245 || g < 245 || b < 245)) inked += 1
  }
  return inked
}
