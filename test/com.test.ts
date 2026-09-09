import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { createComRuntime, guid, IUNKNOWN_RELEASE } from '../src/fonts/native/com.js'

/**
 * COM dispatch is platform-independent arithmetic.
 *
 * The Windows-only part of a DirectWrite back-end is *which* slot holds which
 * method; the part that corrupts memory when it is wrong is the indirection
 * itself — read the vtable pointer out of the instance, step `slot * sizeof
 * (void*)` into it, call the address with the instance as the first argument.
 * That can be exercised anywhere by building an object that looks like a COM
 * object, which is what these specs do. It is the difference between shipping
 * untested pointer arithmetic and shipping only untested slot numbers.
 */
const koffi = (() => {
  try {
    return createRequire(import.meta.url)('koffi')
  } catch {
    return undefined
  }
})()

describe('GUID encoding', () => {
  it('stores the first three groups in host order and the rest as bytes', async () => {
    // IID_IDWriteFactory. A GUID is { uint32, uint16, uint16, uint8[8] }, so
    // only the last eight bytes read the same as the text.
    const bytes = guid('b859ee5a-d838-4b5b-a2e8-1adc7d93db48')
    expect(bytes).toHaveLength(16)
    expect([...bytes.subarray(0, 4)]).toEqual([0x5a, 0xee, 0x59, 0xb8])
    expect([...bytes.subarray(4, 6)]).toEqual([0x38, 0xd8])
    expect([...bytes.subarray(6, 8)]).toEqual([0x5b, 0x4b])
    expect([...bytes.subarray(8)]).toEqual([0xa2, 0xe8, 0x1a, 0xdc, 0x7d, 0x93, 0xdb, 0x48])
  })

  it('accepts the brace-wrapped spelling registries use', async () => {
    expect(guid('{b859ee5a-d838-4b5b-a2e8-1adc7d93db48}')).toEqual(
      guid('b859ee5a-d838-4b5b-a2e8-1adc7d93db48'),
    )
  })

  it('refuses anything that is not a GUID', async () => {
    // A malformed IID would otherwise reach QueryInterface as 16 bytes of
    // whatever, and be reported as an unsupported interface rather than a bug.
    expect(() => guid('not-a-guid')).toThrow()
    expect(() => guid('b859ee5a-d838-4b5b-a2e8-1adc7d93db4')).toThrow()
  })
})

const whenKoffi = koffi === undefined ? describe.skip : describe

whenKoffi('COM vtable dispatch', () => {
  const runtime = createComRuntime(koffi)
  const slotSize = koffi.sizeof('void*')

  /**
   * A JS function installed at `slot` of a synthetic COM object.
   *
   * Using a callback rather than some borrowed libc symbol means the method
   * can report exactly what it was handed, so the dispatch contract — right
   * slot, instance first, arguments after — is asserted rather than inferred
   * from a plausible-looking return value.
   */
  const fakeObject = (slot: number, proto: unknown, implementation: Function) => {
    const method = koffi.register(implementation, koffi.pointer(proto))
    const vtable = Buffer.alloc(slotSize * (slot + 1))
    vtable.writeBigUInt64LE(koffi.address(method), slot * slotSize)
    const instance = Buffer.alloc(slotSize)
    instance.writeBigUInt64LE(koffi.address(vtable), 0)
    // Both buffers must outlive the call, so they are returned together.
    return { instance, vtable }
  }

  it('reaches the method at the slot it was told, and no other', async () => {
    // Slot 5 sits past IUnknown's three, where a real interface's own methods
    // begin. An off-by-one here reads an unrelated word as a code address.
    const proto = koffi.proto('int __stdcall SlotFive(void*, int)')
    const object = fakeObject(5, proto, (_self: unknown, value: number) => value * 2)
    expect(runtime.invoke(object.instance, 5, proto, 21)).toBe(42)
  })

  it('passes the instance as the leading argument', async () => {
    // COM's whole calling convention is that `this` comes first. Every method
    // prototype in the back-end declares that leading `void*`, so if the
    // runtime stopped supplying it, every argument would shift by one.
    const proto = koffi.proto('int __stdcall SlotThree(void*, int)')
    let seen: unknown
    const object = fakeObject(3, proto, (self: unknown, value: number) => {
      seen = self
      return value
    })
    runtime.invoke(object.instance, 3, proto, 7)
    expect(koffi.address(seen)).toBe(koffi.address(object.instance))
  })

  it('treats releasing a null instance as a no-op', async () => {
    // Release is called from `finally` blocks on paths where the object may
    // never have been created. CFRelease-style crashes on null are exactly the
    // failure mode this avoids.
    expect(() => runtime.release(null)).not.toThrow()
    expect(() => runtime.release(undefined)).not.toThrow()
  })

  it('puts IUnknown::Release at slot 2, where every interface inherits it', async () => {
    expect(IUNKNOWN_RELEASE).toBe(2)
  })

  it('can be created more than once in a process', async () => {
    // koffi registers prototypes by name, globally, and throws on a duplicate.
    // Building them per call made the second `createComRuntime` fail with
    // "Duplicate type name 'ComQueryInterface'" — which the font back-end hid,
    // because it creates the first one and anything reaching COM alongside it
    // got the error instead.
    expect(() => createComRuntime(koffi)).not.toThrow()
    expect(() => createComRuntime(koffi)).not.toThrow()
  })
})
