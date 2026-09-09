/**
 * Gzipped size, on Node.
 *
 * zlib at level 9 rather than anything portable, because this number is
 * reported to the user as what their file will actually cost to serve.
 * `CompressionStream` — the browser's only option — compresses at level 6 and
 * reads about 3% high, and a pure-JS gzip measured 2.7–4.1% worse than zlib
 * across the fixtures. Either would make the Node numbers worse to delete a
 * seam that is two small files.
 *
 * Asynchronous only so that the browser variant can be.
 */
import { gzipSync } from 'node:zlib'

export async function gzipSize(bytes: Uint8Array): Promise<number> {
  return gzipSync(bytes, { level: 9 }).byteLength
}
