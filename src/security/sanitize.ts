import { findElements } from '../core/scanner.js'
import { classify, STRICT_POLICY } from './policy.js'
import type { NetworkPolicy } from './policy.js'
import type { PassContext } from '../core/types.js'

/**
 * Strip everything in a document that can reach the network or run code.
 *
 * Runs on the raw source, before anything else. That is deliberate: the passes
 * downstream withhold `<foreignObject>` and `<style>` from SVGO (see
 * `core/protect.ts`), so an AST-based sanitizer would never see the label HTML
 * or the CSS — which is where most of the interesting vectors live. Working on
 * the text means one pass covers all three layers.
 *
 * Removal is the policy, not rewriting. A `<script>` with its body replaced is
 * still a `<script>`, and a neutered `href` invites someone to "fix" it later.
 */

/** Elements removed with their contents, whatever they contain. */
const FORBIDDEN_ELEMENTS = [
  // Executes.
  'script',
  'handler',
  // Loads a document or subresource.
  'iframe',
  'frame',
  'object',
  'embed',
  'applet',
  'link',
  'base',
  // `<meta http-equiv="refresh">` navigates; no `<meta>` belongs in a diagram.
  'meta',
  // Media that streams from somewhere.
  'audio',
  'video',
  'source',
  'track',
  // Pulls another document into this one at parse time.
  'include',
  // SMIL that can retarget an attribute — `<set attributeName="href">`.
  'set',
  'animate',
  'animateMotion',
  'animateTransform',
  'animateColor',
  // Fetches an image into a filter graph.
  'feImage',
  // Legacy Firefox binding.
  'binding',
] as const

/**
 * Attributes carrying a URL.
 *
 * `xlink:href` is the SVG 1.1 spelling and still what draw.io writes; `href` is
 * the SVG 2 one. Both appear in the wild, often on the same element.
 */
const URL_ATTRIBUTES = [
  'href',
  'xlink:href',
  'src',
  'srcset',
  'data',
  'poster',
  'action',
  'formaction',
  'background',
  'cite',
  'longdesc',
  'usemap',
  'profile',
  'manifest',
  'archive',
  'codebase',
  'xlink:role',
  'xlink:arcrole',
  'xi:href',
] as const

/** Attributes that are never safe regardless of value. */
const FORBIDDEN_ATTRIBUTES = /^(on\w+|xlink:actuate|http-equiv|srcdoc|ping|formtarget)$/i

export interface SanitizeOptions {
  context: PassContext
  policy?: NetworkPolicy
}

export interface SanitizeResult {
  svg: string
  /** Number of things removed. Zero means the document referenced nothing external. */
  removed: number
}

function report(context: PassContext, code: string, message: string, detail?: string): void {
  context.warn(code, message, detail)
}

/**
 * Remove the DOCTYPE and any stylesheet processing instruction.
 *
 * The DOCTYPE is where entity declarations live. SVGO does not resolve
 * *external* entities — it rejects them outright — but it does expand internal
 * ones, and it preserves an external DTD reference verbatim in the output, where
 * a stricter downstream parser might well fetch it. `<?xml-stylesheet?>` is a
 * plain external fetch that survives the whole pipeline untouched.
 *
 * The `<?xml ?>` declaration itself is kept; it references nothing.
 */
function stripPrologue(svg: string, context: PassContext): { svg: string; removed: number } {
  let removed = 0
  let out = svg

  // A DOCTYPE may carry an internal subset in brackets, which can contain `>`.
  out = out.replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?[^>]*>/gi, (match) => {
    removed += 1
    report(
      context,
      'doctype-removed',
      'Removed the DOCTYPE, which can declare entities and reference an external DTD.',
      match.slice(0, 80),
    )
    return ''
  })

  out = out.replace(/<\?xml-stylesheet[\s\S]*?\?>/gi, (match) => {
    removed += 1
    report(
      context,
      'external-stylesheet-removed',
      'Removed an <?xml-stylesheet?> instruction, which fetches a stylesheet.',
      match.slice(0, 80),
    )
    return ''
  })

  return { svg: out, removed }
}

/**
 * Every spelling of a forbidden element present in the document.
 *
 * Matching is on the *local* name, so a namespace prefix cannot smuggle one
 * past: `<svg:script>`, `<xhtml:iframe>` and `<xi:include>` are the same
 * elements as their unprefixed forms, and a browser treats them as such.
 */
function forbiddenNamesIn(svg: string): string[] {
  const forbidden = new Set<string>(
    (FORBIDDEN_ELEMENTS as readonly string[]).map((name) => name.toLowerCase()),
  )
  const found = new Set<string>()

  for (const match of svg.matchAll(/<\/?([\w.-]+(?::[\w.-]+)?)/g)) {
    const tag = match[1]!
    const local = tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag
    if (forbidden.has(local.toLowerCase())) found.add(tag)
  }
  return [...found]
}

/** Remove whole elements, contents included, honouring nesting. */
function stripElements(svg: string, context: PassContext): { svg: string; removed: number } {
  let out = svg
  let removed = 0

  for (const name of forbiddenNamesIn(svg)) {
    // Re-scan each time: removing one element shifts every later offset.
    for (;;) {
      const span = findElements(out, name)[0]
      if (span === undefined) break
      removed += 1
      report(
        context,
        'element-removed',
        `Removed a <${name}> element, which can execute or load external content.`,
        out.slice(span.start, Math.min(span.end, span.start + 80)),
      )
      out = out.slice(0, span.start) + out.slice(span.end)
    }
  }

  return { svg: out, removed }
}

/**
 * Rewrite `url(...)` and `@import` inside a CSS block.
 *
 * Applies to `<style>` bodies and to inline `style` attributes alike, so a
 * webfont hidden in an `@font-face` inside an `@supports` block is caught by the
 * same code as a `background-image` on a label div.
 */
export function sanitizeCss(
  css: string,
  policy: NetworkPolicy,
  context: PassContext,
): { css: string; removed: number } {
  let removed = 0
  let out = css

  // `@import` takes a bare string as well as `url()`.
  out = out.replace(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?[^;]*;?/gi, (match, raw: string) => {
    const verdict = classify(raw, policy)
    if (verdict.allowed && verdict.kind !== 'external') return match
    if (verdict.allowed) return match
    removed += 1
    report(context, 'css-import-removed', `Removed an @import: ${verdict.reason}.`, raw.slice(0, 80))
    return ''
  })

  out = out.replace(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi, (match, _quote: string, raw: string) => {
    const verdict = classify(raw, policy)
    if (verdict.allowed) return match
    removed += 1
    report(
      context,
      'css-url-removed',
      `Removed a CSS url(): ${verdict.reason}.`,
      raw.slice(0, 80),
    )
    // `none` keeps the declaration syntactically valid where a value is required.
    return 'none'
  })

  // Legacy code execution, in both the shapes it takes: a property whose value
  // is a binding (`behavior`, `-moz-binding`), and IE's `expression()`, which is
  // a *value* and so can sit behind any property at all.
  out = out.replace(/(^|[;{\s])(behavior|-moz-binding)\s*:[^;}]*/gi, (_match, lead: string) => {
    removed += 1
    report(context, 'css-declaration-removed', 'Removed a legacy binding declaration.')
    return lead
  })

  out = out.replace(
    /(^|[;{\s])([\w-]+)\s*:[^;}]*\bexpression\s*\([^;}]*/gi,
    (_match, lead: string) => {
      removed += 1
      report(context, 'css-declaration-removed', 'Removed a declaration using expression().')
      return lead
    },
  )

  return { css: out, removed }
}

/**
 * Sanitize every tag's attributes.
 *
 * Uses a tag scan rather than the SVG AST so the HTML inside `<foreignObject>`
 * is covered by the same rules — an `<img src>` or an `onerror` in a label is
 * exactly as dangerous as one in the SVG proper.
 */
function stripAttributes(
  svg: string,
  policy: NetworkPolicy,
  context: PassContext,
  skip: Array<{ from: number; to: number }>,
): { svg: string; removed: number } {
  let removed = 0
  const edits: Array<{ start: number; end: number; text: string }> = []

  for (const match of svg.matchAll(/<([\w:-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g)) {
    const start = match.index
    if (skip.some((range) => start >= range.from && start < range.to)) continue

    const attributes = match[2] ?? ''
    if (attributes.trim() === '') continue

    let rewritten = attributes
    let changed = false

    for (const attribute of attributes.matchAll(/\s([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = attribute[1]!
      const value = attribute[3] ?? attribute[4] ?? ''

      if (FORBIDDEN_ATTRIBUTES.test(name)) {
        rewritten = rewritten.replace(attribute[0], '')
        changed = true
        removed += 1
        report(context, 'attribute-removed', `Removed the ${name} attribute.`, value.slice(0, 60))
        continue
      }

      if ((URL_ATTRIBUTES as readonly string[]).includes(name.toLowerCase())) {
        const verdict = classify(value, policy)
        if (!verdict.allowed) {
          rewritten = rewritten.replace(attribute[0], '')
          changed = true
          removed += 1
          report(
            context,
            verdict.kind === 'dangerous' ? 'dangerous-reference-removed' : 'external-reference-removed',
            `Removed ${name}: ${verdict.reason}.`,
            value.slice(0, 80),
          )
        }
        continue
      }

      if (name.toLowerCase() === 'style') {
        const cleaned = sanitizeCss(value, policy, context)
        if (cleaned.removed > 0) {
          rewritten = rewritten.replace(attribute[0], ` ${name}="${cleaned.css}"`)
          changed = true
          removed += cleaned.removed
        }
      }
    }

    if (changed) {
      const original = svg.slice(start, start + match[0].length)
      edits.push({
        start,
        end: start + match[0].length,
        text: original.replace(attributes, rewritten),
      })
    }
  }

  let out = svg
  for (const edit of edits.toReversed()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return { svg: out, removed }
}

/**
 * Remove every route a document has to the network, or to executing code.
 *
 * Returns the cleaned source and a count. A count of zero is a useful signal in
 * its own right: the document referenced nothing outside itself.
 */
export function sanitize(svg: string, options: SanitizeOptions): SanitizeResult {
  const policy = options.policy ?? STRICT_POLICY
  const { context } = options
  let removed = 0

  const prologue = stripPrologue(svg, context)
  removed += prologue.removed

  const elements = stripElements(prologue.svg, context)
  removed += elements.removed

  // `<style>` bodies are CSS, not markup: sanitize them as text, and keep the
  // attribute pass out of them.
  let out = elements.svg
  const styleSpans = findElements(out, 'style').filter((span) => !span.selfClosing)
  for (const span of styleSpans.toReversed()) {
    const cleaned = sanitizeCss(out.slice(span.innerStart, span.innerEnd), policy, context)
    removed += cleaned.removed
    out = out.slice(0, span.innerStart) + cleaned.css + out.slice(span.innerEnd)
  }

  const skip = findElements(out, 'style')
    .filter((span) => !span.selfClosing)
    .map((span) => ({ from: span.innerStart, to: span.innerEnd }))

  const attributes = stripAttributes(out, policy, context, skip)
  removed += attributes.removed

  return { svg: attributes.svg, removed }
}
