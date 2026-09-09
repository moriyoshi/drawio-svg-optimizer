import type { CustomPlugin, XastChild, XastElement } from 'svgo'
import type { PassContext } from '../core/types.js'

export interface StripMetadataParams {
  context: PassContext
  /**
   * Remove `content="<mxfile>...">`, the embedded copy of the diagram source.
   *
   * This is what makes an exported SVG re-editable in diagrams.net, so removing
   * it is a one-way door. Off in the `safe` preset.
   *
   * @default true
   */
  stripDiagramSource?: boolean
  /**
   * Remove `data-cell-id` attributes. These are draw.io's own cell identifiers;
   * because they are not `id` attributes, SVGO's `cleanupIds` cannot see them.
   *
   * @default true
   */
  stripCellIds?: boolean
  /** Remove `<style>` elements with no content. @default true */
  stripEmptyStyles?: boolean
}

function isElement(node: XastChild): node is XastElement {
  return node.type === 'element'
}

/** Declarations on the root `<svg>` that restate the default and carry no weight. */
const REDUNDANT_ROOT_DECLARATIONS = new Set(['background', 'background-color'])

/**
 * Rewrite the root style, keeping anything load-bearing.
 *
 * `color-scheme: light dark` must survive: it is what makes the `light-dark()`
 * colours throughout a draw.io export resolve to their dark variant. Dropping it
 * would silently break dark mode for the whole diagram.
 */
function pruneRootStyle(style: string): string {
  const kept = style
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      if (declaration === '') return false
      const property = declaration.slice(0, declaration.indexOf(':')).trim().toLowerCase()
      if (!REDUNDANT_ROOT_DECLARATIONS.has(property)) return true
      const value = declaration.slice(declaration.indexOf(':') + 1).trim().toLowerCase()
      return value !== 'transparent' && value !== 'none'
    })
  return kept.join('; ')
}

/** Strip editor bookkeeping that no renderer reads. */
export function stripMetadata(params: StripMetadataParams): CustomPlugin {
  const { context } = params
  const stripDiagramSource = params.stripDiagramSource ?? true
  const stripCellIds = params.stripCellIds ?? true
  const stripEmptyStyles = params.stripEmptyStyles ?? true

  return {
    name: 'drawio-strip-metadata',
    fn: () => ({
      element: {
        enter: (node, parentNode) => {
          if (stripCellIds && node.attributes['data-cell-id'] !== undefined) {
            delete node.attributes['data-cell-id']
          }

          if (node.name === 'svg' && parentNode.type === 'root') {
            if (stripDiagramSource && node.attributes['content'] !== undefined) {
              delete node.attributes['content']
              context.warn(
                'diagram-source-removed',
                'Removed the embedded <mxfile> source; this SVG can no longer be re-edited in diagrams.net.',
              )
            }
            const style = node.attributes['style']
            if (style !== undefined) {
              const pruned = pruneRootStyle(style)
              if (pruned === '') delete node.attributes['style']
              else node.attributes['style'] = pruned
            }
          }

          if (stripEmptyStyles && node.name === 'style') {
            const text = node.children
              .map((child) => (child.type === 'text' || child.type === 'cdata' ? child.value : ''))
              .join('')
            if (text.trim() === '') {
              node.children = []
              // Marked for removal by the parent sweep below.
              node.attributes['data-svgo-empty'] = ''
            }
          }
        },
        exit: (node) => {
          if (!stripEmptyStyles) return
          const doomed = node.children.filter(
            (child) => isElement(child) && child.attributes['data-svgo-empty'] !== undefined,
          )
          if (doomed.length > 0) {
            node.children = node.children.filter((child) => !doomed.includes(child))
          }
        },
      },
    }),
  }
}
