/**
 * The optimizer, in a browser.
 *
 * Identical to the Node entry point in everything it does to a document. The
 * difference is how labels are shaped: Satori reimplements text layout because
 * on Node there is nothing else, whereas a page already has a layout engine,
 * already has the fonts, and is the thing the output will be viewed in. So this
 * build renders each label into a hidden node and reads back the geometry the
 * engine produced — see `core/domShape.ts`.
 *
 * What follows from that:
 *
 * - **No font is resolved, fetched or parsed.** The `system`, `bundled` and
 *   `webfont` tiers do not run here at all, so there is nothing for CORS or a
 *   `font-src` policy to refuse. Which fonts the text is measured against is
 *   decided entirely by what the page has loaded — an application that wants
 *   deterministic output should load them itself, and the `@moriyoshi/drawio-svg-optimizer/fonts`
 *   subpath exports the family tables for choosing which.
 * - **Satori is not in the bundle**, nor harfbuzz, yoga or opentype.js.
 * - **There are no font bytes to embed** unless the caller supplies them.
 *   `fontFiles` accepts `Uint8Array`, and supplied faces are registered with
 *   `document.fonts` before measuring so that the face measured and the face
 *   embedded are the same one. Without that, output carries a
 *   `fonts-measured-locally` warning.
 * - **Reported gzip sizes read about 3% high**, because `CompressionStream`
 *   compresses at zlib level 6 where Node uses level 9.
 *
 * None of these throw. Each degrades to a warning on the result.
 */
export { optimizeDrawioSvg } from '../index.js'
export type { OptimizeOptions, Preset } from '../index.js'
export type { PipelineResult, OptimizeStats, StageStat } from '../core/pipeline.js'
export type { Warning } from '../core/types.js'
