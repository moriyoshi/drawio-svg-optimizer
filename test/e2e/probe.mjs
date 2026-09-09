/**
 * Exercise a native font back-end against a real font registry.
 *
 * One probe for both halves of the harness: the fontconfig back-end running on
 * Linux, and the DirectWrite back-end running as a Windows process under Wine.
 * Which one is decided by `E2E_TARGET`, and almost everything after that is
 * shared — the two back-ends implement the same interface, so the things worth
 * asserting about their output are the same things.
 *
 * What differs is per-platform and lives in `TARGETS`: which process we must
 * be, which families the image installs, and how to enumerate the registry by
 * a route that is *not* the code under test.
 *
 * That last one is what makes a failure actionable. "No fonts found" cannot
 * otherwise distinguish a missing library from an empty font cache from a
 * wrong vtable slot index, and those need entirely different fixes. So the
 * checks run in dependency order, the first failure stops the run with its own
 * message, and the independent enumeration happens before the back-end is
 * asked anything.
 *
 * Output is a single JSON object written to `report-<target>.json`, which the
 * entrypoint reads back and turns into an exit status. It is a file rather
 * than stdout because Node's Windows build cannot open a standard stream under
 * Wine; the Linux half writes one too so that both report the same way.
 */
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const target = process.env.E2E_TARGET
if (target !== 'linux' && target !== 'windows') {
  // Not a check failure — there is nothing to write a report about. The
  // entrypoint sets this, so an unset value means the harness itself is wrong.
  process.stderr.write(`E2E_TARGET must be 'linux' or 'windows', got ${String(target)}\n`)
  process.exit(2)
}

const report = {
  target,
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  checks: [],
  families: {},
  ok: false,
}

let failed = false

// Async because some checks have to await the back-end, which is asynchronous
// so the directory scanner can share its interface.
async function check(name, fn) {
  if (failed) {
    report.checks.push({ name, status: 'skipped' })
    return undefined
  }
  try {
    const value = await fn()
    report.checks.push({ name, status: 'pass' })
    return value
  } catch (error) {
    report.checks.push({ name, status: 'fail', error: String(error?.message ?? error) })
    failed = true
    return undefined
  }
}

/**
 * Enumerate the Linux font registry without going through the back-end.
 *
 * Separates "fontconfig is present and has a populated cache" from "our
 * binding is right". Without the split, an empty cache and a broken binding
 * look identical from the outside.
 */
function linuxTarget() {
  return {
    platform: 'linux',
    // What the image installs. Nothing else is safe to assume.
    candidates: ['Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'DejaVu Sans'],
    preflight: [
      [
        'fontconfig itself reports installed families',
        (koffi) => {
          const fc = koffi.load('libfontconfig.so.1')
          koffi.struct('FcFontSetProbe', { nfont: 'int', sfont: 'int', fonts: 'void*' })
          const init = fc.func('void* FcInitLoadConfigAndFonts()')
          const patternCreate = fc.func('void* FcPatternCreate()')
          const objectSetCreate = fc.func('void* FcObjectSetCreate()')
          const objectSetAdd = fc.func('int FcObjectSetAdd(void*, const char*)')
          const fontList = fc.func('FcFontSetProbe* FcFontList(void*, void*, void*)')

          const config = init()
          if (!config) throw new Error('FcInitLoadConfigAndFonts returned null')

          // An empty pattern selects everything fontconfig knows about. Note
          // that FcFontList deduplicates on the properties in the object set,
          // so asking only for `family` counts distinct families rather than
          // font files — which is the number worth reporting here anyway.
          const objects = objectSetCreate()
          objectSetAdd(objects, 'family')
          const set = fontList(config, patternCreate(), objects)
          if (!set) throw new Error('FcFontList returned null')

          const { nfont } = koffi.decode(set, 'FcFontSetProbe')
          report.enumeration = { distinctFamilies: nfont }
          if (nfont === 0) {
            throw new Error(
              'fontconfig reports no families at all — the cache is empty, not the binding',
            )
          }
        },
      ],
    ],
  }
}

/**
 * The same job on Windows, in three steps because there are three ways to fail.
 *
 * A missing dwrite.dll, a factory that will not start, and a wrong vtable slot
 * index all present as "no fonts", and only the last one is a bug in the code
 * under test. The enumeration reaches the font collection by a different route
 * than the back-end does — `GetFontFamilyCount` and `GetFontFamily` rather than
 * `FindFamilyName` — using the COM dispatch that already has unit tests. Zero
 * families here means the image has no fonts; families here that the back-end
 * then cannot find means the back-end's slot indices are wrong.
 */
function windowsTarget() {
  // IID_IDWriteFactory, in the {uint32,uint16,uint16,uint8[8]} layout a REFIID
  // points at.
  const IID_IDWriteFactory = 'b859ee5a-d838-4b5b-a2e8-1adc7d93db48'

  let createFactory
  let koffiRef

  return {
    platform: 'win32',
    // The image's own faces, plus the classic Windows names Wine maps onto the
    // Liberation metric-compatible ones. Both spellings are worth trying.
    candidates: [
      'Liberation Sans',
      'Liberation Serif',
      'Liberation Mono',
      'DejaVu Sans',
      'Arial',
      'Times New Roman',
      'Courier New',
      'Tahoma',
    ],
    preflight: [
      [
        'dwrite.dll exports DWriteCreateFactory',
        (koffi) => {
          koffiRef = koffi
          const dwrite = koffi.load('dwrite.dll')
          // Declared once and reused: koffi resolves the symbol by the name in
          // the prototype, so a second declaration under a different name
          // looks for a symbol that does not exist.
          createFactory = dwrite.func(
            'int32_t __stdcall DWriteCreateFactory(int32_t, const void*, _Out_ void**)',
          )
        },
      ],
      [
        'DWriteCreateFactory returns a factory',
        async () => {
          const { guid } = await import('./dist/fonts/native/com.js')
          const out = [null]
          const hr = createFactory(0, guid(IID_IDWriteFactory), out)
          if (hr < 0) {
            throw new Error(`DWriteCreateFactory returned HRESULT 0x${(hr >>> 0).toString(16)}`)
          }
          if (!out[0]) throw new Error('DWriteCreateFactory succeeded but produced no factory')
        },
      ],
      [
        'the system font collection reports installed families',
        async () => {
          const koffi = koffiRef
          const { createComRuntime, guid } = await import('./dist/fonts/native/com.js')
          const com = createComRuntime(koffi)

          const factoryOut = [null]
          createFactory(0, guid(IID_IDWriteFactory), factoryOut)

          const collectionOut = [null]
          const hr = com.invoke(
            factoryOut[0],
            3, // IDWriteFactory::GetSystemFontCollection
            koffi.proto('int32_t __stdcall PGetSystemFontCollection(void*, _Out_ void**, int32_t)'),
            collectionOut,
            1, // checkForUpdates: rescan rather than trust a stale cache
          )
          const collection = collectionOut[0]
          report.enumeration = { hr, obtained: Boolean(collection) }
          if (!collection) {
            throw new Error(`GetSystemFontCollection produced nothing (HRESULT ${hr})`)
          }

          const count = com.invoke(
            collection,
            3, // IDWriteFontCollection::GetFontFamilyCount
            koffi.proto('uint32_t __stdcall PGetFontFamilyCount(void*)'),
          )
          report.enumeration.familyCount = count

          const familyProto = koffi.proto(
            'int32_t __stdcall PGetFontFamily(void*, uint32_t, _Out_ void**)',
          )
          const namesProto = koffi.proto('int32_t __stdcall PGetFamilyNames(void*, _Out_ void**)')
          const stringProto = koffi.proto(
            'int32_t __stdcall PGetString(void*, uint32_t, _Out_ void*, uint32_t)',
          )

          const found = []
          for (let i = 0; i < Math.min(count, 25); i += 1) {
            const familyOut = [null]
            if (com.invoke(collection, 4, familyProto, i, familyOut) < 0) continue
            const namesOut = [null]
            if (com.invoke(familyOut[0], 6, namesProto, namesOut) < 0) continue
            const buffer = Buffer.alloc(256 * 2)
            if (com.invoke(namesOut[0], 8, stringProto, 0, buffer, 256) < 0) continue
            const text = buffer.toString('utf16le')
            found.push(text.slice(0, text.indexOf('\0')))
          }
          report.enumeration.sampleFamilies = found

          if (count === 0) {
            throw new Error(
              'the font collection is empty — the image registered no fonts, ' +
                'which is not the same as the back-end failing to find them',
            )
          }
        },
      ],
    ],
  }
}

const TARGETS = { linux: linuxTarget, windows: windowsTarget }
const plan = TARGETS[target]()

// 1. We must be the process we think we are, or none of the rest means
//    anything — koffi would load the wrong prebuild and the library under test
//    would not resolve.
await check(`running as ${plan.platform}`, () => {
  if (process.platform !== plan.platform) {
    throw new Error(`expected ${plan.platform}, got ${process.platform}`)
  }
})

const koffi = await check('koffi loads its prebuild for this platform', () => require('koffi'))

// 2. The registry itself, by a route that is not the code under test.
for (const [name, fn] of plan.preflight) {
  await check(name, () => fn(koffi))
}

// 3. Now the code under test: the compiled back-end, through its real entry
//    point, exactly as the library would use it.
const backend = await check('back-end loads', async () => {
  const module = await import('./dist/fonts/native/index.js')
  const loaded = await module.loadNativeBackend()
  if (loaded === undefined) throw new Error('loadNativeBackend() returned undefined')
  report.backend = loaded.name
  return loaded
})

if (!failed && backend !== undefined) {
  for (const family of plan.candidates) {
    try {
      report.families[family] = await backend.facesOf(family)
    } catch (error) {
      report.families[family] = { error: String(error?.message ?? error) }
    }
  }

  const resolved = Object.entries(report.families).filter(
    ([, faces]) => Array.isArray(faces) && faces.length > 0,
  )

  await check('at least one family resolves to real faces', () => {
    if (resolved.length === 0) {
      throw new Error(
        'every candidate family returned no faces, though the registry ' +
          'enumerated some above — suspect the lookup path, not the image',
      )
    }
  })

  await check('faces carry a readable font-file path', () => {
    const [name, faces] = resolved[0] ?? []
    for (const face of faces) {
      if (typeof face.path !== 'string' || !/\.(ttf|otf|ttc)$/i.test(face.path)) {
        throw new Error(`${name}: face without a font-file path: ${String(face.path)}`)
      }
      // Only meaningful on Linux: under Wine the back-end reports a Windows
      // path, which this process can open but which says nothing extra.
      require('node:fs').accessSync(face.path)
    }
  })

  await check('weight arrives on the CSS scale', () => {
    // fontconfig calls regular 80 and bold 200, and a face escaping with a
    // fontconfig-scale weight would make every downstream comparison wrong
    // while still looking like a plausible number. DirectWrite is already on
    // the CSS scale, so the same bound holds there for free.
    const faces = resolved.flatMap(([, list]) => list)
    for (const face of faces) {
      if (typeof face.weight !== 'number' || face.weight < 100 || face.weight > 1000) {
        throw new Error(`weight ${String(face.weight)} is not on the CSS scale`)
      }
    }
    const bold = faces.find((face) => /bold/i.test(face.path) && !/italic/i.test(face.path))
    if (bold !== undefined && bold.weight !== 700) {
      throw new Error(`expected a bold face to report 700, got ${bold.weight}`)
    }
  })

  await check('slant is reported as a boolean', () => {
    const faces = resolved.flatMap(([, list]) => list)
    for (const face of faces) {
      if (typeof face.italic !== 'boolean') throw new Error('italic is not a boolean')
    }
    const italic = faces.find((face) => /italic|oblique/i.test(face.path))
    if (italic !== undefined && italic.italic !== true) {
      throw new Error('an italic face was reported as upright')
    }
  })

  await check('an uninstalled family resolves to nothing', async () => {
    // Both back-ends report absence rather than substituting: `FcFontList`
    // selects rather than matching — unlike `FcFontMatch`, and unlike the
    // `fc-match` subprocess it replaces, which always answered with *something*
    // and needed a guard against its own helpfulness — and `FindFamilyName`
    // says so through its `exists` out-parameter rather than the HRESULT.
    const faces = await backend.facesOf('Definitely Not A Real Typeface')
    if (faces.length !== 0) throw new Error(`expected no faces, got ${faces.length}`)
  })

  await check('repeated lookups stay stable', async () => {
    // Both back-ends own something they must release — an `FcFontSet` here, a
    // COM reference there. If that ownership were wrong, a second identical
    // call is where the use-after-free would surface.
    const first = await backend.facesOf(resolved[0][0])
    const second = await backend.facesOf(resolved[0][0])
    if (first.length !== second.length) {
      throw new Error(`unstable: ${first.length} then ${second.length}`)
    }
  })
}

/**
 * The scanner tier, on the same machine, for callers who decline the native one.
 *
 * Running both here is the only place they can be compared directly. The
 * registry is more faithful, but "more faithful" is worth stating as a measured
 * difference rather than an assumption — and the fallback has to actually work,
 * since opting out of a native binary is a supported choice.
 *
 * Linux only. The scanner walks font directories with `font-finder`, and the
 * comparison is only worth anything where both tiers see the same font set —
 * under Wine the directory it would walk is the one the image assembled by
 * hand, so agreement there would prove nothing the registry half has not.
 */
if (!failed && target === 'linux') {
  const scanner = await check('the scanner tier loads without any native binary', async () => {
    const { loadFontBackend } = await import('./dist/fonts/backends.js')
    const tier = await loadFontBackend({ native: false })
    if (tier.name !== 'scanner') throw new Error(`got ${tier.name}, expected scanner`)
    return tier
  })

  if (scanner !== undefined) {
    const scanned = {}
    for (const family of plan.candidates) {
      try {
        scanned[family] = (await scanner.facesOf(family)).length
      } catch (error) {
        scanned[family] = { error: String(error?.message ?? error) }
      }
    }
    report.scanner = scanned

    await check('the scanner finds the same families the registry does', () => {
      // Not the same *face count* — fontconfig reports faces the directory
      // walk cannot see, and that difference is the point of the native tier.
      // What must hold is that neither tier is empty where the other is not.
      for (const [family, faces] of Object.entries(report.families)) {
        if (!Array.isArray(faces) || faces.length === 0) continue
        if (typeof scanned[family] !== 'number' || scanned[family] === 0) {
          throw new Error(`${family}: registry found ${faces.length}, scanner found none`)
        }
      }
    })

    await check('the scanner also declines to invent a missing family', async () => {
      const faces = await scanner.facesOf('Definitely Not A Real Typeface')
      if (faces.length !== 0) throw new Error(`expected no faces, got ${faces.length}`)
    })
  }
}

report.ok = !failed

// A file, not stdout: Node's Windows build cannot open a standard stream under
// Wine — `process.stdout` throws EBADF before a byte is written. The entrypoint
// reads this back and derives the exit status from `ok`, which also avoids
// depending on Wine to propagate one.
writeFileSync(new URL(`./report-${target}.json`, import.meta.url), JSON.stringify(report, null, 2))
process.exit(report.ok ? 0 : 1)
