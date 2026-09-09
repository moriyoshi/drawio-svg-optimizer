import type { CustomPlugin, XastChild, XastElement } from 'svgo'

export interface SatoriUnwrapParams {
  /** Slot tokens whose label the Satori stage converted to SVG. */
  converted: Set<string>
}

function isElement(node: XastChild): node is XastElement {
  return node.type === 'element'
}

/**
 * Drop the `<switch>` scaffolding around a label Satori has converted.
 *
 * The converted SVG lives in the protected region, so the placeholder element
 * stays where it is and `restoreRegions` swaps the real fragment in afterwards.
 * All this pass has to do is remove the wrapper and the now-redundant fallbacks
 * — the `<text>` draw.io emitted (often truncated) and any raster `<image>`.
 */
export function satoriUnwrap(params: SatoriUnwrapParams): CustomPlugin {
  const { converted } = params

  return {
    name: 'drawio-satori-unwrap',
    fn: () => ({
      element: {
        enter: (node) => {
          if (converted.size === 0) return

          const replacements = new Map<XastChild, XastChild[]>()
          for (const child of node.children) {
            if (!isElement(child) || child.name !== 'switch') continue

            const elements = child.children.filter(isElement)
            const foreignObject = elements.find((each) => each.name === 'foreignObject')
            const slot = foreignObject?.attributes['data-svgo-slot']
            if (foreignObject === undefined || slot === undefined || !converted.has(slot)) continue

            // Keep only the placeholder; the converted SVG replaces it on restore.
            replacements.set(child, [foreignObject])
          }

          if (replacements.size === 0) return
          node.children = node.children.flatMap((child) => replacements.get(child) ?? [child])
        },
      },
    }),
  }
}
