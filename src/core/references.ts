import { findElements } from './scanner.js'

/**
 * Collect ids that something in the document actually refers to.
 *
 * SVGO's `cleanupIds` does its own reference scan, but it cannot see the CSS we
 * withhold from it (see `protect.ts`) — and the reference export depends on
 * exactly that: its root `id="ge-svg-…"` is referenced only from an `@supports`
 * rule inside `<style>`, and drives the adaptive background. Removing it would
 * break dark mode silently, so we scan the raw source ourselves and hand the
 * result to `cleanupIds` as `preserve`.
 */
export function collectReferencedIds(svg: string): Set<string> {
  const ids = new Set<string>()

  // url(#id) — fills, strokes, clip-path, mask, filter, markers.
  for (const match of svg.matchAll(/url\(\s*['"]?#([^)'"\s]+)/g)) ids.add(match[1]!)

  // href="#id" / xlink:href="#id" — <use>, gradients, textPath, animation.
  for (const match of svg.matchAll(/(?:xlink:)?href\s*=\s*["']#([^"']+)["']/g)) ids.add(match[1]!)

  // aria-labelledby / aria-describedby take space-separated id lists.
  for (const match of svg.matchAll(/aria-(?:labelledby|describedby)\s*=\s*["']([^"']+)["']/g)) {
    for (const id of match[1]!.split(/\s+/)) if (id !== '') ids.add(id)
  }

  // begin="someId.click" and friends.
  for (const match of svg.matchAll(/\b(?:begin|end)\s*=\s*["']([^"']+)["']/g)) {
    for (const timing of match[1]!.split(';')) {
      const dot = timing.indexOf('.')
      if (dot > 0) ids.add(timing.slice(0, dot).trim())
    }
  }

  // #id selectors inside any <style>, including nested at-rules.
  for (const span of findElements(svg, 'style')) {
    if (span.selfClosing) continue
    const css = svg.slice(span.innerStart, span.innerEnd)
    for (const match of css.matchAll(/#([A-Za-z_][\w-]*)/g)) ids.add(match[1]!)
  }

  return ids
}
