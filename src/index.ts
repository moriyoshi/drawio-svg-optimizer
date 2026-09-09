import type { PluginConfig } from 'svgo'
import { dropRasterFallback } from './plugins/dropRasterFallback.js'
import { stripMetadata } from './plugins/stripMetadata.js'
import { switchCollapse } from './plugins/switchCollapse.js'
import { flattenGroups, structuralPlugins } from './plugins/structure.js'
import { byteSizes, makeStatRecorder, runSvgo } from './core/pipeline.js'
import type { PipelineResult } from './core/pipeline.js'
import { protectRegions, restoreRegions } from './core/protect.js'
import { collectReferencedIds } from './core/references.js'
import { createContext } from './core/types.js'
import { sanitize } from './security/sanitize.js'
import { STRICT_POLICY } from './security/policy.js'
import type { NetworkPolicy } from './security/policy.js'
import { parseLabel } from './html/label.js'
import type { ParsedLabel } from './html/label.js'
import { familiesDeclaredIn } from './fonts/script.js'
import { inlineFontFaces, rewriteFontImports } from './plugins/fontImports.js'
import { consolidateStyles } from './plugins/consolidateStyles.js'
import { stripStrayClasses } from './plugins/stripStrayClasses.js'
import { satoriUnwrap } from './plugins/satoriUnwrap.js'
import type { FontMode } from './fonts/resolve.js'
import type { FontBackend } from './fonts/backends.js'

export type Preset = 'safe' | 'default' | 'aggressive'

export interface OptimizeOptions {
  /** @default 'default' */
  preset?: Preset
  /** Pretty-print the output. @default false */
  pretty?: boolean
  /** Collect per-stage raw and gzip byte counts. @default false */
  stats?: boolean

  /** Drop the rasterised `<image>` label fallbacks. @default true */
  dropRasterFallback?: boolean
  /** Collapse `<switch>` wrappers onto draw.io's own `<text>` fallback. @default true */
  collapseSwitches?: boolean
  /** Strip `data-cell-id` and other editor bookkeeping. @default preset-dependent */
  stripMetadata?: boolean
  /** Remove the embedded `<mxfile>` diagram source. @default preset-dependent */
  stripDiagramSource?: boolean
  /** Remove ids nothing refers to. @default true */
  cleanupIds?: boolean
  /** Ids to keep regardless, in addition to those found referenced. */
  preserveIds?: string[]
  /** Collapse redundant groups and tidy path data. @default true */
  structure?: boolean
  /**
   * Fold repeated inline styles into CSS classes.
   *
   * Off by default: it cuts raw bytes a lot but gzip by ~1.5%, since gzip
   * already dedupes those strings. Worth it for files in a repository or a
   * document, not for transfer size.
   *
   * @default false
   */
  consolidateStyles?: boolean
  /** Emit short unscoped class names, safe only for standalone files. @default false */
  unscopedClasses?: boolean
  /**
   * Also fold repeated `fill`/`stroke`/font presentation attributes.
   *
   * Safe because presentation attributes are the weakest thing in the author
   * origin: the generated rules are ordered so an inline `style` still wins.
   *
   * @default true (when `consolidateStyles` is on)
   */
  presentationAttributes?: boolean
  /** Remove class names no rule in the document defines. @default true */
  stripStrayClasses?: boolean
  /** Class names to keep even when nothing selects them. */
  keepClasses?: RegExp
  /** Decimal places kept on coordinates. @default 2 (1 under `aggressive`) */
  floatPrecision?: number

  /**
   * Convert HTML labels to native SVG text with Satori.
   *
   * Off by default: Satori's layout is close to a browser's but not identical,
   * so this is a fidelity trade rather than a free win. It is the only way to
   * remove a `foreignObject` whose export has no `<text>` fallback.
   *
   * @default true under the `aggressive` preset, false otherwise
   */
  satori?: boolean
  /** Where fonts may come from. @default 'auto' (config, then system, then webfont) */
  fontMode?: FontMode
  /** Explicit family -> font file path, taking precedence over every tier. */
  fontFiles?: Record<string, string | Uint8Array>
  /** Directory the `bundled` font tier reads. */
  fontDir?: string
  /**
   * Where installed fonts come from.
   *
   * `auto` asks the platform's font registry — CoreText, DirectWrite or
   * fontconfig — through an optional native binary, and walks the font
   * directories when that is unavailable. `scanner` walks the directories
   * regardless, for callers who would rather not load a native binary even
   * where one would work. The registry sees more: on a stock Mac it reports
   * 246 families against a scan's 194.
   *
   * @default 'auto'
   */
  fontBackend?: FontBackend
  /** Never touch the network when resolving fonts. @default false */
  offline?: boolean
  /** Directory for the downloaded-font cache. */
  fontCacheDir?: string
  /** Compact converted text. Off keeps Satori's raw, measurable output. @default true */
  compactText?: boolean
  /**
   * How the output supplies the fonts its text was shaped with.
   *
   * - `inline` embeds the subsets as `data:` URIs: self-contained, renders with
   *   no network access, and guarantees the viewer uses the exact bytes the text
   *   was measured against. Costs bytes.
   * - `import` writes an `@import` for the families, which is smaller but makes
   *   the viewer fetch them — permitted only if the policy allows the host.
   * - `none` writes nothing; text falls back to whatever the viewer has, with
   *   the wrong metrics.
   *
   * Defaults to `none`, because the strict policy forbids the `@import` and
   * embedding roughly triples the file. Degradation is graceful: every run is
   * absolutely positioned, so a substituted font changes glyph advances within a
   * line but not where the line starts.
   *
   * @default 'none'
   */
  fontDelivery?: 'inline' | 'import' | 'none'

  /**
   * Remove everything that can reach the network or execute.
   *
   * On by default: these files usually come from someone else. @default true
   */
  sanitize?: boolean
  /** Hosts the document is permitted to reference. @default none */
  allowedHosts?: string[]
}

export type { PipelineResult, OptimizeStats, StageStat } from './core/pipeline.js'
export type { Warning } from './core/types.js'

interface ResolvedOptions {
  dropRasterFallback: boolean
  collapseSwitches: boolean
  stripMetadata: boolean
  stripDiagramSource: boolean
  cleanupIds: boolean
  satori: boolean
  structure: boolean
  floatPrecision: number
}

/** Presets differ only in how much they are willing to give up; passes are shared. */
function resolve(options: OptimizeOptions): ResolvedOptions {
  const preset = options.preset ?? 'default'
  const safe = preset === 'safe'
  return {
    dropRasterFallback: options.dropRasterFallback ?? true,
    collapseSwitches: options.collapseSwitches ?? true,
    // The `safe` preset keeps everything that makes the file re-editable.
    stripMetadata: options.stripMetadata ?? !safe,
    stripDiagramSource: options.stripDiagramSource ?? !safe,
    cleanupIds: options.cleanupIds ?? true,
    satori: options.satori ?? preset === 'aggressive',
    // The `safe` preset leaves path data untouched; rewriting coordinates is
    // visually lossless but not byte-lossless, which is the promise it makes.
    structure: options.structure ?? !safe,
    floatPrecision: options.floatPrecision ?? (preset === 'aggressive' ? 1 : 2),
  }
}

/**
 * Optimize an SVG exported from diagrams.net (draw.io).
 *
 * Passes are ordered by measured value rather than by conception: dropping the
 * raster label fallbacks alone takes the reference export from 515,741 to
 * 46,479 bytes, and from 353,959 to 4,092 gzipped — ~99% of the achievable win,
 * because base64 PNG is already-compressed data that gzip cannot touch.
 */
export async function optimizeDrawioSvg(
  svg: string,
  options: OptimizeOptions = {},
): Promise<PipelineResult> {
  const settings = resolve(options)
  const pretty = options.pretty ?? false
  const context = createContext()
  const recorder = makeStatRecorder(options.stats ?? false)
  await recorder.record('original', svg)

  const policy: NetworkPolicy = {
    ...STRICT_POLICY,
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
  }

  // Sanitize before anything else looks at the document: every later pass then
  // works on source that cannot reach the network or execute.
  let source = svg
  if (options.sanitize ?? true) {
    source = sanitize(svg, { context, policy }).svg
    await recorder.record('sanitized', source)
  }

  // Withhold foreignObject subtrees and <style> text from SVGO's lossy parser.
  const { svg: protectedSvg, regions } = protectRegions(source)

  // Parse every label once, keyed by its protection slot, so passes can consult
  // the real HTML instead of the placeholder SVGO sees.
  const labels = new Map<string, ParsedLabel>()
  for (const region of regions) {
    if (region.kind === 'subtree') labels.set(region.token, parseLabel(region.source))
  }

  // Satori runs before SVGO: it rewrites the protected regions in place, and the
  // plugin below only has to strip the scaffolding around what it converted.
  let converted = new Set<string>()
  let webFamilies = new Set<string>()
  let usedFamilies = new Set<string>()
  let faces = new Map<string, { data: Uint8Array; weight: number; style: 'normal' | 'italic' }>()
  if (settings.satori) {
    // Imported here rather than at the top on purpose. Satori pulls in
    // harfbuzzjs, which fetches a 382 KB `hb.wasm` relative to the document
    // *at module-evaluation time* — so a static import makes every browser
    // consumer pay for it, and fail on it, even when they never enable Satori.
    // Bundlers code-split on this; Node pays one extra microtask.
    const { runSatoriStage } = await import('./core/satoriStage.js')
    const stage = await runSatoriStage(regions, labels, {
      context,
      fontMode: options.fontMode ?? 'auto',
      // The document's own @import and font-family declarations are the best
      // fallback candidates for scripts a declared font cannot cover.
      declaredFamilies: familiesDeclaredIn(source),
      ...(options.fontFiles === undefined ? {} : { fontFiles: options.fontFiles }),
      ...(options.fontDir === undefined ? {} : { fontDir: options.fontDir }),
      ...(options.fontBackend === undefined ? {} : { fontBackend: options.fontBackend }),
      ...(options.offline === undefined ? {} : { offline: options.offline }),
      ...(options.fontCacheDir === undefined ? {} : { cacheDir: options.fontCacheDir }),
      ...(options.compactText === undefined ? {} : { compactText: options.compactText }),
    })
    converted = stage.converted
    webFamilies = stage.webFamilies
    usedFamilies = stage.usedFamilies
    faces = stage.faces
    // The stage rewrites `region.source` in place rather than the document, so
    // measuring `svg` here reported the *original* bytes and made this row a
    // duplicate of `original` on every run. Splicing the regions back gives the
    // document as it actually stands after conversion. Guarded because the
    // splice is real work and `record` would otherwise discard it.
    if (options.stats ?? false) {
      await recorder.record('satori', restoreRegions(protectedSvg, regions).svg)
    }
  }

  const plugins: PluginConfig[] = []
  if (converted.size > 0) plugins.push(satoriUnwrap({ converted }))
  if (settings.dropRasterFallback) plugins.push(dropRasterFallback({ context }))
  const droppedSlots = new Set<string>()
  if (settings.collapseSwitches) {
    plugins.push(switchCollapse({ context, labels, deferred: converted, dropped: droppedSlots }))
  }
  if (settings.stripMetadata) {
    plugins.push(stripMetadata({ context, stripDiagramSource: settings.stripDiagramSource }))
  }
  // Runs after the label passes, so groups emptied by them can be collapsed.
  if (settings.structure) {
    plugins.push(...structuralPlugins(settings.floatPrecision), flattenGroups())
  }
  if (settings.cleanupIds) {
    const referenced = collectReferencedIds(source)
    for (const id of options.preserveIds ?? []) referenced.add(id)
    plugins.push({ name: 'cleanupIds', params: { preserve: [...referenced] } })
  }

  const optimized = runSvgo({ svg: protectedSvg, regions, plugins, pretty })
  const restored = restoreRegions(optimized, regions)
  let data = restored.svg

  // A placeholder that vanished without a pass claiming it means a label was
  // eaten by accident — silent content loss, and worth shouting about.
  for (const token of restored.missing) {
    if (droppedSlots.has(token)) continue
    context.warn(
      'label-lost',
      'A label disappeared during optimization and could not be restored.',
      token,
    )
  }

  // Runs last: it needs the final document, and only now do we know which
  // families the converted text ended up naming.
  const delivery = options.fontDelivery ?? 'none'
  if (faces.size > 0 && delivery === 'inline') {
    data = inlineFontFaces(data, faces, context)
  } else if (delivery === 'none' && faces.size > 0) {
    // Only when embedding was actually possible. A stage that produced no bytes
    // reports that itself, and saying both would be noise.
    context.warn(
      'fonts-not-supplied',
      'The converted text names fonts the file does not supply; a viewer without them will render at slightly different widths. Use fontDelivery "inline" to embed them.',
      [...usedFamilies].join(', '),
    )
  } else if (delivery === 'import' && webFamilies.size === 0 && usedFamilies.size > 0) {
    // `import` can only name families we proved are fetchable. Emitting nothing
    // and saying nothing leaves a document whose text references fonts it never
    // asks the viewer to load.
    context.warn(
      'fonts-not-supplied',
      'No @import could be written: none of the fonts used were resolved from a webfont host. Use fontDelivery "inline" instead.',
      [...usedFamilies].join(', '),
    )
  } else if (webFamilies.size > 0 && delivery === 'import') {
    if (policy.allowedHosts.length === 0) {
      context.warn(
        'font-import-blocked',
        'Refused to write a webfont @import: no host is allowed by the policy. Use fontDelivery "inline", or allow fonts.googleapis.com.',
      )
    } else {
      data = rewriteFontImports(data, webFamilies, context)
    }
  }

  // Before consolidation, so classes we are about to add are never candidates.
  if ((options.stripStrayClasses ?? true) && data.includes('class=')) {
    data = stripStrayClasses(data, { context, keep: options.keepClasses })
  }

  // Last of all: it rewrites attributes across the finished document, including
  // the label HTML that SVGO never saw.
  if (options.consolidateStyles === true) {
    data = consolidateStyles(data, {
      context,
      ...(options.unscopedClasses === undefined ? {} : { unscoped: options.unscopedClasses }),
      ...(options.presentationAttributes === undefined
        ? {}
        : { presentationAttributes: options.presentationAttributes }),
    }).svg
  }
  await recorder.record('optimized', data)

  const before = await byteSizes(svg)
  const after = await byteSizes(data)
  return {
    data,
    stats: {
      stages: recorder.stages,
      raw: { before: before.raw, after: after.raw },
      gzip: { before: before.gzip, after: after.gzip },
    },
    warnings: context.warnings,
  }
}
