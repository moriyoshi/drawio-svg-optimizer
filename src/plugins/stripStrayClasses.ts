import { findElements } from '../core/scanner.js'
import type { PassContext } from '../core/types.js'

/**
 * Remove class names that no rule in the document defines.
 *
 * Some draw.io export paths and, more often, hand-edited or tool-chained SVGs
 * carry class attributes whose rules were never emitted — leftovers from an
 * editor, a theme, or a previous processing step. They cost bytes and mislead
 * anyone reading the file into thinking styling exists where it does not.
 *
 * Anything a `<style>` in the document selects is kept, and so is anything the
 * caller names in `keep`, because a class may legitimately be styled or queried
 * from outside the file. That last point is why this is conservative by design:
 * an unreferenced class is not provably dead, only unused *here*.
 */

export interface StripStrayClassesOptions {
  context: PassContext
  /** Class names to keep even when nothing in the document selects them. */
  keep?: RegExp | undefined
}

/** Class names any selector in the document's CSS mentions. */
export function classesDefinedIn(svg: string): Set<string> {
  const defined = new Set<string>()
  for (const span of findElements(svg, 'style')) {
    if (span.selfClosing) continue
    const css = svg.slice(span.innerStart, span.innerEnd)
    // Strip declaration blocks so a value like `.5em` is never read as a class.
    const selectors = css.replace(/\{[^}]*\}/g, ' ')
    for (const match of selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(match[1]!)
  }
  return defined
}

export function stripStrayClasses(svg: string, options: StripStrayClassesOptions): string {
  const { context, keep } = options
  const defined = classesDefinedIn(svg)

  const skip = findElements(svg, 'style')
    .filter((span) => !span.selfClosing)
    .map((span) => ({ from: span.innerStart, to: span.innerEnd }))

  let removed = 0
  const edits: Array<{ start: number; end: number; text: string }> = []

  for (const match of svg.matchAll(/\sclass="([^"]*)"/g)) {
    const start = match.index
    if (skip.some((range) => start >= range.from && start < range.to)) continue

    const tokens = match[1]!.split(/\s+/).filter((token) => token !== '')
    const kept = tokens.filter((token) => defined.has(token) || keep?.test(token) === true)
    if (kept.length === tokens.length) continue

    removed += tokens.length - kept.length
    edits.push({
      start,
      end: start + match[0].length,
      text: kept.length === 0 ? '' : ` class="${kept.join(' ')}"`,
    })
  }

  if (edits.length === 0) return svg

  let out = svg
  for (const edit of edits.toReversed()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }

  context.warn(
    'stray-classes-removed',
    `Removed ${removed} class ${removed === 1 ? 'name' : 'names'} that no rule defines.`,
  )
  return out
}
