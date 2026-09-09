/**
 * Where downloaded font subsets are remembered, on Node.
 *
 * On disk, under `$XDG_CACHE_HOME`, so a second run of the same document needs
 * no network at all — which is what makes `--offline` useful rather than merely
 * safe. The filename is a 128-bit digest of the URL: a collision here would
 * serve the wrong font bytes, so this is the one hash in the codebase that has
 * to be a real one.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface FontCache {
  get(url: string): Promise<Uint8Array | undefined>
  set(url: string, data: Uint8Array): Promise<void>
}

export function defaultCacheDir(): string {
  const base = process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache')
  return join(base, 'drawio-svg-optimizer', 'fonts')
}

export function createFontCache(dir?: string): FontCache {
  const cacheDir = dir ?? defaultCacheDir()
  const pathFor = (url: string): string =>
    join(cacheDir, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.font`)

  return {
    async get(url) {
      try {
        return await readFile(pathFor(url))
      } catch {
        return undefined
      }
    },
    async set(url, data) {
      try {
        await mkdir(cacheDir, { recursive: true })
        await writeFile(pathFor(url), data)
      } catch {
        // A read-only or full disk costs a re-download next run, nothing more.
      }
    },
  }
}
