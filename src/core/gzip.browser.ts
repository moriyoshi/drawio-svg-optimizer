/**
 * Gzipped size, in a browser.
 *
 * `CompressionStream` is the only gzip a page has, and it compresses at zlib
 * level 6 where the Node path uses level 9 — so sizes reported here read about
 * 3% high. That is documented rather than papered over: shipping a pure-JS
 * deflate to close a 3% gap would cost more bytes than the gap describes.
 */
import { toArrayBuffer } from '../fonts/bytes.js'
import type * as NodeGzip from './gzip.js'

export async function gzipSize(bytes: Uint8Array): Promise<number> {
  // `Blob` and `CompressionStream` are global in Node 18+ as well as in every
  // browser, and `@types/node` declares both, so this file needs no DOM lib.
  // The copy is not redundant: `Blob` wants a standalone `ArrayBuffer`, and
  // lib.dom's declaration rejects a view whose buffer might be shared.
  const compressed = new Blob([toArrayBuffer(bytes)])
    .stream()
    .pipeThrough(new CompressionStream('gzip'))

  const reader = compressed.getReader()
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += (value as Uint8Array).byteLength
  }
  return total
}

/**
 * Compile-time proof this can stand in for the Node module.
 *
 * The swap happens in package.json, where nothing type-checks it, so the two
 * signatures would otherwise be free to drift apart.
 */
const _contract: typeof NodeGzip.gzipSize = gzipSize
void _contract
