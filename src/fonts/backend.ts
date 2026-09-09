/**
 * What a platform font registry has to be able to answer.
 *
 * Deliberately narrow: list the installed faces of one family, and say nothing
 * about which of them we want. Choosing is `systemMatch.ts`'s job, and keeping
 * it there means the registry back-ends, the directory scanner and the browser
 * all resolve a request the same way — a back-end that did its own matching
 * would quietly disagree with the others about what "bold" means.
 */

/** One installed face, as the platform describes it. */
export interface SystemFontFace {
  /** Absolute path to the file holding this face. May be a `.ttc`. */
  path: string
  /**
   * The family the platform matched.
   *
   * Kept so the caller can check it against what was asked for. Some registries
   * apply their own alias rules and answer a query for a missing family with a
   * substitute; substituting is a later tier's decision, not this one's.
   */
  family: string
  /**
   * The style within the family: `"Bold Oblique"`, `"W3"`, `"DefaultText"`.
   *
   * Absent where the platform reports weight and slant as numbers instead. A
   * back-end must not invent one: a face called BoldItalic described as
   * "Regular" is worse than a face described as nothing, because it reads as
   * data rather than as an absence.
   */
  style?: string
  /**
   * Weight and slant, when the platform states them outright.
   *
   * DirectWrite does — `IDWriteFont::GetWeight` returns a real 100–900 number
   * and `GetStyle` an enum — so on Windows there is no reason to infer them
   * from a style name. CoreText reports a style string instead, and those faces
   * leave these unset for `parseStyleName` to work out. Stated beats inferred
   * wherever it is available.
   */
  weight?: number
  italic?: boolean
}

export interface SystemFontBackend {
  /** A label for diagnostics: `coretext`, `fontconfig`, `scanner`. */
  readonly name: string
  /**
   * Every installed face of `family`, or an empty array when there are none.
   *
   * Asynchronous because one implementation genuinely is: the registry
   * back-ends call into C and return immediately, but the directory scanner
   * reads files. Making the odd one out sync would mean blocking the loop
   * during a scan of every font on the machine.
   */
  facesOf(family: string): Promise<SystemFontFace[]>
}
