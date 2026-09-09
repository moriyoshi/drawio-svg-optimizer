import { describe, expect, it } from 'vitest'
import { optimizeDrawioSvg } from '../src/index.js'
import { maxBoxDelta, pathBoxes } from './geometry.js'
import { count, fixture, labelText } from './helpers.js'

const EXAMPLE = fixture('example.svg')
const TEXT_FALLBACK = fixture('text-fallback.svg')

describe('structural cleanup', () => {
  it('collapses the group scaffolding draw.io wraps every shape in', async () => {
    // 136 groups for 60 paths before; the wrappers carry nothing once
    // data-cell-id is gone and labels are no longer <switch> scaffolding.
    const before = count(TEXT_FALLBACK, /<g[ >]/g)
    const after = count((await optimizeDrawioSvg(TEXT_FALLBACK, { preset: 'aggressive' })).data, /<g[ >]/g)
    expect(before).toBeGreaterThan(100)
    expect(after).toBeLessThan(before / 3)
  })

  it.each([
    ['example.svg', EXAMPLE],
    ['text-fallback.svg', TEXT_FALLBACK],
  ])('does not move any shape in %s', async (_name, source) => {
    // The pass rewrites path data, collapses groups and can move a group's
    // transform onto the path itself. Comparing resolved absolute boxes is the
    // only way to assert that all of it is geometrically identical.
    const off = await optimizeDrawioSvg(source, { preset: 'aggressive', structure: false })
    const on = await optimizeDrawioSvg(source, {
      preset: 'aggressive',
      structure: true,
      floatPrecision: 5,
    })
    expect(maxBoxDelta(pathBoxes(off.data), pathBoxes(on.data))).toBeLessThan(0.001)
  })

  it('keeps aggressive rounding well inside a pixel', async () => {
    const off = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive', structure: false })
    const on = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive', floatPrecision: 1 })
    const delta = maxBoxDelta(pathBoxes(off.data), pathBoxes(on.data))

    // Not half a precision step: `convertPathData` emits *relative* commands, so
    // each rounded segment adds to the last and the error walks along the path.
    // On this fixture it reaches 0.13px over a multi-segment shape.
    expect(delta).toBeGreaterThan(0.05)
    expect(delta).toBeLessThan(0.5)
  })

  it('rounds to two decimals by default, which barely drifts at all', async () => {
    const off = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive', structure: false })
    const on = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive', floatPrecision: 2 })
    expect(maxBoxDelta(pathBoxes(off.data), pathBoxes(on.data))).toBeLessThan(0.05)
  })

  it('leaves path data byte-for-byte alone under the safe preset', async () => {
    const result = await optimizeDrawioSvg(TEXT_FALLBACK, { preset: 'safe' })
    const original = TEXT_FALLBACK.match(/<path[^>]* d="([^"]*)"/g) ?? []
    const optimized = result.data.match(/<path[^>]* d="([^"]*)"/g) ?? []
    expect(optimized).toEqual(original)
  })

  it('never unwraps a group that carries anything', async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">' +
      '<g><g transform="translate(5,5)"><path d="M 0 0 L 10 10" fill="none" stroke="#000"/></g></g>' +
      '</svg>'
    const result = await optimizeDrawioSvg(svg, { preset: 'aggressive', floatPrecision: 5 })
    expect(maxBoxDelta(pathBoxes(svg), pathBoxes(result.data))).toBeLessThan(0.001)
  })

  it('reports a label that vanished instead of losing it quietly', async () => {
    const result = await optimizeDrawioSvg(EXAMPLE, { preset: 'aggressive' })
    expect(result.warnings.map((warning) => warning.code)).not.toContain('label-lost')
    expect(labelText(EXAMPLE).length).toBeGreaterThan(0)
  })
})
