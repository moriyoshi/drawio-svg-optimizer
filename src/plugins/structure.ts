import type { CustomPlugin, PluginConfig, XastChild, XastElement } from 'svgo'

/**
 * Structural cleanup of the shape tree.
 *
 * draw.io wraps every shape in several groups that carry nothing:
 * `<g><g data-cell-id="…"><g transform="translate(-0.5 -0.5)">…`. The reference
 * exports run to 106 and 136 groups for 27 and 60 paths respectively, and the
 * groups outlive the attributes that justified them once `data-cell-id` has been
 * stripped and labels are no longer `<switch>` scaffolding.
 *
 * These are SVGO builtins, listed explicitly rather than pulled in via
 * `preset-default`: that preset also runs passes which mangle `<switch>` and
 * `<foreignObject>`, and it would reorder ours.
 */
export function structuralPlugins(floatPrecision: number): PluginConfig[] {
  return [
    'removeUselessDefs',
    'removeEmptyAttrs',
    'removeEmptyText',
    // Runs before collapseGroups so a group emptied of attributes can then go.
    'removeNonInheritableGroupAttrs',
    'collapseGroups',
    'removeEmptyContainers',
    { name: 'cleanupNumericValues', params: { floatPrecision } },
    { name: 'convertPathData', params: { floatPrecision, transformPrecision: floatPrecision } },
    { name: 'convertTransform', params: { floatPrecision, transformPrecision: floatPrecision } },
    // `mergePaths` is deliberately absent: it is unsafe across differing strokes
    // and fill-rules, which draw.io shapes routinely have.
  ]
}

function isElement(node: XastChild): node is XastElement {
  return node.type === 'element'
}

/** Groups that only exist to hold children, with nothing of their own to say. */
function isPurePassthrough(node: XastElement): boolean {
  if (node.name !== 'g') return false
  return Object.keys(node.attributes).length === 0
}

/**
 * Unwrap groups that wrap a single group and add nothing.
 *
 * SVGO's `collapseGroups` moves attributes down and removes a group only when it
 * can prove the move is safe; it leaves `<g><g>…</g></g>` in place. draw.io emits
 * that shape constantly, so flattening it is worth a pass of its own.
 *
 * A group is only removed when it has no attributes at all, which keeps every
 * transform, clip and style exactly where it was.
 */
export function flattenGroups(): CustomPlugin {
  return {
    name: 'drawio-flatten-groups',
    fn: () => ({
      element: {
        exit: (node) => {
          if (node.children.length === 0) return

          let changed = false
          const children: XastChild[] = []
          for (const child of node.children) {
            if (
              isElement(child) &&
              isPurePassthrough(child) &&
              // Only lift children up through a group that adds nothing, and
              // never out of a <switch>, where sibling order is the semantics.
              node.name !== 'switch'
            ) {
              children.push(...child.children)
              changed = true
              continue
            }
            children.push(child)
          }
          if (changed) node.children = children
        },
      },
    }),
  }
}
