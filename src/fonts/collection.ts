/**
 * Pull a single usable font out of a TrueType collection.
 *
 * `.ttc` is not an exotic format on the desktop — it is how macOS ships most of
 * its system faces, Helvetica and the CJK families included. But the parser
 * Satori uses, `@shuding/opentype.js`, rejects the container outright with
 * `Unsupported OpenType signature ttcf`, so until now every one of those faces
 * was unreachable no matter how we located it. Better discovery alone does not
 * help: it just finds bytes `coverage.ts` throws away.
 *
 * A collection is a thin wrapper — one header pointing at N ordinary table
 * directories that share the file's table data. Rebuilding one of them as a
 * standalone font is mechanical: copy the directory, copy the tables it points
 * at, and rewrite the offsets to match their new positions.
 *
 * Two things make this worth doing properly rather than taking face 0. A single
 * collection holds several *families*, not just several weights — macOS ships
 * `Hiragino Sans`, `Hiragino Kaku Gothic Pro` and `Hiragino Kaku Gothic ProN`
 * in one file — and it holds several *styles* of each, so Helvetica's six faces
 * are where its Bold and Oblique actually live. Both distinctions are only
 * visible in each face's own `name` table.
 */

/** `ttcf`, the collection header tag. */
const TTCF = 0x74_74_63_66
/** `name`, the table carrying the family and style strings. */
const NAME = 0x6e_61_6d_65

/** Family name. */
const NAME_ID_FAMILY = 1
/** Subfamily — "Bold", "Light Oblique". */
const NAME_ID_SUBFAMILY = 2
/**
 * Typographic family, which splits weights into their own family on faces that
 * predate the four-style limit. Preferred over `NAME_ID_FAMILY` where present,
 * because it is the name the OS reports and therefore the one a document asks
 * for.
 */
const NAME_ID_TYPOGRAPHIC_FAMILY = 16

/** Windows platform records are UTF-16BE; US English is language 0x0409. */
const PLATFORM_WINDOWS = 3
const PLATFORM_MACINTOSH = 1
const LANGUAGE_WINDOWS_EN_US = 0x04_09
const LANGUAGE_MACINTOSH_EN = 0

/** One face inside a collection, identified but not yet materialised. */
export interface CollectionFace {
  /** The family this face belongs to, as the OS reports it. */
  family: string
  /** The style within that family: "Regular", "Bold Oblique", "W3". */
  subfamily: string
  /**
   * Rebuild this face as a standalone font.
   *
   * Deferred rather than eager because collections are large — the four faces
   * of Hiragino W3 are about 7 MB each, and identifying the one we want costs
   * only a walk of the name tables.
   */
  extract(): Uint8Array
}

/**
 * Read one string from a face's `name` table.
 *
 * Records are keyed by platform *and* language, and a CJK font routinely
 * carries its family name in both Japanese and English. We want the English
 * one, since that is what a diagram's `font-family` will say — but we take a
 * non-English record over nothing, because some faces ship no English at all.
 */
function readName(
  bytes: Uint8Array,
  view: DataView,
  directory: number,
  nameId: number,
): string | undefined {
  const numTables = view.getUint16(directory + 4)

  let table = -1
  for (let i = 0; i < numTables; i += 1) {
    const record = directory + 12 + i * 16
    if (view.getUint32(record) === NAME) {
      table = view.getUint32(record + 8)
      break
    }
  }
  if (table < 0 || table + 6 > bytes.byteLength) return undefined

  const count = view.getUint16(table + 2)
  const strings = table + view.getUint16(table + 4)

  let fallback: string | undefined
  for (let i = 0; i < count; i += 1) {
    const record = table + 6 + i * 12
    if (view.getUint16(record + 6) !== nameId) continue

    const platform = view.getUint16(record)
    const language = view.getUint16(record + 4)
    const length = view.getUint16(record + 8)
    const offset = strings + view.getUint16(record + 10)
    if (offset + length > bytes.byteLength) continue

    const raw = bytes.subarray(offset, offset + length)
    // Macintosh records are single-byte; everything else is UTF-16BE. Latin-1
    // is not MacRoman, but the two agree across ASCII, which is all a family
    // name uses in practice on that platform.
    const text = new TextDecoder(platform === PLATFORM_MACINTOSH ? 'latin1' : 'utf-16be').decode(
      raw,
    )

    const english =
      platform === PLATFORM_WINDOWS
        ? language === LANGUAGE_WINDOWS_EN_US
        : language === LANGUAGE_MACINTOSH_EN
    if (english) return text
    fallback ??= text
  }
  return fallback
}

/**
 * Rebuild the face whose table directory starts at `directory`.
 *
 * The offset table is copied whole: its three search-hint fields are derived
 * from `numTables`, which does not change, so recomputing them would only be a
 * chance to get them wrong. Table data is laid out back to back on four-byte
 * boundaries, which is what every sfnt does and what the checksums assume.
 */
function rebuild(bytes: Uint8Array, view: DataView, directory: number): Uint8Array {
  const numTables = view.getUint16(directory + 4)

  const tables: Array<{ record: number; source: number; length: number; target: number }> = []
  let total = 12 + numTables * 16
  for (let i = 0; i < numTables; i += 1) {
    const record = directory + 12 + i * 16
    const length = view.getUint32(record + 12)
    tables.push({ record, source: view.getUint32(record + 8), length, target: total })
    total += (length + 3) & ~3
  }

  const out = new Uint8Array(total)
  const outView = new DataView(out.buffer)

  out.set(bytes.subarray(directory, directory + 12), 0)
  for (const [i, table] of tables.entries()) {
    const destination = 12 + i * 16
    // Tag and checksum carry over untouched; only the offset moves.
    out.set(bytes.subarray(table.record, table.record + 16), destination)
    outView.setUint32(destination + 8, table.target)
    out.set(bytes.subarray(table.source, table.source + table.length), table.target)
  }
  return out
}

/**
 * The faces inside `bytes`, or undefined when it is not a collection.
 *
 * Returning undefined rather than a single-element array keeps the caller's
 * "is this a collection?" test and its "which face?" test the same question,
 * so an ordinary `.ttf` never pays for this code path.
 */
export function splitCollection(bytes: Uint8Array): CollectionFace[] | undefined {
  if (bytes.byteLength < 12) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== TTCF) return undefined

  const numFonts = view.getUint32(8)
  const faces: CollectionFace[] = []
  for (let i = 0; i < numFonts; i += 1) {
    const header = 12 + i * 4
    if (header + 4 > bytes.byteLength) break
    const directory = view.getUint32(header)
    if (directory + 12 > bytes.byteLength) continue

    const family =
      readName(bytes, view, directory, NAME_ID_TYPOGRAPHIC_FAMILY) ??
      readName(bytes, view, directory, NAME_ID_FAMILY)
    if (family === undefined) continue

    // A leading dot marks a face Apple keeps for its own UI — `.PingFang UI SC`
    // and friends. They are not offered to applications by name, and matching
    // one would hand back a font the OS never intended us to use.
    if (family.startsWith('.')) continue

    faces.push({
      family,
      subfamily: readName(bytes, view, directory, NAME_ID_SUBFAMILY) ?? 'Regular',
      extract: () => rebuild(bytes, view, directory),
    })
  }
  return faces
}
