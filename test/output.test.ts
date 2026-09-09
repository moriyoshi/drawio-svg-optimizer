import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { optimize } from 'svgo'
import { beforeAll, describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../src/index.js'
import { outputPath } from '../src/outputPath.js'
import { fixture } from './helpers.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

/**
 * Assert the output is well-formed XML.
 *
 * SVGO's parser is sax-based and rejects exactly what a strict XML reader
 * rejects — an unescaped `&`, a stray `<`, a mismatched tag — so it doubles as a
 * validity check with no extra dependency, and it is the same parser that would
 * read the file back on a second pass.
 */
function expectWellFormed(svg: string): void {
  expect(() => optimize(svg, { plugins: [] })).not.toThrow()
}

describe('output is well-formed XML', () => {
  const combinations = [
    { name: 'safe', options: { preset: 'safe' } },
    { name: 'default', options: { preset: 'default' } },
    { name: 'aggressive', options: { preset: 'aggressive' } },
    { name: 'aggressive + styles', options: { preset: 'aggressive', consolidateStyles: true } },
    { name: 'aggressive + unscoped', options: { preset: 'aggressive', consolidateStyles: true, unscopedClasses: true } },
    { name: 'pretty', options: { preset: 'aggressive', pretty: true } },
    { name: 'raw text', options: { preset: 'aggressive', compactText: false } },
  ] as const

  it.each(combinations.map((entry) => [entry.name, entry.options] as const))(
    'parses back after %s',
    async (_name, options) => {
      for (const source of [EXAMPLE, TEXT_FALLBACK]) {
        expectWellFormed((await optimizeDrawioSvg(source, options)).data)
      }
    },
  )

  it('never writes a bare ampersand into a <style> body', async () => {
    // No encoding of `&` works in both contexts an SVG is read in: as XML a raw
    // `&` is a parse error, while inline in HTML `<style>` is raw text where
    // `&amp;` would stay literal and corrupt the URL. So the generated CSS must
    // contain no ampersand at all — hence one @import per family.
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    for (const match of result.data.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
      expect(match[1]).not.toContain('&')
    }
  })

  it('emits a separate, individually valid import per family', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      fontDelivery: 'import',
      allowedHosts: ['fonts.googleapis.com'],
    })
    const imports = result.data.match(/@import url\("[^"]*"\);/g) ?? []
    expect(imports.length).toBeGreaterThan(1)
    for (const rule of imports) {
      expect(rule).toMatch(/^@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=[^&"]+"\);$/)
    }
  })
})

describe('--out path resolution', () => {
  let directory: string

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'drawio-svgo-'))
    await mkdir(join(directory, 'existing'))
  })

  it('treats --out as the output file when a single input is given', async () => {
    // Regression: an extensionless path was treated as a directory, so
    // `--out build/diagram` silently produced `build/diagram/example.svg`.
    expect(await outputPath('example.svg', join(directory, 'plainname'), false)).toBe(
      join(directory, 'plainname'),
    )
    expect(await outputPath('example.svg', join(directory, 'out.svg'), false)).toBe(
      join(directory, 'out.svg'),
    )
  })

  it('treats --out as a directory when it demonstrably is one', async () => {
    expect(await outputPath('a/example.svg', join(directory, 'existing'), false)).toBe(
      join(directory, 'existing', 'example.svg'),
    )
    expect(await outputPath('a/example.svg', `${join(directory, 'newdir')}/`, false)).toBe(
      join(directory, 'newdir', 'example.svg'),
    )
  })

  it('always treats --out as a directory for multiple inputs', async () => {
    expect(await outputPath('a/example.svg', join(directory, 'many'), true)).toBe(
      join(directory, 'many', 'example.svg'),
    )
  })

  it('falls back to a .min sibling when --out is omitted', async () => {
    expect(await outputPath('dir/diagram.svg', undefined, false)).toBe('dir/diagram.min.svg')
    expect(await outputPath('dir/diagram', undefined, false)).toBe('dir/diagram.min.svg')
  })
})
