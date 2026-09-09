/**
 * What this package knows about font families, on its own.
 *
 * These tables are the judgement behind font resolution rather than the
 * machinery of it: which substitutes preserve advance widths and which reflow
 * the text, which families need coverage no Latin face can provide, and which
 * script a run of characters belongs to.
 *
 * They are exported because a consumer often has to make the same decision
 * *before* this package runs. A browser build shapes text with whatever fonts
 * the page has loaded, so an application that wants deterministic output has to
 * choose which families to load — and choosing well needs exactly this
 * knowledge. The alternative is a second copy of the tables, and a second copy
 * can drift: the distinction between a metric-compatible substitution and one
 * that moves every glyph is easy to lose and expensive to lose silently.
 *
 * Everything here is pure. No filesystem, no network, no native binary — the
 * same code runs in Node and in a browser, and `npm run check:browser` proves
 * it stays that way.
 */
export { needsWideCoverage, repairFamily, substituteFamily } from './aliases.js'
export type { Substitution } from './aliases.js'
export { fallbackFamilyFor, familiesDeclaredIn } from './script.js'
