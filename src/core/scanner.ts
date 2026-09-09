/**
 * Minimal, nesting-aware scanner for locating whole elements in raw SVG source.
 *
 * We deliberately avoid a real XML parser here: the whole point of this module is
 * to lift regions *out* of the document before SVGO's parser sees them, because
 * that parser is lossy for our inputs (see `protect.ts`).
 */

export interface ElementSpan {
  /** Tag name as written. */
  name: string
  /** Index of the opening `<`. */
  start: number
  /** Index just past the closing `>`. */
  end: number
  /** Index just past the opening tag's `>`, or -1 when self-closing. */
  innerStart: number
  /** Index of the closing tag's `<`, or -1 when self-closing. */
  innerEnd: number
  selfClosing: boolean
}

/** Skip over a quoted attribute value starting at `i` (which points at the quote). */
function skipQuoted(source: string, i: number): number {
  const quote = source[i]
  const end = source.indexOf(quote!, i + 1)
  return end === -1 ? source.length : end + 1
}

/** Find the index just past the `>` of the tag whose `<` is at `tagStart`. */
function endOfTag(source: string, tagStart: number): number {
  let i = tagStart + 1
  while (i < source.length) {
    const ch = source[i]
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i)
      continue
    }
    if (ch === '>') return i + 1
    i += 1
  }
  return source.length
}

/**
 * Locate every occurrence of `<name>` in `source`, honouring nesting so that a
 * nested element of the same name does not terminate its parent early.
 *
 * Comments, CDATA sections and processing instructions are skipped so that a
 * commented-out tag can never be mistaken for a real one.
 */
export function findElements(source: string, name: string): ElementSpan[] {
  const spans: ElementSpan[] = []
  const open = `<${name}`
  const close = `</${name}`
  let i = 0

  while (i < source.length) {
    if (source.startsWith('<!--', i)) {
      const j = source.indexOf('-->', i)
      i = j === -1 ? source.length : j + 3
      continue
    }
    if (source.startsWith('<![CDATA[', i)) {
      const j = source.indexOf(']]>', i)
      i = j === -1 ? source.length : j + 3
      continue
    }
    if (source.startsWith('<?', i)) {
      const j = source.indexOf('?>', i)
      i = j === -1 ? source.length : j + 2
      continue
    }
    if (!source.startsWith(open, i)) {
      i += 1
      continue
    }

    // Guard against matching `<foreignObjectExtra`.
    const after = source[i + open.length]
    if (after !== undefined && /[\w-]/.test(after)) {
      i += 1
      continue
    }

    const openEnd = endOfTag(source, i)
    if (source[openEnd - 2] === '/') {
      spans.push({
        name,
        start: i,
        end: openEnd,
        innerStart: -1,
        innerEnd: -1,
        selfClosing: true,
      })
      i = openEnd
      continue
    }

    // Walk forward tracking depth until the matching close tag.
    let depth = 1
    let j = openEnd
    let innerEnd = -1
    while (j < source.length && depth > 0) {
      if (source.startsWith('<!--', j)) {
        const k = source.indexOf('-->', j)
        j = k === -1 ? source.length : k + 3
        continue
      }
      if (source.startsWith('<![CDATA[', j)) {
        const k = source.indexOf(']]>', j)
        j = k === -1 ? source.length : k + 3
        continue
      }
      if (source.startsWith(close, j)) {
        depth -= 1
        if (depth === 0) {
          innerEnd = j
          j = endOfTag(source, j)
          break
        }
        j = endOfTag(source, j)
        continue
      }
      if (source.startsWith(open, j)) {
        const nextChar = source[j + open.length]
        if (nextChar === undefined || !/[\w-]/.test(nextChar)) {
          const nestedEnd = endOfTag(source, j)
          if (source[nestedEnd - 2] !== '/') depth += 1
          j = nestedEnd
          continue
        }
      }
      j += 1
    }

    if (innerEnd === -1) {
      // Unterminated element: leave it alone rather than guessing.
      i = openEnd
      continue
    }

    spans.push({
      name,
      start: i,
      end: j,
      innerStart: openEnd,
      innerEnd,
      selfClosing: false,
    })
    i = j
  }

  return spans
}
