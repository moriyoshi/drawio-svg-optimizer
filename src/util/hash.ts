/**
 * A short, stable identifier for a string.
 *
 * This replaced `createHash('sha256')` truncated to eight hex digits. The only
 * consumer is a root-element id that scopes generated CSS rules to a document
 * that has none of its own, so it is not a security boundary and never was —
 * eight hex digits is 32 bits either way, so collision behaviour is unchanged
 * in kind. What it buys is a function that needs neither `node:crypto` nor the
 * asynchronous `SubtleCrypto` a browser would otherwise force.
 */

/** FNV-1a, 32 bits, as eight lowercase hex digits. */
export function hash32(input: string): string {
  let hash = 0x81_1c_9d_c5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01_00_01_93)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
