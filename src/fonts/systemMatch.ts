/**
 * Choosing one installed face when a document asks for a family.
 *
 * Every source of system fonts hands back a flat list and leaves the choosing to
 * us: the OS registry, a directory scan, and the browser's Local Font Access API
 * all answer "here is everything called Helvetica" rather than "here is the one
 * you meant". `fc-match` used to do this step, and the rules it implemented are
 * the CSS ones, so those are the rules reimplemented here.
 *
 * This file imports nothing on purpose. It is the one piece shared by every
 * back-end, which makes it the piece that must be testable without a filesystem
 * — and the piece that stops the back-ends quietly disagreeing with each other.
 */

/** One installed face, reduced to what choosing needs. */
export interface FontVariant<T> {
  /** Whatever the back-end needs to fetch bytes: a path, a `FontData`, an index. */
  handle: T
  /** Stable identity. Only used to break ties reproducibly. */
  id: string
  weight: number
  italic: boolean
  /** CSS font-stretch, 1–9 with 5 as normal. Absent when the source omits it. */
  width?: number
}

/**
 * Normalise a family name for comparison.
 *
 * Case and internal whitespace are noise — a document saying `"noto  sans jp"`
 * means the family the OS calls `Noto Sans JP` — but nothing more aggressive is
 * safe. Stripping punctuation would collide `PT Sans` with `PTSans`, which are
 * genuinely different families.
 */
export function familyKey(family: string): string {
  return family.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Weight words, longest-qualified first.
 *
 * `bold` is last because it is a substring of the intent of `semibold` and
 * `extrabold`: testing it first would read `ExtraBold` as 700.
 */
const WEIGHT_WORDS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:thin|hairline)\b/, 100],
  [/\b(?:extra|ultra)\s?light\b/, 200],
  [/\blight\b/, 300],
  [/\b(?:regular|normal|book|roman)\b/, 400],
  [/\bmedium\b/, 500],
  [/\b(?:semi|demi)\s?bold\b/, 600],
  [/\b(?:extra|ultra)\s?bold\b/, 800],
  [/\b(?:black|heavy)\b/, 900],
  [/\bbold\b/, 700],
]

/** Hiragino and its relatives name weights `W0`–`W9` rather than in words. */
const CJK_WEIGHT = /\bw([0-9])\b/

/**
 * Read a style name such as `"Bold Italic"`, `"SemiBold"` or `"W3"`.
 *
 * Needed wherever the source reports a style *string* and no numeric weight:
 * the browser's `FontData` has no `usWeightClass`, and the faces inside a
 * TrueType collection are distinguished only by their `name` table. Helvetica
 * ships six such faces — Regular, Bold, Oblique, Bold Oblique, Light and Light
 * Oblique — so this is the only thing standing between a bold request and the
 * regular face.
 */
export function parseStyleName(style: string): { weight: number; italic: boolean } {
  // Split camel case before lowering, or `SemiBold` collapses to one word and
  // matches nothing.
  const text = style
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()

  const italic = /\b(?:italic|oblique)\b/.test(text)

  const cjk = CJK_WEIGHT.exec(text)
  if (cjk?.[1] !== undefined) return { weight: Number(cjk[1]) * 100, italic }

  const word = WEIGHT_WORDS.find(([pattern]) => pattern.test(text))
  return { weight: word?.[1] ?? 400, italic }
}

/**
 * How badly `candidate` misses `desired`, per CSS Fonts 4 §5.2.
 *
 * The *direction* of the miss matters more than its size. Asked for 300 with
 * {100, 400} installed, CSS picks 100: below the request is nearer to what was
 * asked for than above it, whatever the arithmetic says. Asked for 400 with
 * {350, 500}, it picks 500, because 400–500 is searched upward first.
 */
function weightRank(candidate: number, desired: number): number {
  let tier: number
  if (desired >= 400 && desired <= 500) {
    tier = candidate >= desired && candidate <= 500 ? 0 : candidate < desired ? 1 : 2
  } else if (desired < 400) {
    tier = candidate <= desired ? 0 : 1
  } else {
    tier = candidate >= desired ? 0 : 1
  }
  return tier * 10_000 + Math.abs(candidate - desired)
}

/** Distance from normal width. Sources that omit it are treated as normal. */
function widthRank(candidate: number | undefined): number {
  return candidate === undefined ? 0 : Math.abs(candidate - 5)
}

/**
 * The best installed face for `weight` and `italic`, or undefined if there are none.
 *
 * Slant and width are *preferences*, not filters, which is how `fc-match`
 * behaved and the right trade here: a roman face standing in for an italic
 * request is one synthetic oblique away from correct, whereas returning nothing
 * sends the caller to the network for a font the machine already has.
 *
 * Compared in CSS's order — width, then slant, then weight — with the face id
 * as the final tie-break so two equally good candidates resolve the same way on
 * every machine. Enumeration order is not stable across platforms and the
 * output of a run has to be.
 */
export function pickVariant<T>(
  variants: readonly FontVariant<T>[],
  weight: number,
  italic: boolean,
): FontVariant<T> | undefined {
  let best: FontVariant<T> | undefined
  let bestScore: [number, number, number] | undefined

  for (const variant of variants) {
    const score: [number, number, number] = [
      widthRank(variant.width),
      variant.italic === italic ? 0 : 1,
      weightRank(variant.weight, weight),
    ]
    if (bestScore === undefined || isBetter(score, bestScore, variant.id, best!.id)) {
      best = variant
      bestScore = score
    }
  }
  return best
}

function isBetter(
  score: readonly [number, number, number],
  incumbent: readonly [number, number, number],
  id: string,
  incumbentId: string,
): boolean {
  for (const [i, value] of score.entries()) {
    const other = incumbent[i]!
    if (value !== other) return value < other
  }
  return id < incumbentId
}
