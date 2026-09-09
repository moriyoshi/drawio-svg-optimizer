/**
 * Choosing where installed fonts come from.
 *
 * Two tiers, and the distinction is fidelity rather than capability. The
 * registry back-ends ask the operating system and get the truth: which fonts
 * are *available* rather than merely present on disk, what the OS calls each
 * family, and the faces inside collections. The scanner reconstructs that by
 * walking font directories, which is close enough for the families most
 * documents ask for and wrong in the ways `scanner.ts` documents.
 *
 * The registry needs a native binary. The scanner needs nothing. So the native
 * tier is a preference, not a requirement — an install without koffi keeps a
 * working system font tier rather than losing one.
 */
import { loadNativeBackend } from './native/index.js'
import { scannerBackend } from './scanner.js'
import type { SystemFontBackend } from './backend.js'

export type { SystemFontBackend, SystemFontFace } from './backend.js'

/**
 * Which source of installed fonts to use.
 *
 * `auto` prefers the platform registry and falls back to scanning. `scanner`
 * skips the registry outright, for callers who would rather not load a native
 * binary even where one is available — the accuracy difference is documented
 * in the README, and it is a real choice rather than a circumstance.
 */
export type FontBackend = 'auto' | 'scanner'

export interface BackendOptions {
  /**
   * Skip the registry back-ends and scan directories instead.
   *
   * For callers who would rather not load a native binary at all, and for
   * tests that need the scanner's behaviour on a machine where the registry
   * would otherwise win.
   */
  native?: boolean
}

let resolved: Promise<SystemFontBackend> | undefined

/**
 * The best font source this machine offers.
 *
 * Always returns one: the scanner is a hard dependency and has no failure mode
 * beyond finding nothing, so callers never have to handle "no source at all".
 */
export function loadFontBackend(options: BackendOptions = {}): Promise<SystemFontBackend> {
  if (options.native === false) return Promise.resolve(scannerBackend())
  resolved ??= loadNativeBackend().then((native) => native ?? scannerBackend())
  return resolved
}

/** @internal Drops the memoised choice. Tests only. */
export function resetFontBackend(): void {
  resolved = undefined
}
