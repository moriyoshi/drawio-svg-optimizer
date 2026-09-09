import { findElements } from './scanner.js'

/**
 * SVGO's parser and stringifier are lossy for diagrams.net exports:
 *
 *  - `lib/parser.js` calls `.trim()` on the text of any element outside its
 *    `textElems` set. `div` and `span` are not in that set, so the leading
 *    spaces of a `white-space: pre` code block and the ideographic spaces
 *    (U+3000) of a Japanese label are destroyed at *parse* time, before any
 *    plugin runs. On the reference export this silently loses 159 spaces and
 *    10 ideographic spaces.
 *  - `lib/stringifier.js` escapes `[&'"<>]` in every text node, so the CSS
 *    `@import url("...")` inside `<style>` comes back as `url(&quot;...&quot;)`.
 *    That is still valid when the file is parsed as XML, but inline SVG in an
 *    HTML document treats `<style>` as raw text, where it breaks the rule.
 *
 * Neither is configurable, so we lift these regions out of the document before
 * SVGO sees it and splice them back afterwards. Our own passes operate on the
 * extracted source with tools that suit it (an HTML parser for the label
 * markup), which is the right layering regardless of the SVGO bugs.
 */

/** Element names whose *entire subtree* is withheld from SVGO. */
const PROTECTED_SUBTREES = ['foreignObject'] as const

/** Element names whose *text content* is withheld from SVGO. */
const PROTECTED_TEXT = ['style'] as const

// Delimited on both sides: an undelimited `SLOT-1` is a prefix of `SLOT-10`,
// which would make one region overwrite another during restore.
const TOKEN_PREFIX = '__DRAWIO_SVGO_SLOT_'
const TOKEN_SUFFIX = '__'

export interface ProtectedRegion {
  token: string
  kind: 'subtree' | 'text'
  name: string
  /** Original source: the full element for `subtree`, the inner text for `text`. */
  source: string
}

export interface ProtectResult {
  svg: string
  regions: ProtectedRegion[]
}

/**
 * Replace protected regions with inert placeholders.
 *
 * A subtree placeholder keeps the element name (so structural plugins still see
 * a `foreignObject` in the right place) but carries a text child: `foreignObject`
 * is in SVGO's `container` group, and an empty one would be deleted outright by
 * `removeEmptyContainers`.
 */
export function protectRegions(svg: string): ProtectResult {
  const regions: ProtectedRegion[] = []
  const edits: Array<{ start: number; end: number; replacement: string }> = []

  for (const name of PROTECTED_SUBTREES) {
    for (const span of findElements(svg, name)) {
      const token = `${TOKEN_PREFIX}${regions.length}${TOKEN_SUFFIX}`
      regions.push({ token, kind: 'subtree', name, source: svg.slice(span.start, span.end) })
      edits.push({
        start: span.start,
        end: span.end,
        replacement: `<${name} data-svgo-slot="${token}">${token}</${name}>`,
      })
    }
  }

  for (const name of PROTECTED_TEXT) {
    for (const span of findElements(svg, name)) {
      if (span.selfClosing) continue
      const inner = svg.slice(span.innerStart, span.innerEnd)
      if (inner === '') continue
      const token = `${TOKEN_PREFIX}${regions.length}${TOKEN_SUFFIX}`
      regions.push({ token, kind: 'text', name, source: inner })
      edits.push({ start: span.innerStart, end: span.innerEnd, replacement: token })
    }
  }

  // Apply right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start)
  let out = svg
  for (const edit of edits) {
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end)
  }

  return { svg: out, regions }
}

export interface RestoreResult {
  svg: string
  /** Tokens whose placeholder was gone by the time we restored. */
  missing: string[]
}

/**
 * Splice protected regions back in.
 *
 * Placeholders are located by their token rather than by offset, because SVGO
 * rewrites the document freely in between. A region whose placeholder no longer
 * exists was removed by a pass — legitimately, when a label was collapsed onto
 * its `<text>` fallback. The tokens are reported so the caller can tell that
 * apart from a pass eating a label by accident, which would otherwise be a
 * silent content loss.
 */
export function restoreRegions(svg: string, regions: ProtectedRegion[]): RestoreResult {
  const missing: string[] = []
  let out = svg

  for (const region of regions) {
    if (region.kind === 'text') {
      if (!out.includes(region.token)) missing.push(region.token)
      else out = out.replace(region.token, () => region.source)
      continue
    }

    // Match the slot attribute exactly, quotes included, so a token can never
    // be confused with one that merely shares its prefix.
    const marker = `data-svgo-slot="${region.token}"`
    const span = findElements(out, region.name).find((candidate) =>
      out.slice(candidate.start, candidate.end).includes(marker),
    )
    if (span === undefined) {
      missing.push(region.token)
      continue
    }

    // A pass may have moved attributes *onto* the placeholder — `collapseGroups`
    // pushes an enclosing group's transform down onto its only child, which is
    // how draw.io's `translate(-0.5 -0.5)` crispness offset reaches it. Dropping
    // those along with the placeholder would shift the label by half a pixel,
    // so anything the placeholder gained is carried over on a wrapper.
    const openTag = out.slice(span.start, span.innerStart === -1 ? span.end : span.innerStart)
    const carried = openTag
      .slice(region.name.length + 1)
      .replace(/\s*\/?>$/, '')
      .replace(/\sdata-svgo-slot="[^"]*"/, '')
      .trim()
    const replacement = carried === '' ? region.source : merge(region.source, carried)

    out = out.slice(0, span.start) + replacement + out.slice(span.end)
  }

  return { svg: out, missing }
}

/**
 * Fold attributes the placeholder gained into the restored content.
 *
 * When the content is itself a group we merge in place rather than adding a
 * wrapper — SVG transform lists compose left to right, so
 * `translate(-0.5 -0.5) translate(100 200)` is exactly the nesting it replaces,
 * and a later pass can flatten it into a single translate. Wrapping instead
 * would reintroduce one group per label, undoing the structural pass.
 */
function readTranslate(value: string): [number, number] | undefined {
  const match = /^translate\(\s*(-?[\d.]+)(?:[\s,]+(-?[\d.]+))?\s*\)$/.exec(value.trim())
  return match === null ? undefined : [Number(match[1]), Number(match[2] ?? 0)]
}

/** Trim the float noise that summing 65.3 and -0.5 produces. */
function trim(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Sum two `translate()` transforms, or `undefined` if either is something else. */
function composeTranslates(outer: string, inner: string): string | undefined {
  const a = readTranslate(outer)
  const b = readTranslate(inner)
  if (a === undefined || b === undefined) return undefined
  return `translate(${trim(a[0] + b[0])} ${trim(a[1] + b[1])})`
}

function merge(source: string, carried: string): string {
  const match = /^<g(\s[^>]*?)?>/.exec(source)
  if (match === null) return `<g ${carried}>${source}</g>`

  const own = match[1] ?? ''
  const carriedTransform = /\stransform="([^"]*)"/.exec(` ${carried}`)?.[1]
  const ownTransform = /\stransform="([^"]*)"/.exec(own)?.[1]

  const rest = ` ${carried}`.replace(/\stransform="[^"]*"/, '').trim()
  let attributes = own
  if (carriedTransform !== undefined) {
    // The carried transform is the outer one, so it applies first.
    const composed =
      ownTransform === undefined
        ? carriedTransform
        : (composeTranslates(carriedTransform, ownTransform) ??
          `${carriedTransform} ${ownTransform}`)
    attributes =
      ownTransform === undefined
        ? ` transform="${composed}"${own}`
        : own.replace(/\stransform="[^"]*"/, ` transform="${composed}"`)
  }
  if (rest !== '') attributes = `${attributes} ${rest}`

  return `<g${attributes}>${source.slice(match[0].length)}`
}

/** True when the element source is a protection placeholder rather than a real label. */
export function isPlaceholder(source: string): boolean {
  return source.includes(TOKEN_PREFIX)
}
