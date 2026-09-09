/**
 * The Windows font registry, read through DirectWrite.
 *
 * DirectWrite is a COM API, so every call below is a vtable dispatch rather
 * than a named export — see `com.ts` for the mechanics and for why `node:ffi`
 * could not do this at all.
 *
 * **The slot numbers are the dangerous part of this file.** Each one is the
 * method's position in its interface's vtable, counting `IUnknown`'s three
 * inherited methods first and then every method of every base interface in
 * declaration order. Nothing verifies them: an index that is wrong by one calls
 * a different method with a mismatched prototype, which corrupts memory instead
 * of raising. They are transcribed from `dwrite.h` and grouped by interface
 * below so they can be checked against it by eye.
 *
 * DirectWrite reports weight and slant as numbers rather than as a style name,
 * which is strictly better than the name-parsing the other back-ends need — so
 * the faces this produces carry them directly and skip `parseStyleName`.
 */
import type Koffi from 'koffi'
import { createComRuntime, guid, S_OK } from './com.js'
import type { ComRuntime } from './com.js'
import type { SystemFontBackend, SystemFontFace } from '../backend.js'

/** `DWRITE_FACTORY_TYPE_SHARED`. */
const FACTORY_TYPE_SHARED = 0

/** `DWRITE_FONT_STYLE`. */
const FONT_STYLE_NORMAL = 0

const IID_FACTORY = 'b859ee5a-d838-4b5b-a2e8-1adc7d93db48'
const IID_LOCAL_FONT_FILE_LOADER = 'b2d9f3ec-c9fe-4a11-a2ec-d86208f7c0a2'

/**
 * Vtable slots, by interface. Slots 0-2 are always `IUnknown`.
 *
 * `IDWriteFontFamily` derives from `IDWriteFontList`, so its own methods start
 * at 6 rather than 3 — that inheritance is the easiest thing here to get wrong.
 * `IDWriteLocalFontFileLoader` likewise derives from `IDWriteFontFileLoader`,
 * whose single method occupies slot 3.
 */
const SLOT = {
  /** IDWriteFactory : IUnknown */
  factoryGetSystemFontCollection: 3,

  /** IDWriteFontCollection : IUnknown */
  collectionGetFontFamily: 4,
  collectionFindFamilyName: 5,

  /** IDWriteFontList : IUnknown — inherited by IDWriteFontFamily */
  listGetFontCount: 4,
  listGetFont: 5,

  /** IDWriteFontFamily : IDWriteFontList */
  familyGetFamilyNames: 6,

  /** IDWriteFont : IUnknown */
  fontGetWeight: 4,
  fontGetStyle: 6,
  fontCreateFontFace: 13,

  /** IDWriteFontFace : IUnknown */
  faceGetFiles: 4,

  /** IDWriteFontFile : IUnknown */
  fileGetReferenceKey: 3,
  fileGetLoader: 4,

  /** IDWriteLocalFontFileLoader : IDWriteFontFileLoader */
  localLoaderGetFilePathLengthFromKey: 4,
  localLoaderGetFilePathFromKey: 5,

  /** IDWriteLocalizedStrings : IUnknown */
  stringsGetStringLength: 7,
  stringsGetString: 8,
} as const

/** Family and path strings are bounded in practice; these are generous. */
const MAX_PATH_CHARS = 1024
const MAX_NAME_CHARS = 256

function decodeUtf16(buffer: Buffer, chars: number): string {
  const text = buffer.toString('utf16le', 0, chars * 2)
  const end = text.indexOf('\0')
  return end < 0 ? text : text.slice(0, end)
}

/** UTF-16LE, NUL-terminated — what every `WCHAR const*` argument expects. */
function encodeUtf16(text: string): Buffer {
  return Buffer.from(`${text}\0`, 'utf16le')
}

export function createDirectWriteBackend(koffi: typeof Koffi): SystemFontBackend {
  const dwrite = koffi.load('dwrite.dll')
  const com: ComRuntime = createComRuntime(koffi)

  const createFactory = dwrite.func(
    'int32_t __stdcall DWriteCreateFactory(int32_t, const void*, _Out_ void**)',
  )

  // Every prototype declares the leading `void*` that carries `this`.
  const p = {
    getSystemFontCollection: koffi.proto(
      'int32_t __stdcall DwGetSystemFontCollection(void*, _Out_ void**, int32_t)',
    ),
    findFamilyName: koffi.proto(
      'int32_t __stdcall DwFindFamilyName(void*, const void*, _Out_ uint32_t*, _Out_ int32_t*)',
    ),
    getFontFamily: koffi.proto('int32_t __stdcall DwGetFontFamily(void*, uint32_t, _Out_ void**)'),
    getFontCount: koffi.proto('uint32_t __stdcall DwGetFontCount(void*)'),
    getFont: koffi.proto('int32_t __stdcall DwGetFont(void*, uint32_t, _Out_ void**)'),
    getFamilyNames: koffi.proto('int32_t __stdcall DwGetFamilyNames(void*, _Out_ void**)'),
    getWeight: koffi.proto('uint32_t __stdcall DwGetWeight(void*)'),
    getStyle: koffi.proto('uint32_t __stdcall DwGetStyle(void*)'),
    createFontFace: koffi.proto('int32_t __stdcall DwCreateFontFace(void*, _Out_ void**)'),
    getFiles: koffi.proto('int32_t __stdcall DwGetFiles(void*, _Inout_ uint32_t*, _Out_ void**)'),
    getReferenceKey: koffi.proto(
      'int32_t __stdcall DwGetReferenceKey(void*, _Out_ void**, _Out_ uint32_t*)',
    ),
    getLoader: koffi.proto('int32_t __stdcall DwGetLoader(void*, _Out_ void**)'),
    getFilePathLength: koffi.proto(
      'int32_t __stdcall DwGetFilePathLength(void*, const void*, uint32_t, _Out_ uint32_t*)',
    ),
    getFilePath: koffi.proto(
      'int32_t __stdcall DwGetFilePath(void*, const void*, uint32_t, _Out_ void*, uint32_t)',
    ),
    getStringLength: koffi.proto('int32_t __stdcall DwGetStringLength(void*, uint32_t, _Out_ uint32_t*)'),
    getString: koffi.proto('int32_t __stdcall DwGetString(void*, uint32_t, _Out_ void*, uint32_t)'),
  }

  const iidFactory = guid(IID_FACTORY)
  const iidLocalLoader = guid(IID_LOCAL_FONT_FILE_LOADER)

  /**
   * The shared factory, created once.
   *
   * `DWRITE_FACTORY_TYPE_SHARED` means DirectWrite hands back a process-wide
   * instance, so caching it is what the API already does internally.
   */
  let factory: unknown
  const getFactory = (): unknown => {
    if (factory !== undefined) return factory
    const out = [null]
    const hr = createFactory(FACTORY_TYPE_SHARED, iidFactory, out) as number
    factory = hr < S_OK ? null : out[0]
    return factory
  }

  /** Read entry 0 of an `IDWriteLocalizedStrings`, which is the default locale. */
  const readLocalizedString = (strings: unknown): string | undefined => {
    const length = [0]
    if ((com.invoke(strings, SLOT.stringsGetStringLength, p.getStringLength, 0, length) as number) < S_OK) {
      return undefined
    }
    const chars = Math.min((length[0] ?? 0) + 1, MAX_NAME_CHARS)
    const buffer = Buffer.alloc(chars * 2)
    if ((com.invoke(strings, SLOT.stringsGetString, p.getString, 0, buffer, chars) as number) < S_OK) {
      return undefined
    }
    return decodeUtf16(buffer, chars)
  }

  /** Walk a font down to the file backing it. Only local fonts have a path. */
  const readPath = (font: unknown): string | undefined => {
    let face: unknown
    let file: unknown
    let loader: unknown
    let localLoader: unknown
    try {
      const faceOut = [null]
      if ((com.invoke(font, SLOT.fontCreateFontFace, p.createFontFace, faceOut) as number) < S_OK) {
        return undefined
      }
      face = faceOut[0]

      // GetFiles is a two-call API: ask for the count, then for the files.
      const count = [1]
      const files = [null]
      if ((com.invoke(face, SLOT.faceGetFiles, p.getFiles, count, files) as number) < S_OK) {
        return undefined
      }
      file = files[0]
      if (!file) return undefined

      const key = [null]
      const keySize = [0]
      if (
        (com.invoke(file, SLOT.fileGetReferenceKey, p.getReferenceKey, key, keySize) as number) <
        S_OK
      ) {
        return undefined
      }

      const loaderOut = [null]
      if ((com.invoke(file, SLOT.fileGetLoader, p.getLoader, loaderOut) as number) < S_OK) {
        return undefined
      }
      loader = loaderOut[0]

      // A font served from memory or over the network has no local loader, and
      // therefore no path. That is a legitimate answer, not a failure.
      localLoader = com.queryInterface(loader, iidLocalLoader)
      if (!localLoader) return undefined

      const length = [0]
      if (
        (com.invoke(
          localLoader,
          SLOT.localLoaderGetFilePathLengthFromKey,
          p.getFilePathLength,
          key[0],
          keySize[0],
          length,
        ) as number) < S_OK
      ) {
        return undefined
      }

      const chars = Math.min((length[0] ?? 0) + 1, MAX_PATH_CHARS)
      const buffer = Buffer.alloc(chars * 2)
      if (
        (com.invoke(
          localLoader,
          SLOT.localLoaderGetFilePathFromKey,
          p.getFilePath,
          key[0],
          keySize[0],
          buffer,
          chars,
        ) as number) < S_OK
      ) {
        return undefined
      }
      return decodeUtf16(buffer, chars)
    } finally {
      com.release(localLoader)
      com.release(loader)
      com.release(file)
      com.release(face)
    }
  }

  return {
    name: 'directwrite',

    async facesOf(family: string): Promise<SystemFontFace[]> {
      const instance = getFactory()
      if (!instance) return []

      let collection: unknown
      let fontFamily: unknown
      let names: unknown
      try {
        const collectionOut = [null]
        if (
          (com.invoke(
            instance,
            SLOT.factoryGetSystemFontCollection,
            p.getSystemFontCollection,
            collectionOut,
            0,
          ) as number) < S_OK
        ) {
          return []
        }
        collection = collectionOut[0]

        // FindFamilyName reports absence through `exists`, not through the
        // HRESULT — so an uninstalled family is S_OK with exists = FALSE, and
        // this is where we avoid inventing a substitute.
        const index = [0]
        const exists = [0]
        if (
          (com.invoke(
            collection,
            SLOT.collectionFindFamilyName,
            p.findFamilyName,
            encodeUtf16(family),
            index,
            exists,
          ) as number) < S_OK
        ) {
          return []
        }
        if (!exists[0]) return []

        const familyOut = [null]
        if (
          (com.invoke(
            collection,
            SLOT.collectionGetFontFamily,
            p.getFontFamily,
            index[0],
            familyOut,
          ) as number) < S_OK
        ) {
          return []
        }
        fontFamily = familyOut[0]

        const namesOut = [null]
        let matched = family
        if (
          (com.invoke(fontFamily, SLOT.familyGetFamilyNames, p.getFamilyNames, namesOut) as number) >=
          S_OK
        ) {
          names = namesOut[0]
          matched = readLocalizedString(names) ?? family
        }

        const faces: SystemFontFace[] = []
        const count = com.invoke(fontFamily, SLOT.listGetFontCount, p.getFontCount) as number
        for (let i = 0; i < count; i += 1) {
          const fontOut = [null]
          if (
            (com.invoke(fontFamily, SLOT.listGetFont, p.getFont, i, fontOut) as number) < S_OK
          ) {
            continue
          }
          const font = fontOut[0]
          try {
            const path = readPath(font)
            if (path === undefined) continue
            faces.push({
              path,
              family: matched,
              // No `style`: DirectWrite states weight and slant outright, and
              // a made-up style name would be wrong for every face but one.
              weight: com.invoke(font, SLOT.fontGetWeight, p.getWeight) as number,
              italic: (com.invoke(font, SLOT.fontGetStyle, p.getStyle) as number) !== FONT_STYLE_NORMAL,
            })
          } finally {
            com.release(font)
          }
        }
        return faces
      } finally {
        com.release(names)
        com.release(fontFamily)
        com.release(collection)
      }
    },
  }
}
