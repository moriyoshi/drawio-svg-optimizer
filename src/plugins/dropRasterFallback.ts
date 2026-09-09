import type { CustomPlugin, XastChild, XastElement } from 'svgo'
import type { PassContext } from '../core/types.js'

export interface DropRasterFallbackParams {
  context: PassContext
  /**
   * Only drop fallbacks whose href is a `data:` URI. A linked image is content
   * we cannot reproduce, so removing it would be destructive.
   *
   * @default true
   */
  dataUriOnly?: boolean
}

function isElement(node: XastChild): node is XastElement {
  return node.type === 'element'
}

function href(node: XastElement): string {
  return node.attributes['xlink:href'] ?? node.attributes['href'] ?? ''
}

/**
 * Remove the rasterised label fallback that diagrams.net emits inside a
 * `<switch>` alongside the `<foreignObject>`.
 *
 * draw.io rasterises the label whenever it cannot guarantee the fallback font
 * will render — notably for CJK text — and embeds it as a base64 PNG. On the
 * reference export these 19 images are 469,716 of 515,741 bytes: 91% of the
 * file raw, and ~99% of the gzip win, because base64 PNG is already-compressed
 * data that gzip cannot touch.
 *
 * Dropping them is safe in every renderer that matters. `requiredFeatures` was
 * removed in SVG 2, so browsers treat the `<switch>` test as always-true and
 * render the `<foreignObject>` regardless; the image is only ever reached by
 * renderers that also ignore `foreignObject`, and for those the right fix is to
 * convert the label to real SVG text rather than to ship a bitmap of it.
 *
 * Scoped strictly to `<image>` that is a direct child of a `<switch>` which also
 * contains a `<foreignObject>`. An `<image>` anywhere else is real diagram
 * content and is never touched.
 */
export function dropRasterFallback(params: DropRasterFallbackParams): CustomPlugin {
  const { context, dataUriOnly = true } = params

  return {
    name: 'drawio-drop-raster-fallback',
    fn: () => ({
      element: {
        enter: (node) => {
          if (node.name !== 'switch') return

          const children = node.children.filter(isElement)
          if (!children.some((child) => child.name === 'foreignObject')) return

          const doomed = new Set<XastChild>()
          for (const child of children) {
            if (child.name !== 'image') continue
            if (dataUriOnly && !href(child).trimStart().startsWith('data:')) {
              context.warn(
                'raster-fallback-kept',
                'Kept a linked <image> fallback inside a <switch>; only data: URIs are removed.',
                href(child).slice(0, 120),
              )
              continue
            }
            doomed.add(child)
          }

          if (doomed.size > 0) {
            node.children = node.children.filter((child) => !doomed.has(child))
          }
        },
      },
    }),
  }
}
