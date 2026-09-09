/**
 * Reading fonts off the filesystem, on Node.
 *
 * Two of the resolver's tiers need this and nothing else does: `config`, where
 * a caller names a file outright, and `bundled`, where a directory holds
 * `<Family>-Regular.ttf` and friends. Isolating them is what lets the rest of
 * the resolver run anywhere.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** A font named by the caller. Bytes are accepted too, and pass straight through. */
export async function readFontFile(
  source: string | Uint8Array,
): Promise<Uint8Array | undefined> {
  if (typeof source !== 'string') return source
  try {
    return await readFile(source)
  } catch {
    return undefined
  }
}

/**
 * A face from the bundled directory, if one is there.
 *
 * The default is a `fonts/` directory beside the package, which is only
 * reachable by writing into `node_modules` — so callers who actually use this
 * tier are expected to pass `fontDir`.
 */
export async function readBundledFont(
  family: string,
  weight: number,
  italic: boolean,
  dir: string | undefined,
): Promise<Uint8Array | undefined> {
  const base = dir ?? fileURLToPath(new URL('../../fonts/', import.meta.url))
  const suffix = `${weight >= 600 ? 'Bold' : 'Regular'}${italic ? 'Italic' : ''}`
  for (const name of [`${family}-${suffix}.ttf`, `${family}-Regular.ttf`]) {
    try {
      return await readFile(join(base, name))
    } catch {
      continue
    }
  }
  return undefined
}
