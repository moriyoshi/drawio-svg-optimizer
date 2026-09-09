import { optimize } from 'svgo'
import type { PluginConfig } from 'svgo'
import { gzipSize } from './gzip.js'
import type { ProtectedRegion } from './protect.js'
import type { Warning } from './types.js'

export interface StageStat {
  name: string
  raw: number
  gzip: number
}

export interface OptimizeStats {
  /** Byte counts after each named stage, starting with `original`. */
  stages: StageStat[]
  raw: { before: number; after: number }
  gzip: { before: number; after: number }
}

export interface PipelineResult {
  data: string
  stats: OptimizeStats
  warnings: Warning[]
}

export async function byteSizes(svg: string): Promise<{ raw: number; gzip: number }> {
  const bytes = new TextEncoder().encode(svg)
  return { raw: bytes.byteLength, gzip: await gzipSize(bytes) }
}

export interface StatRecorder {
  stages: StageStat[]
  record(name: string, svg: string): Promise<void>
}

/** Records stage sizes; gzip is not cheap, so skip the work when nobody asked. */
export function makeStatRecorder(measure: boolean): StatRecorder {
  const stages: StageStat[] = []
  return {
    stages,
    async record(name, svg) {
      if (!measure) return
      stages.push({ name, ...(await byteSizes(svg)) })
    },
  }
}

export interface SvgoRun {
  svg: string
  regions: ProtectedRegion[]
  plugins: PluginConfig[]
  pretty: boolean
}

/**
 * Run the SVGO half of the pipeline over already-protected source.
 *
 * Protection happens once for the whole run rather than per pass: SVGO applies
 * plugins in order within a single `optimize()` call, so there is no reason to
 * pay for repeated parse/stringify cycles — and every extra cycle would be
 * another chance for the parser bugs described in `protect.ts` to bite.
 */
export function runSvgo(run: SvgoRun): string {
  return optimize(run.svg, {
    plugins: run.plugins,
    js2svg: { pretty: run.pretty, indent: 2 },
  }).data
}
