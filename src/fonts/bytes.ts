/**
 * Handling font bytes without depending on `Buffer`.
 *
 * Font data now travels as `Uint8Array` rather than `Buffer`. That is not
 * tidiness: the browser's Local Font Access API hands back blobs, `fetch` hands
 * back array buffers, and a `Buffer` in the public type would force every
 * caller through a Node-only class to reach bytes they already have.
 *
 * The two operations that were `Buffer` methods live here instead.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * A standalone `ArrayBuffer` holding a copy of `bytes`.
 *
 * Both `@shuding/opentype.js` and Satori want an `ArrayBuffer`, and neither
 * accepts a view into a larger one — which is what `Buffer.from` and
 * `readFile` hand back, since Node allocates small buffers out of a shared
 * pool. Passing `.buffer` directly would give the parser the whole pool.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/**
 * Base64, without `Buffer` and without `btoa`.
 *
 * `btoa` would need the bytes as a "binary string" first, which means chunking
 * `String.fromCharCode.apply` to stay under the argument limit — two passes and
 * a stack-size trap over data that runs to tens of kilobytes for a subset and
 * megabytes for a CJK face.
 */
export function toBase64(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out +=
      ALPHABET[(chunk >>> 18) & 63]! +
      ALPHABET[(chunk >>> 12) & 63]! +
      ALPHABET[(chunk >>> 6) & 63]! +
      ALPHABET[chunk & 63]!
  }

  const remaining = bytes.length - i
  if (remaining === 1) {
    const chunk = bytes[i]! << 16
    out += `${ALPHABET[(chunk >>> 18) & 63]!}${ALPHABET[(chunk >>> 12) & 63]!}==`
  } else if (remaining === 2) {
    const chunk = (bytes[i]! << 16) | (bytes[i + 1]! << 8)
    out += `${ALPHABET[(chunk >>> 18) & 63]!}${ALPHABET[(chunk >>> 12) & 63]!}${ALPHABET[(chunk >>> 6) & 63]!}=`
  }
  return out
}
