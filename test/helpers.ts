import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8')
}

/** Concatenated text content of every `<foreignObject>`, tags stripped. */
export function labelText(svg: string): string {
  const blocks = svg.match(/<foreignObject[\s\S]*?<\/foreignObject>/g) ?? []
  return blocks.map((block) => block.replace(/<[^>]+>/g, '')).join('')
}

export function count(svg: string, pattern: RegExp): number {
  return (svg.match(pattern) ?? []).length
}

/**
 * Exports that are pretty-printed rather than minified.
 *
 * A different beast from the minified ones: the indentation inside label markup
 * is whitespace CSS collapses, `pretty-entities.svg` writes its Japanese as
 * numeric character references, and the labels have no fallback of any kind.
 */
export const PRETTY_FIXTURES = ['pretty-entities.svg', 'pretty-medium.svg', 'pretty-large.svg']
