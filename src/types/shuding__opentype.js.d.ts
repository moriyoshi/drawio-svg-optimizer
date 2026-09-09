/**
 * Minimal ambient types for `@shuding/opentype.js`, which ships no declarations.
 *
 * Only the surface we rely on is declared: parsing a buffer and asking whether a
 * character maps to a real glyph. Satori depends on this same package, so we get
 * coverage answers from the parser that will actually do the rendering.
 */
declare module '@shuding/opentype.js' {
  export interface Font {
    numGlyphs: number
    unitsPerEm: number
    /** Returns 0 (`.notdef`) when the font has no glyph for the character. */
    charToGlyphIndex(char: string): number
  }

  export function parse(buffer: ArrayBuffer): Font

  const opentype: { parse: typeof parse }
  export default opentype
}
