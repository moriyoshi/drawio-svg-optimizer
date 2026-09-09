import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { beforeAll, describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../../src/index.js'
import { protectRegions } from '../../src/core/protect.js'
import { collectFontUsage, parseLabel } from '../../src/html/label.js'
import type { FontRequest } from '../../src/fonts/resolve.js'
import { absoluteTextRuns } from '../geometry.js'
import { fixture, PRETTY_FIXTURES } from '../helpers.js'
import { collectFaces, compare, inkedPixels, render } from './render.js'
import type { FontFaceRule } from './render.js'
import { measureHtmlLines } from './measure.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

const online = await fetch('https://fonts.googleapis.com/css2?family=Arimo')
  .then((response) => response.ok)
  .catch(() => false)

const OUTPUT = fileURLToPath(new URL('./output/', import.meta.url))

/** Every face a document needs, plus the fallback that covers what Latin faces cannot. */
function fontRequests(svg: string): FontRequest[] {
  const { regions } = protectRegions(svg)
  const requests: FontRequest[] = []
  let everything = ''

  for (const region of regions) {
    if (region.kind !== 'subtree') continue
    const label = parseLabel(region.source)
    if (label.root === undefined) continue
    for (const face of collectFontUsage(label.root).values()) {
      if (face.text.trim() === '') continue
      requests.push({ family: face.family, weight: face.weight, style: face.style, text: face.text })
      everything += face.text
    }
  }

  for (const weight of [400, 700]) {
    requests.push({ family: 'Noto Sans JP', weight, style: 'normal', text: everything })
  }
  return requests
}

async function save(name: string, png: PNG): Promise<void> {
  await mkdir(OUTPUT, { recursive: true })
  await writeFile(`${OUTPUT}${name}.png`, PNG.sync.write(png))
}

function normalise(value: string): string {
  return value.replace(/\s+/g, '')
}

/**
 * Per-line horizontal displacement against the browser's own layout.
 *
 * Chromium laying out the original `<foreignObject>` *is* the thing the
 * conversion reproduces, so its line boxes are the reference — a far better one
 * than draw.io's `<text>` fallback, which is often truncated, sometimes absent,
 * and never covers multi-line labels.
 */
async function lineDisplacements(source: string, faces: FontFaceRule[]): Promise<number[]> {
  const truth = await measureHtmlLines(source, faces)
  const optimized = await optimizeDrawioSvg(source, { preset: 'aggressive' })

  // Group converted runs by label and baseline to reconstruct lines.
  const lines = new Map<string, { text: string; left: number }>()
  for (const run of absoluteTextRuns(optimized.data)) {
    const key = `${run.group}@${run.y.toFixed(1)}`
    const line = lines.get(key)
    if (line === undefined) lines.set(key, { text: run.text, left: run.x })
    else {
      line.text += run.text
      line.left = Math.min(line.left, run.x)
    }
  }

  const byText = new Map<string, Array<{ left: number }>>()
  for (const line of truth) {
    const key = normalise(line.text)
    const bucket = byText.get(key) ?? []
    bucket.push(line)
    byText.set(key, bucket)
  }

  const displacements: number[] = []
  for (const line of lines.values()) {
    const candidates = byText.get(normalise(line.text))
    if (candidates === undefined || candidates.length === 0) continue
    // The same string can appear more than once; take the nearest instance.
    const nearest = candidates.reduce((best, candidate) =>
      Math.abs(candidate.left - line.left) < Math.abs(best.left - line.left) ? candidate : best,
    )
    displacements.push(Math.abs(line.left - nearest.left))
  }
  return displacements.toSorted((a, b) => a - b)
}

describe.runIf(online)('rendered output', () => {
  let exampleFaces: FontFaceRule[]
  let fallbackFaces: FontFaceRule[]

  beforeAll(async () => {
    exampleFaces = await collectFaces(fontRequests(EXAMPLE))
    fallbackFaces = await collectFaces(fontRequests(TEXT_FALLBACK))
  }, 120_000)

  it('draws the converted labels rather than leaving the diagram blank', async () => {
    // The cheapest way for a conversion to pass every coordinate check and still
    // be broken is to emit text nobody can see.
    const optimized = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    const shot = await render(optimized.data, exampleFaces)
    expect(inkedPixels(shot.png)).toBeGreaterThan(shot.width * shot.height * 0.01)
  }, 120_000)

  it.each([
    ['example.svg', () => EXAMPLE, () => exampleFaces],
    ['text-fallback.svg', () => TEXT_FALLBACK, () => fallbackFaces],
  ])('puts each line of %s where the browser puts it', async (_name, source, faces) => {
    const displacements = await lineDisplacements(source(), faces())
    expect(displacements.length).toBeGreaterThan(20)

    const median = displacements[Math.floor(displacements.length / 2)]!
    const p90 = displacements[Math.floor(displacements.length * 0.9)]!
    // Measured: median 0.00 / p90 0.37 on example.svg, 0.50 / 1.31 on the other.
    // The residue is the difference between Satori's and Chromium's advance
    // widths for the same face, which is sub-pixel per glyph.
    expect(median).toBeLessThan(1)
    expect(p90).toBeLessThan(2)
    expect(displacements.at(-1)!).toBeLessThan(6)
  }, 180_000)

  it.each([
    ['example.svg', () => EXAMPLE, () => exampleFaces],
    ['text-fallback.svg', () => TEXT_FALLBACK, () => fallbackFaces],
  ])('leaves the shapes of %s pixel-identical', async (name, source, faces) => {
    // With text hidden, nothing should differ at all: any change here is a real
    // geometry change rather than a rasterisation difference.
    const optimized = await optimizeDrawioSvg(source(), { preset: 'aggressive' })
    const result = await compare(source(), optimized.data, faces(), { hideText: true })
    await save(`${name}-shapes-diff`, result.diff)
    expect(result.ratio).toBeLessThan(0.0005)
  }, 180_000)

  it.each([
    ['light', 'light'],
    ['dark', 'dark'],
  ] as const)('renders the whole diagram closely in %s mode', async (scheme, colorScheme) => {
    const optimized = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    const result = await compare(EXAMPLE, optimized.data, exampleFaces, { colorScheme })
    await save(`example-${scheme}-diff`, result.diff)

    // A coarse smoke test only. Chromium rasterises HTML text and SVG text
    // through different antialiasing paths, so identical glyphs at identical
    // coordinates still differ across a few percent of edge pixels — the crops
    // are visually indistinguishable. Position fidelity is asserted above, where
    // it can be measured properly; this catches gross breakage such as missing
    // text, tofu, or a label landing in the wrong place.
    expect(result.ratio).toBeLessThan(0.05)
  }, 180_000)

  it('renders identically whether or not styles were folded into classes', async () => {
    // Consolidation must be a pure byte-level change; nothing about the picture
    // may depend on it.
    const plain = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    const folded = await optimizeDrawioSvg(EXAMPLE, {
      preset: 'aggressive',
      consolidateStyles: true,
    })
    const result = await compare(plain.data, folded.data, exampleFaces)
    expect(result.differing).toBe(0)
  }, 180_000)

  it('renders the same with and without the structural pass', async () => {
    // Guards the half-pixel class of bug: draw.io wraps labels in
    // `translate(-0.5 -0.5)`, and losing it shifts every label while the
    // innermost coordinates still look correct.
    const off = await optimizeDrawioSvg(TEXT_FALLBACK, { preset: 'aggressive', structure: false })
    const on = await optimizeDrawioSvg(TEXT_FALLBACK, { preset: 'aggressive' })
    const result = await compare(off.data, on.data, fallbackFaces)
    await save('structure-diff', result.diff)
    expect(result.ratio).toBeLessThan(0.002)
  }, 180_000)

  it.each(PRETTY_FIXTURES)('puts each line of %s where the browser puts it', async (name) => {
    // Pretty-printed exports with no fallback of any kind: the only route is
    // conversion, and the only reference is the browser's own layout.
    const source = fixture(name)
    const faces = await collectFaces(fontRequests(source))
    const displacements = await lineDisplacements(source, faces)
    expect(displacements.length).toBeGreaterThan(3)

    const median = displacements[Math.floor(displacements.length / 2)]!
    const p90 = displacements[Math.floor(displacements.length * 0.9)]!
    expect(median).toBeLessThan(1)
    expect(p90).toBeLessThan(2)
    // The worst case is a full-width bracket in a Lucida Console code block,
    // where the substitute font is reported as metric-incompatible.
    expect(displacements.at(-1)!).toBeLessThan(12)
  }, 180_000)

  it.each(PRETTY_FIXTURES)('leaves the shapes of %s pixel-identical', async (name) => {
    const source = fixture(name)
    const faces = await collectFaces(fontRequests(source))
    const optimized = await optimizeDrawioSvg(source, { preset: 'aggressive' })
    const result = await compare(source, optimized.data, faces, { hideText: true })
    expect(result.ratio).toBeLessThan(0.0005)
  }, 180_000)

  it('keeps dark mode visibly different from light mode', async () => {
    // Guards the light-dark() restoration: had the conversion flattened the
    // colours, both schemes would render identically.
    const optimized = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    const light = await render(optimized.data, exampleFaces, { colorScheme: 'light' })
    const dark = await render(optimized.data, exampleFaces, { colorScheme: 'dark' })
    expect(inkedPixels(dark.png)).not.toBe(inkedPixels(light.png))
  }, 180_000)
})
