/**
 * Pick a fallback family for characters the requested font cannot draw.
 *
 * draw.io writes whatever family the shape style names, even when the label is
 * in a script that family has never covered: the reference export sets Japanese
 * text in `Helvetica` and puts `東京都` inside a `Lucida Console` code block. A
 * browser resolves this silently through the system fallback chain, so a
 * converter that does not is the odd one out — it would emit tofu where the
 * original rendered fine.
 *
 * The Noto families are the natural target: they are on Google Fonts, so the
 * webfont tier can fetch them, and they exist for every script we might meet.
 */

interface ScriptRange {
  family: string
  test: RegExp
}

/** Ordered by specificity: the first match wins. */
const SCRIPTS: ScriptRange[] = [
  // Kana is unambiguously Japanese; Han alone is not, so it is checked later.
  { family: 'Noto Sans JP', test: /[぀-ゟ゠-ヿㇰ-ㇿ]/u },
  { family: 'Noto Sans KR', test: /[가-힯ᄀ-ᇿ㄰-㆏]/u },
  { family: 'Noto Sans Thai', test: /[฀-๿]/u },
  { family: 'Noto Sans Devanagari', test: /[ऀ-ॿ]/u },
  { family: 'Noto Sans Arabic', test: /[؀-ۿݐ-ݿ]/u },
  { family: 'Noto Sans Hebrew', test: /[֐-׿]/u },
  // Han without kana: Simplified Chinese is the most common case by far.
  { family: 'Noto Sans SC', test: /[一-鿿㐀-䶿]/u },
  // CJK punctuation and full-width forms travel with any of the above.
  { family: 'Noto Sans JP', test: /[　-〿＀-￯]/u },
  // Enclosed alphanumerics such as the circled digits draw.io uses for callouts.
  { family: 'Noto Sans JP', test: /[①-⓿㈀-㋿]/u },
]

/** Family likely to cover these characters, or `undefined` if we cannot tell. */
export function fallbackFamilyFor(characters: string): string | undefined {
  for (const script of SCRIPTS) {
    if (script.test.test(characters)) return script.family
  }
  // Latin, Greek, Cyrillic and most symbols live in the base Noto Sans.
  return /[^\p{ASCII}]/u.test(characters) ? 'Noto Sans' : undefined
}

/**
 * Families the document itself names, in preference order.
 *
 * A family the export already declares is the best fallback candidate we have:
 * the diagram's author chose it, other labels use it, and it is very likely to
 * cover the same script. A document whose `@import` names a CJK family, while
 * its Japanese labels are marked up as Helvetica, is the case this serves.
 */
export function familiesDeclaredIn(svg: string): string[] {
  const families = new Set<string>()

  // @import url("https://fonts.googleapis.com/css?family=Noto+Sans+JP")
  for (const match of svg.matchAll(/fonts\.googleapis\.com\/css2?\?([^"')\s]+)/g)) {
    for (const parameter of match[1]!.split('&')) {
      const [key, value] = parameter.split('=')
      if (key !== 'family' || value === undefined) continue
      const family = decodeURIComponent(value.split(':')[0]!).replace(/\+/g, ' ').trim()
      if (family !== '') families.add(family)
    }
  }

  const add = (value: string): void => {
    // A stack is a list; only its first entry is what the document asked for.
    const first = value.split(',')[0]!
    const family = first.replace(/&quot;/g, '').replace(/&apos;/g, '').replace(/["']/g, '').trim()
    if (family !== '') families.add(family)
  }

  // A presentation attribute, matched against the *raw* source.
  //
  // Order matters here. Decoding entities first — which the declaration pass
  // below has to do — turns `font-family="&quot;Helvetica&quot;"` into
  // `font-family=""Helvetica""`, where the attribute's own delimiter is no
  // longer distinguishable from the CSS quoting inside it. Matching first and
  // decoding after keeps the two apart.
  for (const match of svg.matchAll(/font-family\s*=\s*"([^"]*)"|font-family\s*=\s*'([^']*)'/g)) {
    add(match[1] ?? match[2] ?? '')
  }

  // A declaration, in a `<style>` block or a `style` attribute.
  //
  // Entities are decoded first because draw.io writes `font-family: &quot;Lucida
  // Console&quot;`, and the `;` ending that entity would otherwise look like the
  // end of the declaration. The quoted alternatives come first so a value
  // containing spaces survives; the unquoted fallback stops at a quote as well
  // as at `;`, `}` and `>`, because `style="font-family:Helvetica"` ends at the
  // attribute's closing quote and nothing else.
  const decoded = svg.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  for (const match of decoded.matchAll(
    /font-family\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;}>"']*))/g,
  )) {
    add(match[1] ?? match[2] ?? match[3] ?? '')
  }

  return [...families]
}
