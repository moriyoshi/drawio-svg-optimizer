/**
 * Calling COM interface methods from JavaScript.
 *
 * A COM object is a pointer to a pointer to a table of function pointers. The
 * first machine word of the instance is its vtable; slot *n* of that table is
 * the *n*th method in declaration order, counting the three `IUnknown` methods
 * every interface inherits first; and the method is an ordinary C function
 * whose first argument is the instance itself. That is the entire protocol.
 *
 * None of those methods are exported symbols, which is why `node:ffi` cannot
 * reach them — it resolves functions by name through `dlsym` only. koffi's
 * `call` takes an address, so the indirection is expressible.
 *
 * The danger is that a slot index is a bare number with nothing checking it. An
 * index that is wrong by one calls a different method with the wrong prototype,
 * which corrupts memory rather than raising. Every index used against a real
 * interface therefore has to be counted against that interface's declaration,
 * base classes included — see the tables in `directwrite.ts`.
 */
import type Koffi from 'koffi'

/** `IUnknown` occupies the first three slots of every COM vtable. */
export const IUNKNOWN_QUERY_INTERFACE = 0
export const IUNKNOWN_ADD_REF = 1
export const IUNKNOWN_RELEASE = 2

/** `S_OK`. COM reports failure in the sign bit, so `< 0` is the real test. */
export const S_OK = 0

export interface ComRuntime {
  /**
   * Call vtable slot `slot` on `instance`.
   *
   * `proto` must describe the method *including* its leading `this` argument;
   * `instance` is passed for it automatically.
   */
  invoke(instance: unknown, slot: number, proto: unknown, ...args: unknown[]): unknown
  /** `IUnknown::QueryInterface`. Returns undefined when the interface is refused. */
  queryInterface(instance: unknown, iid: Buffer): unknown
  /** `IUnknown::Release`. Safe on a null instance. */
  release(instance: unknown): void
}

/**
 * Parse `b859ee5a-d838-4b5b-a2e8-1adc7d93db48` into the 16 bytes a `REFIID`
 * points at.
 *
 * The layout is not simply the hex read left to right: a GUID is a struct of
 * `{ uint32, uint16, uint16, uint8[8] }`, so the first three groups are stored
 * in the host's byte order — little-endian everywhere Windows runs — while the
 * last two groups are plain bytes. Getting this wrong makes `QueryInterface`
 * fail in a way that looks like an unsupported interface rather than a bug.
 */
export function guid(text: string): Buffer {
  const hex = text.replace(/[{}-]/g, '')
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/i.test(hex)) {
    throw new Error(`Not a GUID: ${text}`)
  }
  const bytes = Buffer.from(hex, 'hex')
  const out = Buffer.alloc(16)
  out.writeUInt32LE(bytes.readUInt32BE(0), 0)
  out.writeUInt16LE(bytes.readUInt16BE(4), 4)
  out.writeUInt16LE(bytes.readUInt16BE(6), 6)
  bytes.copy(out, 8, 8, 16)
  return out
}

/**
 * Prototypes for the two `IUnknown` methods this module calls itself.
 *
 * Cached at module scope because koffi registers prototypes by name globally
 * and throws on a duplicate — so building them inside `createComRuntime` would
 * make a second call to it fail. That is not hypothetical: the font back-end
 * creates a runtime, and so does anything that wants to reach COM alongside it.
 *
 * `__stdcall` is not decoration. Every COM method is declared
 * `STDMETHODCALLTYPE`, which is `__stdcall`, and koffi defaults to cdecl. The
 * two agree on Windows x64 and arm64, where there is only one ABI — but koffi
 * ships a win32-ia32 build, and there the caller and the callee would each
 * believe the other cleans the stack. Every call would leak stack space until
 * the process died somewhere unrelated. On macOS and Linux the annotation is
 * accepted and collapses to cdecl, so it costs nothing to always state it.
 */
let protos: { queryInterface: unknown; release: unknown } | undefined

function unknownProtos(koffi: typeof Koffi): { queryInterface: unknown; release: unknown } {
  protos ??= {
    queryInterface: koffi.proto(
      'int32_t __stdcall ComQueryInterface(void*, const void*, _Out_ void**)',
    ),
    release: koffi.proto('uint32_t __stdcall ComRelease(void*)'),
  }
  return protos
}

export function createComRuntime(koffi: typeof Koffi): ComRuntime {
  // Windows ships an ia32 build, so the slot stride is not always eight.
  const slotSize = koffi.sizeof('void*')

  const { queryInterface: queryInterfaceProto, release: releaseProto } = unknownProtos(koffi)

  const method = (instance: unknown, slot: number): unknown => {
    const vtable = koffi.decode(instance, 'void*')
    return koffi.decode(vtable, slot * slotSize, 'void*')
  }

  return {
    invoke(instance, slot, proto, ...args) {
      // koffi does not export its `TypeSpec` union, so prototypes travel
      // through this module as opaque values and are narrowed here. `string` is
      // one arm of that union, which is enough to satisfy the signature.
      return koffi.call(method(instance, slot), proto as string, instance, ...args)
    },

    queryInterface(instance, iid) {
      const out = [null]
      const hr = koffi.call(
        method(instance, IUNKNOWN_QUERY_INTERFACE),
        queryInterfaceProto as string,
        instance,
        iid,
        out,
      ) as number
      return hr < S_OK ? undefined : out[0]
    },

    release(instance) {
      if (!instance) return
      koffi.call(method(instance, IUNKNOWN_RELEASE), releaseProto as string, instance)
    },
  }
}
