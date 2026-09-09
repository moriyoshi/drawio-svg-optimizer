import { _collections } from 'svgo'
import type { CustomPlugin, PluginConfig, XastChild, XastElement } from 'svgo'
import { dropRasterFallback } from '../plugins/dropRasterFallback.js'
import { stripMetadata } from '../plugins/stripMetadata.js'
import { flattenGroups, structuralPlugins } from '../plugins/structure.js'
import { createContext } from '../core/types.js'
import type { PassContext, Warning } from '../core/types.js'

/**
 * The parts of this optimizer that work as ordinary SVGO plugins.
 *
 * Most passes do: they are synchronous AST rewrites and slot straight into an
 * `svgo.config.js`. Two things do not, and the difference is worth stating
 * plainly rather than discovering later.
 *
 * **What cannot be a plugin.** Converting HTML labels to SVG text needs to fetch
 * fonts and run Satori, both asynchronous. `optimize()` is synchronous: an
 * `async` visitor runs, but SVGO never awaits it, so the mutations land after
 * the tree has already been stringified and are silently discarded. There is no
 * way around that from inside a plugin, so label conversion stays in the async
 * pipeline (`optimizeDrawioSvg`).
 *
 * **What needs a patch first.** SVGO's parser calls `.trim()` on the text of any
 * element outside its `textElems` set, and `div`/`span` are not in it — so the
 * indentation of a `white-space: pre` code block and the ideographic spaces of a
 * Japanese label are destroyed before any plugin runs. `patchTextElements()`
 * repairs that, and every preset here calls it.
 */

/** Elements whose text content draw.io relies on and SVGO would otherwise trim. */
const LABEL_ELEMENTS = ['div', 'span', 'p', 'b', 'i', 'u', 'strike', 'sub', 'sup', 'font'] as const

/**
 * Teach SVGO's parser not to trim the text inside HTML labels.
 *
 * `_collections.textElems` is a live `Set` shared with the parser, so adding to
 * it before `optimize()` changes how the document is read. This is a global
 * mutation of SVGO's own state — the honest description is a monkey-patch — but
 * it is the only place the behaviour can be changed, since the damage happens
 * during parsing and no plugin has run yet.
 *
 * Idempotent, and additive only: nothing is removed, so other plugins keep
 * seeing everything they saw before.
 */
export function patchTextElements(): void {
  for (const name of LABEL_ELEMENTS) _collections.textElems.add(name)
}

function isElement(node: XastChild): node is XastElement {
  return node.type === 'element'
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function textOf(node: XastElement): string {
  let out = ''
  for (const child of node.children) {
    if (child.type === 'text' || child.type === 'cdata') out += child.value
    else if (isElement(child)) out += child.name === 'br' ? '\n' : textOf(child)
  }
  return out
}

/** True when a single `<text>` element can carry this label exactly. */
function isSimpleLabel(foreignObject: XastElement): boolean {
  let styledRuns = 0
  const walk = (node: XastElement): void => {
    for (const child of node.children) {
      if (!isElement(child)) continue
      if (child.name === 'br' || child.name === 'span' || child.name === 'font') styledRuns += 1
      if (child.name === 'b' || child.name === 'i' || child.name === 'u') styledRuns += 1
      walk(child)
    }
  }
  walk(foreignObject)
  return styledRuns === 0
}

/**
 * Collapse a `<switch>` onto the `<text>` fallback draw.io already emitted.
 *
 * The AST-reading twin of the pipeline's `switchCollapse`, which works from the
 * pre-parsed label instead. The text-equivalence check is the same hard
 * precondition and for the same reason: draw.io *truncates* the fallback with an
 * ellipsis when a label overflows its shape, so collapsing onto it unconditionally
 * would silently rewrite the label.
 */
export function collapseSwitches(context: PassContext = createContext()): CustomPlugin {
  return {
    name: 'drawio-collapse-switches',
    fn: () => ({
      element: {
        enter: (node) => {
          const replacements = new Map<XastChild, XastChild[]>()

          for (const child of node.children) {
            if (!isElement(child) || child.name !== 'switch') continue
            const elements = child.children.filter(isElement)
            const foreignObject = elements.find((each) => each.name === 'foreignObject')
            const texts = elements.filter((each) => each.name === 'text')
            if (foreignObject === undefined || texts.length === 0) continue
            if (!isSimpleLabel(foreignObject)) continue

            const fallback = texts.map((each) => textOf(each)).join('\n')
            if (normalise(fallback) !== normalise(textOf(foreignObject))) {
              context.warn(
                'fallback-mismatch',
                'Kept a <foreignObject>: its <text> fallback does not carry the same text.',
                normalise(textOf(foreignObject)).slice(0, 80),
              )
              continue
            }
            replacements.set(child, child.children.filter((each) => each !== foreignObject))
          }

          if (replacements.size === 0) return
          node.children = node.children.flatMap((child) => replacements.get(child) ?? [child])
        },
      },
    }),
  }
}

/**
 * Wrap `<style>` contents in CDATA so the stringifier cannot escape them.
 *
 * `stringifyText` escapes `[&'"<>]` in every text node, which turns
 * `@import url("…?a=1&b=2")` into `url(&quot;…&amp;…&quot;)`. As XML that still
 * parses, but inline SVG in an HTML page treats `<style>` as raw text, where the
 * entities stay literal and the rule breaks.
 *
 * The comment-guarded form — `/*<![CDATA[*\/ … /*]]>*\/` — is unescaped in XML
 * *and* reads as an empty comment to a CSS parser, so it is correct in both.
 */
export function styleCdata(): CustomPlugin {
  return {
    name: 'drawio-style-cdata',
    fn: () => ({
      element: {
        enter: (node) => {
          if (node.name !== 'style') return
          const css = node.children
            .map((child) => (child.type === 'text' || child.type === 'cdata' ? child.value : ''))
            .join('')
          if (css.trim() === '' || !/[&'"<>]/.test(css)) return

          node.children = [
            { type: 'text', value: '/*' },
            { type: 'cdata', value: `*/${css}/*` },
            { type: 'text', value: '*/' },
          ] as XastChild[]
        },
      },
    }),
  }
}

/**
 * `js2svg` options to pair with these plugins.
 *
 * SVGO escapes `[&'"<>]` in every text node, but only `&` and `<` actually need
 * it there — quotes are ordinary characters in text content. The difference is
 * not correctness (both XML and HTML decode `&quot;` in text) but size: the
 * quote-heavy JSON in a draw.io code-block label grows by about 45% for nothing.
 *
 * This cannot be set from a plugin, so it is exported for the config to spread:
 *
 * ```js
 * export default { plugins: drawioPlugins(), js2svg: drawioJs2Svg() }
 * ```
 *
 * Attribute values keep the stricter escaping, which they need.
 */
export function drawioJs2Svg(): { regEntities: RegExp } {
  return { regEntities: /[&<>]/g }
}

export interface DrawioPluginOptions {
  /** Collect warnings from the passes that produce them. */
  context?: PassContext
  /** Remove the embedded `<mxfile>`, which makes the SVG no longer re-editable. */
  stripDiagramSource?: boolean
  /** Collapse redundant groups and tidy path data. @default true */
  structure?: boolean
  /** Decimal places kept on coordinates. @default 2 */
  floatPrecision?: number
}

/**
 * A ready-made plugin list for `svgo.config.js`.
 *
 * ```js
 * import { drawioPlugins } from '@moriyoshi/drawio-svg-optimizer/svgo'
 * export default { plugins: drawioPlugins() }
 * ```
 *
 * Deliberately not `preset-default`-based: that preset runs passes which mangle
 * `<switch>` and `<foreignObject>`, and it would reorder these.
 */
export function drawioPlugins(options: DrawioPluginOptions = {}): PluginConfig[] {
  patchTextElements()

  const context = options.context ?? createContext()
  const plugins: PluginConfig[] = [
    dropRasterFallback({ context }),
    collapseSwitches(context),
    stripMetadata({
      context,
      ...(options.stripDiagramSource === undefined
        ? {}
        : { stripDiagramSource: options.stripDiagramSource }),
    }),
  ]

  if (options.structure ?? true) {
    plugins.push(...structuralPlugins(options.floatPrecision ?? 2), flattenGroups())
  }

  // Runs last so it sees the final CSS, and before nothing else can re-add text.
  plugins.push(styleCdata())
  return plugins
}

export type { PassContext, Warning }
export { createContext }
export { dropRasterFallback, stripMetadata, flattenGroups, structuralPlugins }
