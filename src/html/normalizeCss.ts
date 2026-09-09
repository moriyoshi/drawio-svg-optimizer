/**
 * Translate draw.io's label CSS into the subset Satori understands.
 *
 * Every rule here exists because of something real in an export, not because of
 * a hypothetical. Satori does not support `light-dark()`, `display:inline-block`,
 * `calc()` or `currentColor` outside the `color` property — and a single draw.io
 * label routinely uses three of those at once:
 *
 *   <div style="display: inline-block; font-size: 8px; font-family: Helvetica;
 *               color: light-dark(#000000, #ffffff);
 *               background-color: light-dark(default, #32a0ae);">
 *
 * Note `background-color: default`, which is not valid CSS at all. Anything we
 * cannot make sense of is dropped rather than passed through, because Satori
 * throws on values it cannot parse and one bad declaration would cost the whole
 * label.
 */

/** Colours we replaced, so the dark half of `light-dark()` can be restored later. */
export interface ColorPair {
  light: string
  dark: string
}

export interface NormalizeResult {
  style: Record<string, string | number>
  /** Light value -> the pair it came from, for re-applying dark mode afterwards. */
  colorPairs: Map<string, ColorPair>
}

/** CSS properties Satori ignores, or that actively confuse it. */
const DROPPED = new Set([
  'box-sizing', // Satori is always border-box.
  'pointer-events',
  'overflow',
  'text-overflow',
  'cursor',
  'user-select',
  'direction',
  'unicode-bidi',
  'vertical-align',
  'word-wrap', // Translated to word-break below.
  'white-space-collapse',
  'zoom',
  'isolation',
])

const CAMEL_CASE_EXCEPTIONS = new Set(['-webkit-line-clamp'])

function toCamelCase(property: string): string {
  if (CAMEL_CASE_EXCEPTIONS.has(property)) return 'WebkitLineClamp'
  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}

/** Split the arguments of a CSS function, respecting nesting. */
function splitArguments(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  parts.push(value.slice(start).trim())
  return parts
}

/** `default` is draw.io's own invalid placeholder; treat it as "not set". */
function isInvalidValue(value: string): boolean {
  const lower = value.trim().toLowerCase()
  return lower === '' || lower === 'default' || lower === 'initial' || lower === 'unset'
}

/**
 * Resolve `light-dark(a, b)` to its light half.
 *
 * The dark half is not discarded: it is returned so the caller can rewrite the
 * rendered `fill` back into a `light-dark()` pair. Without that, converting a
 * label to SVG would silently kill dark mode — and the reference export uses
 * `light-dark()` 199 times, so this is the common case, not an edge case.
 */
function resolveLightDark(value: string, pairs: Map<string, ColorPair>): string | undefined {
  const match = /^light-dark\(([\s\S]*)\)$/i.exec(value.trim())
  if (match === null) return value

  const [light, dark] = splitArguments(match[1]!)
  if (light === undefined || isInvalidValue(light)) return undefined
  if (dark !== undefined && !isInvalidValue(dark)) {
    pairs.set(light.trim(), { light: light.trim(), dark: dark.trim() })
  }
  return light.trim()
}

/** Strip the `safe`/`unsafe` overflow-alignment keywords Satori does not parse. */
function stripAlignmentSafety(value: string): string {
  return value.replace(/\b(un)?safe\s+/gi, '').trim()
}

function parseLength(value: string): number | undefined {
  const match = /^(-?[\d.]+)(px)?$/.exec(value.trim())
  return match === null ? undefined : Number(match[1])
}

/**
 * Normalize one declaration block.
 *
 * Returns Satori-shaped camelCase properties. Declarations that cannot be
 * represented are omitted entirely — a missing property renders with Satori's
 * default, whereas an unparseable one aborts the whole label.
 */
export function normalizeStyle(
  declarations: Record<string, string>,
  pairs: Map<string, ColorPair> = new Map(),
): NormalizeResult {
  const style: Record<string, string | number> = {}

  for (const [rawProperty, rawValue] of Object.entries(declarations)) {
    const property = rawProperty.trim().toLowerCase()
    if (DROPPED.has(property)) continue

    let value = rawValue.trim()
    if (isInvalidValue(value)) continue

    // `currentColor` is only supported on `color` itself.
    if (/\bcurrentcolor\b/i.test(value) && property !== 'color') continue

    if (/^light-dark\(/i.test(value)) {
      const resolved = resolveLightDark(value, pairs)
      if (resolved === undefined) continue
      value = resolved
    }

    switch (property) {
      case 'display': {
        // Satori has no inline-block; a column flex box behaves the same for the
        // single-line label boxes draw.io emits.
        if (value === 'inline-block' || value === 'inline-flex' || value === 'inline') {
          style['display'] = 'flex'
          style['flexDirection'] = 'column'
          continue
        }
        if (value === 'table' || value === 'grid' || value === 'inline-table') continue
        style['display'] = value
        continue
      }

      case 'align-items':
      case 'justify-content':
      case 'align-self':
      case 'align-content': {
        style[toCamelCase(property)] = stripAlignmentSafety(value)
        continue
      }

      case 'font-family': {
        // draw.io writes `&quot;Lucida Console&quot;` into the style attribute.
        style['fontFamily'] = value
          .split(',')
          .map((family) => family.trim().replace(/&quot;/g, '').replace(/^["']|["']$/g, ''))
          .filter((family) => family !== '')
          .join(', ')
        continue
      }

      case 'font-size': {
        const size = parseLength(value)
        // draw.io sets `font-size: 0` on a wrapper to collapse inline-block
        // whitespace. Satori would render the text invisibly small instead.
        if (size === undefined || size === 0) continue
        style['fontSize'] = size
        continue
      }

      case 'border':
      case 'border-width': {
        // Zero-width borders carry the unsupported `currentcolor` and paint
        // nothing, so they are pure noise.
        if (/(^|\s)0(px)?(\s|$)/.test(value)) continue
        style[toCamelCase(property)] = value
        continue
      }

      case 'word-break':
      case 'overflow-wrap': {
        style['wordBreak'] = value === 'break-word' ? 'break-word' : value
        continue
      }

      case 'line-height': {
        const length = parseLength(value)
        style['lineHeight'] = length ?? value
        continue
      }

      case 'background-color':
      case 'background': {
        style[toCamelCase(property)] = value
        continue
      }

      default: {
        if (/\bcalc\(/i.test(value)) continue
        style[toCamelCase(property)] = value
      }
    }
  }

  return { style, colorPairs: pairs }
}
