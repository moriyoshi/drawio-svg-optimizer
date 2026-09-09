#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { outputPath } from './outputPath.js'
import { optimizeDrawioSvg } from './index.js'
import type { OptimizeOptions, Preset } from './index.js'
import type { Warning } from './core/types.js'

const USAGE = `drawio-svgo — optimize SVGs exported from diagrams.net

  drawio-svgo [options] <file.svg...>

Options
  -o, --out <path>       Write to this file (single input) or directory
      --preset <name>    safe | default | aggressive            (default: default)
      --satori           Convert HTML labels to SVG text        (default: aggressive only)
      --no-satori        Leave HTML labels alone
      --fonts <mode>     auto | webfont | system | bundled | off  (default: auto)
      --font <F=path>    Use this font file for family F        (repeatable)
      --offline          Never fetch webfonts
      --font-dir <path>  Directory the bundled font tier reads
      --font-backend <b> auto | scanner   Where installed fonts come from
      --font-delivery <m>  none | inline | import                (default: none)
      --allow-host <h>   Permit references to this host          (repeatable)
      --no-sanitize      Keep script, external references and the DOCTYPE
      --keep-source      Keep the embedded <mxfile> (stays re-editable in diagrams.net)
      --consolidate-styles  Fold repeated inline styles into CSS classes
      --unscoped-classes    Use short global class names (standalone files only)
      --keep-classes <re>   Keep class names matching this pattern
      --no-fold-attrs       Fold only style="", not fill=/stroke= attributes
      --pretty           Pretty-print the output
      --stats            Report raw and gzip bytes per stage
  -q, --quiet            Suppress warnings
  -h, --help             Show this message

Notes
  Input is sanitized by default: script, event handlers, external
  references and the DOCTYPE are removed, so neither this tool nor a
  viewer of the output fetches anything the diagram asks for. Pass
  --allow-host to permit a specific host, or --no-sanitize to disable.

  The 'default' preset preserves how the diagram renders in a browser.
  --consolidate-styles cuts raw bytes a lot but makes gzipped output
  slightly larger, so it is off by default. Use it for files kept in a
  repository or embedded in a document, not for transfer size.
  --satori re-shapes labels with real font metrics: it removes every
  <foreignObject>, which is the only way to make labels render outside a
  browser, but its layout is close to rather than identical to a browser's.
`

interface Parsed {
  files: string[]
  out: string | undefined
  options: OptimizeOptions
  stats: boolean
  quiet: boolean
}

class UsageError extends Error {}

function parseArguments(argv: string[]): Parsed | undefined {
  const files: string[] = []
  const options: OptimizeOptions = {}
  const fontFiles: Record<string, string> = {}
  const allowedHosts: string[] = []
  let out: string | undefined
  let stats = false
  let quiet = false

  const next = (index: number, flag: string): string => {
    const value = argv[index + 1]
    if (value === undefined) throw new UsageError(`${flag} needs a value`)
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i]!
    switch (argument) {
      case '-h':
      case '--help':
        return undefined
      case '-o':
      case '--out':
        out = next(i, argument)
        i += 1
        break
      case '--preset': {
        const value = next(i, argument)
        if (value !== 'safe' && value !== 'default' && value !== 'aggressive') {
          throw new UsageError(`unknown preset "${value}"`)
        }
        options.preset = value satisfies Preset
        i += 1
        break
      }
      case '--satori':
        options.satori = true
        break
      case '--no-satori':
        options.satori = false
        break
      case '--fonts': {
        const value = next(i, argument)
        const modes = ['auto', 'webfont', 'system', 'bundled', 'off'] as const
        const mode = modes.find((candidate) => candidate === value)
        if (mode === undefined) throw new UsageError(`unknown font mode "${value}"`)
        options.fontMode = mode
        i += 1
        break
      }
      case '--font': {
        const value = next(i, argument)
        const separator = value.indexOf('=')
        if (separator <= 0) throw new UsageError('--font expects "Family=/path/to/font.ttf"')
        fontFiles[value.slice(0, separator).trim()] = value.slice(separator + 1)
        i += 1
        break
      }
      case '--offline':
        options.offline = true
        break
      case '--font-dir': {
        options.fontDir = next(i, argument)
        i += 1
        break
      }
      case '--font-backend': {
        const value = next(i, argument)
        const backends = ['auto', 'scanner'] as const
        const backend = backends.find((candidate) => candidate === value)
        if (backend === undefined) throw new UsageError(`unknown font backend "${value}"`)
        options.fontBackend = backend
        i += 1
        break
      }
      case '--font-delivery': {
        const value = next(i, argument)
        const modes = ['none', 'inline', 'import'] as const
        const mode = modes.find((candidate) => candidate === value)
        if (mode === undefined) throw new UsageError(`unknown font delivery "${value}"`)
        options.fontDelivery = mode
        i += 1
        break
      }
      case '--allow-host':
        allowedHosts.push(next(i, argument))
        i += 1
        break
      case '--no-sanitize':
        options.sanitize = false
        break
      case '--keep-source':
        options.stripDiagramSource = false
        break
      case '--consolidate-styles':
        options.consolidateStyles = true
        break
      case '--unscoped-classes':
        options.unscopedClasses = true
        break
      case '--no-fold-attrs':
        options.presentationAttributes = false
        break
      case '--keep-classes':
        options.keepClasses = new RegExp(next(i, argument))
        i += 1
        break
      case '--pretty':
        options.pretty = true
        break
      case '--stats':
        stats = true
        break
      case '-q':
      case '--quiet':
        quiet = true
        break
      default:
        if (argument.startsWith('-')) throw new UsageError(`unknown option "${argument}"`)
        files.push(argument)
    }
  }

  if (files.length === 0) throw new UsageError('no input files')
  if (Object.keys(fontFiles).length > 0) options.fontFiles = fontFiles
  if (allowedHosts.length > 0) options.allowedHosts = allowedHosts
  options.stats = stats
  return { files, out, options, stats, quiet }
}

function percent(before: number, after: number): string {
  if (before === 0) return '0%'
  return `${(((before - after) / before) * 100).toFixed(1)}%`
}

function kilobytes(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`
}

/** Group warnings so a document with nineteen identical notes prints one line. */
function summarise(warnings: Warning[]): string[] {
  const groups = new Map<string, { message: string; count: number }>()
  for (const warning of warnings) {
    const group = groups.get(warning.code)
    if (group === undefined) groups.set(warning.code, { message: warning.message, count: 1 })
    else group.count += 1
  }
  return [...groups].map(
    ([code, group]) =>
      `  ${code}${group.count > 1 ? ` (${group.count}x)` : ''}: ${group.message}`,
  )
}

async function main(): Promise<number> {
  let parsed: Parsed | undefined
  try {
    parsed = parseArguments(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 2
  }
  if (parsed === undefined) {
    process.stdout.write(USAGE)
    return 0
  }

  let failures = 0
  for (const file of parsed.files) {
    try {
      const source = await readFile(file, 'utf8')
      const result = await optimizeDrawioSvg(source, parsed.options)
      const target = await outputPath(file, parsed.out, parsed.files.length > 1)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, result.data, 'utf8')

      const { raw, gzip } = result.stats
      process.stdout.write(
        `${file} -> ${target}\n` +
          `  raw  ${kilobytes(raw.before)} -> ${kilobytes(raw.after)}  (${percent(raw.before, raw.after)})\n` +
          `  gzip ${kilobytes(gzip.before)} -> ${kilobytes(gzip.after)}  (${percent(gzip.before, gzip.after)})\n`,
      )

      if (parsed.stats) {
        for (const stage of result.stats.stages) {
          process.stdout.write(
            `    ${stage.name.padEnd(22)} ${kilobytes(stage.raw).padStart(9)} ${kilobytes(stage.gzip).padStart(9)}\n`,
          )
        }
      }

      if (!parsed.quiet && result.warnings.length > 0) {
        process.stdout.write(`${summarise(result.warnings).join('\n')}\n`)
      }
    } catch (error) {
      failures += 1
      process.stderr.write(`${file}: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  return failures === 0 ? 0 : 1
}

process.exitCode = await main()
