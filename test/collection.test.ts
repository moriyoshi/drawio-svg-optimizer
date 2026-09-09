import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@shuding/opentype.js'
import { describe, expect, it } from 'vitest'
import { splitCollection } from '../src/fonts/collection.js'
import { missingGlyphs } from '../src/fonts/coverage.js'

/**
 * A `name` table carrying one Windows/US-English record per entry.
 *
 * Real fonts carry Macintosh and localized records too, but the reader only has
 * to prefer English among whatever is present, and building one encoding keeps
 * the fixture readable.
 */
function nameTable(entries: Array<{ id: number; text: string }>): Uint8Array {
  const encoded = entries.map((entry) => {
    // UTF-16 code *units*, not code points: the `name` table stores UTF-16BE,
    // so a surrogate pair has to be written as its two units rather than as one
    // combined value.
    const utf16 = new Uint8Array(entry.text.length * 2)
    const view = new DataView(utf16.buffer)
    for (let i = 0; i < entry.text.length; i += 1) {
      view.setUint16(i * 2, entry.text.charCodeAt(i))
    }
    return { id: entry.id, bytes: utf16 }
  })

  const header = 6 + encoded.length * 12
  const storage = encoded.reduce((sum, entry) => sum + entry.bytes.length, 0)
  const table = new Uint8Array(header + storage)
  const view = new DataView(table.buffer)

  view.setUint16(0, 0) // format
  view.setUint16(2, encoded.length)
  view.setUint16(4, header) // stringOffset

  let cursor = 0
  for (const [i, entry] of encoded.entries()) {
    const record = 6 + i * 12
    view.setUint16(record, 3) // platformID: Windows
    view.setUint16(record + 2, 1) // encodingID: UCS-2
    view.setUint16(record + 4, 0x04_09) // languageID: en-US
    view.setUint16(record + 6, entry.id)
    view.setUint16(record + 8, entry.bytes.length)
    view.setUint16(record + 10, cursor)
    table.set(entry.bytes, header + cursor)
    cursor += entry.bytes.length
  }
  return table
}

const tag = (text: string): number => new DataView(new TextEncoder().encode(text).buffer).getUint32(0)

interface Face {
  tables: Array<{ tag: string; data: Uint8Array }>
}

/**
 * Assemble a collection whose faces deliberately *share* table data.
 *
 * Sharing is the whole reason a collection exists, and it is what makes naive
 * extraction wrong: two directories point at one blob, so the rebuilt faces must
 * each get their own copy with their own offsets.
 */
function buildCollection(faces: Face[]): Uint8Array {
  // Keyed by identity, not by tag: two faces share data only when the caller
  // hands over the very same array. Deduplicating by tag instead would silently
  // give every face the first face's `name` table, which is exactly the bug
  // this fixture exists to rule out.
  const blobs = new Map<Uint8Array, number>()

  // Reserve the header, then every face's directory, then the table data.
  let cursor = 12 + faces.length * 4
  const directories = faces.map((face) => {
    const at = cursor
    cursor += 12 + face.tables.length * 16
    return at
  })
  for (const face of faces) {
    for (const table of face.tables) {
      if (blobs.has(table.data)) continue
      blobs.set(table.data, cursor)
      cursor += (table.data.length + 3) & ~3
    }
  }

  const bytes = new Uint8Array(cursor)
  const view = new DataView(bytes.buffer)
  bytes.set(new TextEncoder().encode('ttcf'), 0)
  view.setUint32(4, 0x00_02_00_00)
  view.setUint32(8, faces.length)

  for (const [i, face] of faces.entries()) {
    const directory = directories[i]!
    view.setUint32(12 + i * 4, directory)
    view.setUint32(directory, 0x00_01_00_00) // sfntVersion
    view.setUint16(directory + 4, face.tables.length)
    for (const [j, table] of face.tables.entries()) {
      const offset = blobs.get(table.data)!
      const record = directory + 12 + j * 16
      view.setUint32(record, tag(table.tag))
      view.setUint32(record + 4, 0) // checksum, unverified by any reader here
      view.setUint32(record + 8, offset)
      view.setUint32(record + 12, table.data.length)
      bytes.set(table.data, offset)
    }
  }
  return bytes
}

/** Read a table back out of a rebuilt face, following its own directory. */
function tableOf(font: Uint8Array, wanted: string): Uint8Array | undefined {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength)
  const numTables = view.getUint16(4)
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16
    if (view.getUint32(record) !== tag(wanted)) continue
    const offset = view.getUint32(record + 8)
    return font.subarray(offset, offset + view.getUint32(record + 12))
  }
  return undefined
}

describe('TrueType collections', () => {
  const shared = new Uint8Array([1, 2, 3, 4, 5, 6, 7])

  const collection = buildCollection([
    {
      tables: [
        { tag: 'cmap', data: shared },
        {
          tag: 'name',
          data: nameTable([
            { id: 1, text: 'Test Family' },
            { id: 2, text: 'Regular' },
          ]),
        },
      ],
    },
    {
      tables: [
        { tag: 'cmap', data: shared },
        {
          tag: 'name',
          data: nameTable([
            { id: 1, text: 'Legacy Family' },
            { id: 2, text: 'Bold' },
            { id: 16, text: 'Typographic Family' },
          ]),
        },
      ],
    },
    {
      tables: [{ tag: 'name', data: nameTable([{ id: 1, text: '.Internal UI' }]) }],
    },
  ])

  it('is not confused by an ordinary font', async () => {
    // A plain sfnt must take the cheap path, not be reported as a one-face
    // collection — the caller uses `undefined` to mean "nothing to unpack".
    const sfnt = new Uint8Array(16)
    new DataView(sfnt.buffer).setUint32(0, 0x00_01_00_00)
    expect(splitCollection(sfnt)).toBeUndefined()
    expect(splitCollection(new TextEncoder().encode('not a font'))).toBeUndefined()
    expect(splitCollection(new Uint8Array(0))).toBeUndefined()
  })

  it('reads the family and style of every face', async () => {
    const faces = splitCollection(collection)!
    expect(faces.map((face) => `${face.family} / ${face.subfamily}`)).toEqual([
      'Test Family / Regular',
      // Name ID 16 wins over ID 1: it is the name the OS reports, so it is the
      // one a document's `font-family` will have been written against.
      'Typographic Family / Bold',
    ])
  })

  it('hides the faces the platform keeps for itself', async () => {
    // Apple ships `.PingFang UI SC` and friends inside real collections. They
    // are never offered to applications by name, so matching one would hand
    // back a font the OS did not intend us to use.
    const faces = splitCollection(collection)!
    expect(faces.some((face) => face.family.startsWith('.'))).toBe(false)
  })

  it('gives each face its own copy of the tables they share', async () => {
    const faces = splitCollection(collection)!
    for (const face of faces) {
      const font = face.extract()
      expect([...tableOf(font, 'cmap')!]).toEqual([...shared])
    }
    // The rebuilt faces are independent files, so the shared blob has to land at
    // an offset valid within each one rather than within the collection.
    const [first, second] = faces.map((face) => face.extract())
    const view = new DataView(first!.buffer)
    expect(view.getUint32(12 + 8)).toBeLessThan(first!.length)
    expect(second!.length).toBeGreaterThan(0)
  })

  it('rebuilds a face as a standalone font with rewritten offsets', async () => {
    const font = splitCollection(collection)![0]!.extract()
    const view = new DataView(font.buffer, font.byteOffset, font.byteLength)

    expect(view.getUint32(0)).toBe(0x00_01_00_00) // sfntVersion carried over
    expect(view.getUint16(4)).toBe(2) // numTables

    // Every offset must point inside this font, not back into the collection.
    for (let i = 0; i < 2; i += 1) {
      const record = 12 + i * 16
      const offset = view.getUint32(record + 8)
      const length = view.getUint32(record + 12)
      expect(offset).toBeGreaterThanOrEqual(12 + 2 * 16)
      expect(offset + length).toBeLessThanOrEqual(font.length)
    }
  })

  it('defers the copy until a face is actually wanted', async () => {
    // Identifying a face costs a walk of its name table; materialising one costs
    // megabytes. A CJK collection holds four faces of about 7 MB each, so the
    // difference decides whether the system tier is usable at all.
    const faces = splitCollection(collection)!
    expect(typeof faces[0]!.extract).toBe('function')
    expect(faces[0]!.extract()).not.toBe(faces[0]!.extract())
  })
})

/**
 * The property that matters, checked against fonts we did not write.
 *
 * The unit tests above prove the rebuild is self-consistent; only a real
 * collection proves it produces something `@shuding/opentype.js` will accept —
 * which is the entire point, since that is the parser Satori renders with.
 */
const SYSTEM_FONT_DIRS = [
  '/System/Library/Fonts',
  '/System/Library/Fonts/Supplemental',
  'C:\\Windows\\Fonts',
]

function findCollections(limit: number): string[] {
  const found: string[] = []
  for (const dir of SYSTEM_FONT_DIRS) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.ttc')) found.push(join(dir, entry))
      if (found.length >= limit) return found
    }
  }
  return found
}

const collections = findCollections(8)
const whenInstalled = collections.length > 0 ? describe : describe.skip

whenInstalled('collections installed on this machine', () => {
  it('produces faces the renderer can actually parse', async () => {
    // Parseability is the property, not coverage: `Apple Color Emoji.ttc` reads
    // perfectly well and contains no `A` at all, and `AquaKana` is kana-only.
    // Asking `missingGlyphs` would conflate "we broke the font" with "this font
    // does not have that character", and only the first is a bug here.
    let checked = 0
    for (const path of collections) {
      const faces = splitCollection(readFileSync(path))
      expect(faces).toBeDefined()
      for (const face of faces!) {
        const bytes = face.extract()
        const standalone = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        const parsed = parse(standalone as ArrayBuffer)
        expect(parsed.numGlyphs).toBeGreaterThan(0)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  it('covers Latin text from a collection the scanner cannot reach', async () => {
    // The point of the whole exercise: Helvetica ships only as a collection, so
    // before this the system tier could never return it however well it was
    // located. Skipped where Helvetica is not a collection, i.e. off macOS.
    const helvetica = collections.find((path) => path.endsWith('Helvetica.ttc'))
    if (helvetica === undefined) return
    const faces = splitCollection(readFileSync(helvetica))!
    const regular = faces.find((face) => face.subfamily === 'Regular')
    expect(regular?.family).toBe('Helvetica')
    expect(missingGlyphs(regular!.extract(), 'Hello')).toEqual([])
  })
})
