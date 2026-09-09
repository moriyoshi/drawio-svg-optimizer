import { findElements } from '../core/scanner.js'
import type { PassContext } from '../core/types.js'
import { toBase64 } from '../fonts/bytes.js'
import { fontFormat } from '../fonts/format.js'

/**
 * Point the document's webfont import at the families its text now names.
 *
 * A draw.io export's `@import` names the families the *document* asked for,
 * which is not the set the converted text ends up naming: a family we could not
 * obtain has been substituted, and one that resolved from elsewhere needs no
 * import at all. Left alone, the import loads the wrong set and every label
 * relying on it renders in whatever the viewer happens to have.
 *
 * Once labels are converted to SVG text we know exactly which families the
 * output names and which of them we proved fetchable, so the import can be
 * rewritten to load precisely those. This matters beyond tidiness: the text is
 * positioned run by run using the metrics of the font we shaped with, so a
 * viewer that substitutes a different face shows visibly misaligned text.
 */
/**
 * Embed the faces the text was shaped with, as `@font-face` data URIs.
 *
 * The self-contained alternative to an `@import`: the file renders identically
 * with no network access at all, which is the only way the output can honour a
 * policy that forbids external references. It is also strictly more faithful —
 * every run is positioned using these exact bytes, so a viewer cannot substitute
 * a different build of the same family.
 *
 * The cost is size. These are subsets covering only the characters used, so they
 * are a few kilobytes each rather than a few megabytes, but base64 still adds a
 * third on top. `--font-delivery import` trades it back.
 */
export function inlineFontFaces(
  svg: string,
  faces: Map<string, { data: Uint8Array; weight: number; style: 'normal' | 'italic' }>,
  context: PassContext,
): string {
  if (faces.size === 0) return svg

  let bytes = 0
  const rules = [...faces]
    .map(([key, face]) => {
      const family = key.slice(0, key.indexOf('|'))
      bytes += face.data.length
      const encoded = toBase64(face.data)
      // Declared from the bytes rather than assumed. Chromium sniffs and would
      // load a mislabelled face anyway, so this is correctness rather than a
      // repair — but `format()` is a hint a user agent is allowed to trust, and
      // `fontFiles` receives WOFF2 whenever a page fetched the font itself.
      const { mime, hint } = fontFormat(face.data)
      const format = hint === undefined ? '' : ` format('${hint}')`
      return (
        `@font-face{font-family:'${family}';font-weight:${face.weight};` +
        `font-style:${face.style};src:url(data:${mime};base64,${encoded})${format}}`
      )
    })
    .join('')

  const [root] = findElements(svg, 'svg')
  if (root === undefined || root.selfClosing) return svg

  context.warn(
    'fonts-embedded',
    `Embedded ${faces.size} font ${faces.size === 1 ? 'subset' : 'subsets'} so the file needs no network access.`,
    `${Math.round(bytes / 1024)}KB of font data before base64`,
  )

  return (
    svg.slice(0, root.innerStart) +
    `<style type="text/css">${rules}</style>` +
    svg.slice(root.innerStart)
  )
}

export function rewriteFontImports(
  svg: string,
  families: Set<string>,
  context: PassContext,
): string {
  const existing = findElements(svg, 'style').filter((span) => !span.selfClosing)
  const importPattern = /@import\s+url\(\s*["']?https:\/\/fonts\.googleapis\.com[^)]*\)\s*;?/g

  if (families.size === 0) {
    // Nothing we can vouch for: drop a Google Fonts import only if it is the
    // broken one, since a working import may still serve surviving HTML labels.
    return svg
  }

  // One import per family, because the rule must not contain an ampersand.
  //
  // A `<style>` body has no encoding that works in both contexts an SVG can be
  // read in: as XML (a standalone .svg) a raw `&` is a parse error and must be
  // written `&amp;`, while as inline SVG in an HTML page `<style>` is a raw-text
  // element where `&amp;` would stay literal and corrupt the URL. Combining
  // families with `&family=` would therefore be broken one way or the other, so
  // the ampersand is avoided entirely. `display=swap` is dropped for the same
  // reason; the default is a fine trade for a file that parses everywhere.
  const rule = [...families]
    .toSorted()
    .map(
      (family) =>
        `@import url("https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}");`,
    )
    .join('')

  let replaced = false
  let out = svg
  for (const span of existing.toReversed()) {
    const css = out.slice(span.innerStart, span.innerEnd)
    if (!importPattern.test(css)) continue
    importPattern.lastIndex = 0
    const next = css.replace(importPattern, replaced ? '' : rule)
    replaced = true
    out = out.slice(0, span.innerStart) + next + out.slice(span.innerEnd)
  }

  if (replaced) {
    context.warn(
      'font-import-rewritten',
      'Rewrote the webfont import to load the families the converted text names.',
      [...families].join(', '),
    )
    return out
  }

  // No import to fix: add one so a viewer without these fonts still matches the
  // metrics the text was positioned with.
  const [root] = findElements(out, 'svg')
  if (root === undefined || root.selfClosing) return out
  context.warn(
    'font-import-added',
    'Added a webfont import so viewers load the families the converted text was measured with.',
    [...families].join(', '),
  )
  return (
    out.slice(0, root.innerStart) +
    `<style type="text/css">${rule}</style>` +
    out.slice(root.innerStart)
  )
}
