/**
 * The macOS font registry, read through CoreText.
 *
 * A directory scan is a reconstruction of what the OS thinks; this is the thing
 * itself. The difference is not academic — on a stock Mac CoreText reports 246
 * families where a recursive scan of the font directories finds 194, and the
 * missing 52 include Helvetica, Helvetica Neue, Hiragino Sans and PingFang,
 * because those ship inside `.ttc` collections a filename-keyed scan cannot
 * describe. A scan also cannot see fonts deactivated in Font Book, or ones a
 * font manager activated from somewhere else entirely.
 *
 * `CTFontDescriptorCreateMatchingFontDescriptors` is the right entry point
 * rather than `CTFontCreateWithName`, which resolves a nonexistent family to
 * Helvetica rather than admitting defeat — the same always-answers behaviour
 * `fc-match` had, and the reason the old code needed a guard.
 *
 * Everything here is unsafe by construction: a wrong prototype or an unbalanced
 * release corrupts memory rather than throwing. The surface is kept
 * deliberately small for that reason, and every Core Foundation object is
 * released on the way out.
 */
import type Koffi from 'koffi'
import type { SystemFontBackend, SystemFontFace } from '../backend.js'

const CORE_TEXT = '/System/Library/Frameworks/CoreText.framework/CoreText'
const CORE_FOUNDATION = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation'
const LIB_SYSTEM = 'libSystem.B.dylib'

/** `kCFStringEncodingUTF8`. */
const UTF8 = 0x08_00_01_00
/** `RTLD_DEFAULT` — search every loaded image, which is where the frameworks are. */
const RTLD_DEFAULT = -2

/** Core Foundation strings can be long; family and style names are not. */
const NAME_BYTES = 512
/** Long enough for any path CoreText will return, with room to spare. */
const PATH_BYTES = 1024

/** C strings come back NUL-terminated inside a fixed buffer. */
function decodeBuffer(buffer: Buffer): string {
  const end = buffer.indexOf(0)
  return buffer.toString('utf8', 0, end < 0 ? buffer.length : end)
}

/**
 * Register `CFTypeRef` as an opaque type, once per process.
 *
 * This looks like a discarded value and is not: the call is what teaches koffi
 * the name, so every `CFTypeRef*` in the prototypes below fails with "Unknown
 * or invalid type name" without it. Registration is global, so a second call
 * throws rather than being idempotent — which only matters if a caller builds
 * two back-ends, but costs nothing to tolerate.
 */
function registerTypes(koffi: typeof Koffi): void {
  try {
    koffi.opaque('CFTypeRef')
  } catch {
    // Already registered by an earlier back-end in this process.
  }
}

export function createCoreTextBackend(koffi: typeof Koffi): SystemFontBackend {
  registerTypes(koffi)

  const ct = koffi.load(CORE_TEXT)
  const cf = koffi.load(CORE_FOUNDATION)
  const system = koffi.load(LIB_SYSTEM)

  const stringCreate = cf.func(
    'CFTypeRef* CFStringCreateWithCString(CFTypeRef*, const char*, uint32_t)',
  )
  const stringRead = cf.func(
    'bool CFStringGetCString(CFTypeRef*, _Out_ char* buffer, int64_t, uint32_t)',
  )
  const dictCreate = cf.func(
    'CFTypeRef* CFDictionaryCreate(CFTypeRef*, void*, void*, int64_t, void*, void*)',
  )
  const arrayCount = cf.func('int64_t CFArrayGetCount(CFTypeRef*)')
  const arrayAt = cf.func('CFTypeRef* CFArrayGetValueAtIndex(CFTypeRef*, int64_t)')
  const urlPath = cf.func(
    'bool CFURLGetFileSystemRepresentation(CFTypeRef*, bool, _Out_ char* buffer, int64_t)',
  )
  const release = cf.func('void CFRelease(CFTypeRef*)')

  const descriptorCreate = ct.func('CFTypeRef* CTFontDescriptorCreateWithAttributes(CFTypeRef*)')
  const descriptorMatch = ct.func(
    'CFTypeRef* CTFontDescriptorCreateMatchingFontDescriptors(CFTypeRef*, CFTypeRef*)',
  )
  const descriptorAttribute = ct.func(
    'CFTypeRef* CTFontDescriptorCopyAttribute(CFTypeRef*, CFTypeRef*)',
  )

  /**
   * Read an exported *data* symbol.
   *
   * koffi resolves functions but not variables, and CoreText's attribute keys
   * are globals. `dlsym` gives the address of the variable, so the value —
   * the CFStringRef itself — is one dereference further in. The dictionary
   * callback tables are structs rather than pointers, so for those the address
   * *is* what Core Foundation wants; hence the two accessors.
   */
  const dlsym = system.func('void* dlsym(void*, const char*)')
  const addressOf = (name: string): unknown => dlsym(koffi.as(RTLD_DEFAULT, 'void*'), name)
  const valueOf = (name: string): unknown => koffi.decode(addressOf(name), 'void*')

  const kFamilyName = valueOf('kCTFontFamilyNameAttribute')
  const kUrl = valueOf('kCTFontURLAttribute')
  const kStyleName = valueOf('kCTFontStyleNameAttribute')
  const keyCallbacks = addressOf('kCFTypeDictionaryKeyCallBacks')
  const valueCallbacks = addressOf('kCFTypeDictionaryValueCallBacks')

  /** CFRelease(NULL) is a crash rather than a no-op. */
  const drop = (ref: unknown): void => {
    if (ref) release(ref)
  }

  /** Copy a CFString attribute off a descriptor, releasing the copy. */
  const readString = (descriptor: unknown, key: unknown): string | undefined => {
    const value = descriptorAttribute(descriptor, key) as unknown
    if (!value) return undefined
    try {
      const buffer = Buffer.alloc(NAME_BYTES)
      return stringRead(value, buffer, BigInt(NAME_BYTES), UTF8) ? decodeBuffer(buffer) : undefined
    } finally {
      drop(value)
    }
  }

  const readPath = (descriptor: unknown): string | undefined => {
    const url = descriptorAttribute(descriptor, kUrl) as unknown
    if (!url) return undefined
    try {
      const buffer = Buffer.alloc(PATH_BYTES)
      return urlPath(url, true, buffer, BigInt(PATH_BYTES)) ? decodeBuffer(buffer) : undefined
    } finally {
      drop(url)
    }
  }

  return {
    name: 'coretext',

    async facesOf(family: string): Promise<SystemFontFace[]> {
      const wanted = stringCreate(null, family, UTF8) as unknown
      if (!wanted) return []

      // A one-entry dictionary: { kCTFontFamilyNameAttribute: wanted }. Core
      // Foundation takes the keys and values as arrays passed by pointer, so
      // both are single-slot buffers holding the pointer values.
      const keys = Buffer.alloc(8)
      const values = Buffer.alloc(8)
      keys.writeBigUInt64LE(koffi.address(kFamilyName))
      values.writeBigUInt64LE(koffi.address(wanted))

      let attributes: unknown
      let descriptor: unknown
      let matches: unknown
      try {
        attributes = dictCreate(null, keys, values, 1n, keyCallbacks, valueCallbacks) as unknown
        if (!attributes) return []

        descriptor = descriptorCreate(attributes) as unknown
        if (!descriptor) return []

        // NULL mandatory attributes: match on everything we supplied. Returns
        // NULL — not an empty array — when the family is not installed, which
        // is the whole reason this is the entry point we use.
        matches = descriptorMatch(descriptor, null) as unknown
        if (!matches) return []

        const faces: SystemFontFace[] = []
        const count = Number(arrayCount(matches) as bigint)
        for (let i = 0; i < count; i += 1) {
          const match = arrayAt(matches, BigInt(i)) as unknown
          if (!match) continue
          const path = readPath(match)
          const matched = readString(match, kFamilyName)
          if (path === undefined || matched === undefined) continue
          faces.push({ path, family: matched, style: readString(match, kStyleName) ?? 'Regular' })
        }
        return faces
      } finally {
        drop(matches)
        drop(descriptor)
        drop(attributes)
        drop(wanted)
      }
    },
  }
}
