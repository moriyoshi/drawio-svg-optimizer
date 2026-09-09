/**
 * Reaching the platform's font registry, when the machine lets us.
 *
 * `koffi` is an optional dependency: it ships prebuilt binaries for eighteen
 * platform/architecture pairs (including musl, so Alpine works), which means
 * the usual case needs no compiler and no build tools. But "usual" is not
 * "always" — an unlisted platform, an install run with `--no-optional`, or a
 * lockfile that pruned it all end in the same place. So does a platform with no
 * back-end written for it.
 *
 * Every one of those returns `undefined` and the caller falls back to scanning
 * the font directories, which is the same graceful degradation the `fc-match`
 * shell-out had when fontconfig was missing — most of the time on macOS, and
 * always on Windows.
 *
 * macOS goes through CoreText, Windows through DirectWrite, Linux through
 * fontconfig — the last of which also replaces the `fc-match` subprocess the
 * resolver used to spawn per family.
 */
import { createRequire } from 'node:module'
import type Koffi from 'koffi'
import { createCoreTextBackend } from './coretext.js'
import { createDirectWriteBackend } from './directwrite.js'
import { createFontconfigBackend } from './fontconfig.js'
import type { SystemFontBackend } from '../backend.js'

export type { SystemFontBackend, SystemFontFace } from '../backend.js'

/**
 * Memoised because failure is structural, not transient.
 *
 * A machine without the binary will not grow one mid-process, so retrying per
 * family would pay for a failed resolution on every lookup.
 */
let backend: Promise<SystemFontBackend | undefined> | undefined

/**
 * Load koffi without handing a live specifier to a bundler.
 *
 * `require` rather than `import()` on purpose: koffi is a native addon, and a
 * bundler that follows the specifier will try to inline a `.node` file and
 * fail. `createRequire` keeps the resolution at runtime where it belongs, and
 * the failure is catchable rather than a build error.
 */
function loadKoffi(): typeof Koffi | undefined {
  try {
    return createRequire(import.meta.url)('koffi') as typeof Koffi
  } catch {
    return undefined
  }
}

async function create(): Promise<SystemFontBackend | undefined> {
  const build = BACKENDS[process.platform]
  if (build === undefined) return undefined

  const koffi = loadKoffi()
  if (koffi === undefined) return undefined

  try {
    return build(koffi)
  } catch {
    // A symbol that has moved, a stripped system without the frameworks, or a
    // Windows install where DirectWrite will not start. Not worth
    // distinguishing: the tier below handles every case identically.
    return undefined
  }
}

const BACKENDS: Partial<Record<NodeJS.Platform, (koffi: typeof Koffi) => SystemFontBackend>> = {
  darwin: createCoreTextBackend,
  win32: createDirectWriteBackend,
  linux: createFontconfigBackend,
}

export function loadNativeBackend(): Promise<SystemFontBackend | undefined> {
  backend ??= create()
  return backend
}
