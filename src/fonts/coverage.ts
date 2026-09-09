import { parse } from '@shuding/opentype.js'
import type { Font } from '@shuding/opentype.js'
import { toArrayBuffer } from './bytes.js'

/**
 * Does this font actually contain the characters we are about to render?
 *
 * This is a safety net rather than a nicety. Google Fonts answers a plain
 * request for a CJK family with a *Latin-only* subset — 34 KB that covers `A`
 * but not a single kana — so a naive fetch would hand Satori a font that renders
 * the label as tofu. We verify coverage before trusting any font, whatever tier
 * it came from.
 *
 * The parser is `@shuding/opentype.js` because that is the one Satori itself
 * uses. Sharing it means our answer to "can this font render this text?" is the
 * same answer the renderer will reach — a second implementation could disagree,
 * and a disagreement here shows up as tofu in the output.
 */

/** True for characters with no visible glyph, whose absence is not tofu. */
function isInvisible(char: string): boolean {
  const codepoint = char.codePointAt(0)!
  return /\s/.test(char) || codepoint < 0x20 || codepoint === 0x7f
}

function parseFont(font: Uint8Array): Font | undefined {
  try {
    return parse(toArrayBuffer(font))
  } catch {
    // Not a font we can read: WOFF2, a TrueType collection, or an error page
    // returned with a 200. Every character counts as missing, which makes the
    // caller reject it — the outcome we want.
    return undefined
  }
}

/**
 * Characters in `text` that the font cannot render.
 *
 * An unreadable buffer reports every character as missing rather than throwing,
 * so a corrupt download degrades to "try the next tier" instead of a crash.
 */
export function missingGlyphs(font: Uint8Array, text: string): string[] {
  const wanted = [...new Set(text)].filter((char) => !isInvisible(char))
  if (wanted.length === 0) return []

  const parsed = parseFont(font)
  if (parsed === undefined) return wanted

  // Glyph index 0 is `.notdef` — the box that renders as tofu.
  return wanted.filter((char) => parsed.charToGlyphIndex(char) === 0)
}

export function covers(font: Uint8Array, text: string): boolean {
  return missingGlyphs(font, text).length === 0
}
