/**
 * Telling font formats apart by their first four bytes.
 *
 * An `@font-face` rule declares what it is serving twice: as the data URI's
 * media type and as the `format()` hint. Both were hardcoded to TrueType, which
 * is wrong whenever the bytes are not — and `fontFiles` takes whatever the
 * caller hands over, which for a font a page fetched itself is WOFF2.
 *
 * How much that costs is worth stating precisely, because it is less than it
 * sounds. `format()` is a *hint*: it exists so a user agent can skip a source
 * it cannot use without downloading it. With a single data URI there is nothing
 * to skip, and Chromium was measured loading a WOFF2 declared as `truetype`
 * without complaint — it sniffs the bytes. So this is not repairing a rendering
 * failure today.
 *
 * It is still worth declaring the truth. The specification permits a user agent
 * to trust the hint and skip the source; a `src` list with several entries uses
 * it to choose between them; and other engines need not behave as Chromium
 * does. Saying what the bytes actually are costs four bytes of inspection.
 *
 * Guessing from a file extension would not do: a `.ttf` on disk can hold CFF
 * outlines, and bytes arriving through an API have no name at all.
 */

/** What an `@font-face` needs to say about a set of bytes. */
export interface FontFormat {
  /** The data URI's media type. */
  mime: string
  /** The `format()` hint, or undefined when no standard hint applies. */
  hint?: string
}

const TRUETYPE: FontFormat = { mime: 'font/ttf', hint: 'truetype' }

/**
 * Signatures, as the four-byte tag each format opens with.
 *
 * `0x00010000` is a TrueType version number rather than a tag, and `true` is
 * the tag Apple used for the same thing. `OTTO` means the outlines are CFF, so
 * the correct hint is `opentype` even though the container is the same sfnt.
 */
const SIGNATURES: ReadonlyArray<readonly [number, FontFormat]> = [
  [0x77_4f_46_32, { mime: 'font/woff2', hint: 'woff2' }], // wOF2
  [0x77_4f_46_46, { mime: 'font/woff', hint: 'woff' }], // wOFF
  [0x4f_54_54_4f, { mime: 'font/otf', hint: 'opentype' }], // OTTO
  [0x00_01_00_00, TRUETYPE],
  [0x74_72_75_65, TRUETYPE], // true
  // A collection is several fonts in one file. `@font-face` has no way to say
  // which, and browser support is poor, so it gets a media type and no hint —
  // one reaching here means `collection.ts` did not unpack it, which is a bug
  // rather than something to paper over with a wrong label.
  [0x74_74_63_66, { mime: 'font/collection' }], // ttcf
]

/**
 * Identify `bytes`, falling back to TrueType.
 *
 * The fallback is the historical behaviour and the overwhelmingly common case;
 * anything genuinely unreadable will be rejected by the browser either way.
 */
export function fontFormat(bytes: Uint8Array): FontFormat {
  if (bytes.byteLength < 4) return TRUETYPE
  const tag =
    ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0
  return SIGNATURES.find(([signature]) => signature === tag)?.[1] ?? TRUETYPE
}
