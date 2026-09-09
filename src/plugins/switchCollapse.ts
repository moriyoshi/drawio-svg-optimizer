import type { CustomPlugin, XastChild, XastElement } from 'svgo'
import type { ParsedLabel } from '../html/label.js'
import type { PassContext } from '../core/types.js'

export interface SwitchCollapseParams {
  context: PassContext
  /** Parsed label keyed by the protection slot token on the placeholder. */
  labels: Map<string, ParsedLabel>
  /** Slots the caller has decided to leave for a later pass (e.g. Satori). */
  deferred?: Set<string>
  /** Populated with the slots this pass removes, so their loss is expected. */
  dropped?: Set<string>
}

function isElement(node: XastChild): node is XastElement {
  return node.type === 'element'
}

function textContent(node: XastElement): string {
  let out = ''
  for (const child of node.children) {
    if (child.type === 'text' || child.type === 'cdata') out += child.value
    else if (isElement(child)) out += textContent(child)
  }
  return out
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/** Compare label text ignoring whitespace differences the two renderings legitimately have. */
function equivalent(a: string, b: string): boolean {
  return normalizeWhitespace(a) === normalizeWhitespace(b)
}

/**
 * Collapse `<switch>` wrappers whose `<foreignObject>` a plain `<text>` can replace.
 *
 * draw.io emits `<switch><foreignObject>HTML</foreignObject><text>…</text></switch>`,
 * having already computed the fallback's position, `text-anchor` and font. When
 * the label is a single unstyled run, that fallback *is* the label rendered as
 * SVG — so we can drop the HTML and hoist the text out, exactly and for free,
 * with no font metrics and no layout engine.
 *
 * The text-equivalence check is a hard precondition, not a formality: these
 * files come from third parties, and an export whose fallback was truncated
 * would otherwise lose content silently.
 *
 * `requiredFeatures` was removed in SVG 2, so browsers render the
 * `foreignObject` branch while non-browser renderers take the fallback. Keeping
 * one representation therefore makes the file render *consistently* everywhere,
 * as well as smaller.
 */
export function switchCollapse(params: SwitchCollapseParams): CustomPlugin {
  const { context, labels, deferred, dropped } = params

  return {
    name: 'drawio-switch-collapse',
    fn: () => ({
      element: {
        enter: (node) => {
          const switches = node.children.filter(
            (child) => isElement(child) && child.name === 'switch',
          ) as XastElement[]
          if (switches.length === 0) return

          const replacements = new Map<XastChild, XastChild[]>()

          for (const switchNode of switches) {
            const children = switchNode.children.filter(isElement)
            const foreignObject = children.find((child) => child.name === 'foreignObject')
            if (foreignObject === undefined) continue

            const slot = foreignObject.attributes['data-svgo-slot']
            if (slot === undefined) continue
            if (deferred?.has(slot) === true) continue

            const label = labels.get(slot)
            if (label === undefined || !label.simple) continue

            const texts = children.filter((child) => child.name === 'text')
            if (texts.length === 0) continue

            const fallbackText = texts.map((text) => textContent(text)).join('\n')
            if (!equivalent(fallbackText, label.text)) {
              context.warn(
                'fallback-mismatch',
                'Kept a <foreignObject>: its <text> fallback does not carry the same text.',
                label.text.slice(0, 80),
              )
              continue
            }

            // Hoist everything that is not the HTML branch; drop the <switch>.
            replacements.set(
              switchNode,
              switchNode.children.filter((child) => child !== foreignObject),
            )
            dropped?.add(slot)
          }

          if (replacements.size === 0) return
          node.children = node.children.flatMap((child) => replacements.get(child) ?? [child])
        },
      },
    }),
  }
}
