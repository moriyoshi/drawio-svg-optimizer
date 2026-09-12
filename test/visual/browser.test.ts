import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { absoluteTextRuns } from '../geometry.js'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain JS dev script, deliberately untyped
import { bundleBrowser } from '../../scripts/browser-bundle.mjs'
import { chromium } from 'playwright'
import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import type { Browser } from 'playwright'

/**
 * Run the optimizer in an actual browser.
 *
 * `scripts/check-browser.mjs` proves the entry point *bundles* without Node
 * built-ins, which is a different claim from it working. Only a real engine
 * proves that `CompressionStream` produces a size, that `svgo/browser` behaves
 * like `svgo`, and that no module reaches for something absent at import time
 * rather than at call time.
 *
 * This lives in the visual bucket because it launches Chromium, so `npm test`
 * does not pay for it.
 */
const root = fileURLToPath(new URL('../../', import.meta.url))

/** The shape the page exposes; the real types live on the Node side. */
interface OptimizerModule {
  optimizeDrawioSvg: (
    input: string,
    options: Record<string, unknown>,
  ) => Promise<{
    data: string
    warnings: { code: string }[]
    stats?: { raw: { after: number }; gzip: { after: number } }
  }>
}

let browser: Browser
let origin: string
let close: () => Promise<void>

beforeAll(async () => {
  // Bundled exactly as `npm run check:browser` does, so the thing Chromium
  // loads is the thing that check vouches for.
  const bundle = await bundleBrowser({ minify: true })

  const code = bundle.outputFiles[0]!.text
  const fixture = readFileSync(`${root}test/fixtures/example.svg`, 'utf8')

  // Served rather than loaded from a file: module scripts need an origin.
  //
  // The page imports the bundle itself rather than the specs calling `import()`
  // inside `page.evaluate` — Vitest's transform rewrites a dynamic import in
  // evaluated source into `__vite_ssr_dynamic_import__`, which does not exist
  // in a browser.
  const page = `<!doctype html><title>t</title><script type="module">
    import * as optimizer from '/bundle.js'
    globalThis.__optimizer = optimizer
  </script>`
  const server = createServer((request, response) => {
    if (request.url === '/bundle.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' }).end(code)
    } else {
      response.writeHead(200, { 'content-type': 'text/html' }).end(page)
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  origin = `http://127.0.0.1:${address.port}`

  browser = await chromium.launch()
  close = async () => {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  ;(globalThis as { __fixture?: string }).__fixture = fixture
}, 180_000)

afterAll(async () => {
  await close?.()
})

describe('the optimizer in a browser', () => {
  it('optimizes a real draw.io export, with working gzip stats', async () => {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(origin)

    const fixture = (globalThis as { __fixture?: string }).__fixture!
    await page.waitForFunction(() => '__optimizer' in globalThis)
    const result = await page.evaluate(async (svg: string) => {
      const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
      // `satori: false`: enabling it makes harfbuzzjs fetch `hb.wasm` from the
      // document root, which is a consumer deployment concern rather than
      // something this package can satisfy.
      const output = await optimizer.optimizeDrawioSvg(svg, {
        preset: 'aggressive',
        satori: false,
        stats: true,
      })
      return {
        raw: output.stats!.raw.after,
        gzip: output.stats!.gzip.after,
        // draw.io exports carry an XML declaration, which survives optimization.
        isSvg: /^<\?xml[^>]*\?><svg/.test(output.data.trimStart()),
      }
    }, fixture)

    // A static import of the Satori stage used to fail here: harfbuzzjs fetches
    // `hb.wasm` relative to the document at module-evaluation time, so merely
    // importing the entry point aborted with a WebAssembly CompileError even
    // with `satori: false`. The stage is imported lazily for that reason.
    expect(errors).toEqual([])
    expect(result.isSvg).toBe(true)
    // The headline pass: dropping base64 raster fallbacks is most of the win,
    // and it working here means `svgo/browser` really is a drop-in.
    expect(result.raw).toBeLessThan(fixture.length / 4)
    // `CompressionStream` actually ran. Node reports ~3% lower at level 9.
    expect(result.gzip).toBeGreaterThan(0)
    expect(result.gzip).toBeLessThan(result.raw)

    await page.close()
  }, 180_000)

  it('converts labels to SVG text using the browser’s own layout', async () => {
    // The whole point of the DOM shaping stage: `satori: true` in a browser
    // needs no font bytes, no `hb.wasm`, and nothing that CORS or a `font-src`
    // policy could refuse.
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(origin)
    await page.waitForFunction(() => '__optimizer' in globalThis)

    const result = await page.evaluate(async (svg: string) => {
      const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
      const output = await optimizer.optimizeDrawioSvg(svg, {
        preset: 'aggressive',
        satori: true,
        stats: true,
      })
      return {
        texts: (output.data.match(/<text\b/g) ?? []).length,
        foreignObjects: (output.data.match(/<foreignObject\b/g) ?? []).length,
        transforms: (output.data.match(/translate\(/g) ?? []).length,
        codes: [...new Set(output.warnings.map((warning) => warning.code))],
        raw: output.stats!.raw.after,
      }
    }, (globalThis as { __fixture?: string }).__fixture!)

    expect(errors).toEqual([])
    // Labels became text rather than staying as HTML.
    expect(result.texts).toBeGreaterThan(0)
    expect(result.transforms).toBeGreaterThan(0)
    // And the caller is told the bytes are not available to embed.
    expect(result.codes).toContain('fonts-measured-locally')

    await page.close()
  }, 180_000)

  it('keeps dark mode alive through the conversion', async () => {
    // `normalizeStyle` resolves `light-dark()` to its light half before anything
    // is laid out, because Satori cannot parse the function and both backends
    // share that front half. `getComputedStyle` therefore hands back the light
    // colour, and without putting the pair back every converted label is frozen
    // in light mode — `example.svg` uses `light-dark()` 199 times.
    const fixture = (globalThis as { __fixture?: string }).__fixture!
    const convert = async (colorScheme: 'light' | 'dark'): Promise<string> => {
      const page = await browser.newPage({ colorScheme })
      await page.goto(origin)
      await page.waitForFunction(() => '__optimizer' in globalThis)
      const data = await page.evaluate(async (svg: string) => {
        const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
        const output = await optimizer.optimizeDrawioSvg(svg, {
          preset: 'aggressive',
          satori: true,
        })
        return output.data
      }, fixture)
      await page.close()
      return data
    }

    const light = await convert('light')
    // Painted elements, not the leftover markup: before the pairs were restored
    // there were none of these at all, though the document still carried 41
    // `light-dark()` on shapes the label conversion never touches.
    const painted = light.match(/<(?:text|g)\b[^>]*\bfill="light-dark\([^"]*\)"/g) ?? []
    expect(painted.length).toBeGreaterThan(0)
    // A JSON key's blue, which the export only ever uses inside a label. The
    // authored halves survive verbatim even though the colour was matched on the
    // browser's own serialisation of the light one.
    expect(light).toContain('fill="light-dark(rgb(143, 176, 220), rgb(64, 92, 130))"')
    // And one whose authored form is not how a browser serialises it, so it only
    // matches if the light half was put through the same serialisation first.
    expect(light).toContain('fill="light-dark(#000000, #ffffff)"')

    // The output must not depend on the theme the converting page happened to be
    // in. That is what makes it portable rather than a snapshot of one viewer.
    expect(await convert('dark')).toBe(light)
  }, 180_000)

  it('embeds fonts the caller supplies, measuring with the very same face', async () => {
    // The portability path. Measuring with the browser's fonts and then
    // embedding bytes from somewhere else would be worse than embedding
    // nothing — positions from one face, embedded font another. Registering the
    // supplied bytes first makes the measured and shipped face the same one.
    const candidates = [
      '/System/Library/Fonts/Supplemental/Arial.ttf',
      '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    const path = candidates.find((candidate) => existsSync(candidate))
    if (path === undefined) return

    const bytes = readFileSync(path).toString('base64')
    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(origin)
    await page.waitForFunction(() => '__optimizer' in globalThis)

    const result = await page.evaluate(
      async ([svg, base64]) => {
        const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
        const binary = atob(base64!)
        const data = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) data[i] = binary.charCodeAt(i)

        const output = await optimizer.optimizeDrawioSvg(svg!, {
          preset: 'aggressive',
          satori: true,
          fontDelivery: 'inline',
          fontFiles: { Helvetica: data, 'Noto Sans JP': data },
        })
        return {
          fontFaces: (output.data.match(/@font-face/g) ?? []).length,
          embedsBase64: /src:url\(data:font\/ttf;base64,/.test(output.data),
          texts: (output.data.match(/<text\b/g) ?? []).length,
          codes: [...new Set(output.warnings.map((warning) => warning.code))],
        }
      },
      [(globalThis as { __fixture?: string }).__fixture!, bytes],
    )

    expect(errors).toEqual([])
    expect(result.texts).toBeGreaterThan(0)
    expect(result.fontFaces).toBeGreaterThan(0)
    expect(result.embedsBase64).toBe(true)
    // Bytes were available, so the "nothing to embed" warning must not fire.
    expect(result.codes).not.toContain('fonts-measured-locally')

    await page.close()
  }, 180_000)

  it('splits a wrapped line into runs that reassemble to the original text', async () => {
    // `toVdom` pre-splits on `<br>` and block boundaries, so every label in the
    // fixtures gives one rect per text node — which means the wrapping path in
    // `measureRuns` had never executed. A narrow box with long text is the only
    // way to reach it, and reassembling the runs is what proves the slicing is
    // right rather than merely plausible.
    const label =
      '<foreignObject style="overflow: visible; text-align: left;" pointer-events="none"' +
      ' width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: unsafe center;' +
      ' justify-content: unsafe center; width: 90px; height: 1px; padding-top: 40px; margin-left: 20px;">' +
      '<div style="box-sizing: border-box; font-size: 0; text-align: center; color: #000000;">' +
      '<div style="display: inline-block; font-size: 12px; font-family: Helvetica;' +
      ' line-height: 1.2; white-space: normal; word-wrap: normal;">' +
      'alpha beta gamma delta epsilon zeta eta theta</div></div></div></foreignObject>'
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">' +
      `<switch>${label}<text x="0" y="0">fallback</text></switch></svg>`

    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(origin)
    await page.waitForFunction(() => '__optimizer' in globalThis)

    const result = await page.evaluate(async (input: string) => {
      const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
      const output = await optimizer.optimizeDrawioSvg(input, {
        preset: 'aggressive',
        satori: true,
        compactText: false,
      })
      const texts = [...output.data.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]!)
      const ys = [...output.data.matchAll(/<text[^>]*\by="([-\d.]+)"/g)].map((m) => Number(m[1]))
      return { texts, lines: new Set(ys).size, data: output.data.slice(0, 0) }
    }, svg)

    expect(errors).toEqual([])
    // It really did wrap, so the path under test really did run.
    expect(result.lines).toBeGreaterThan(1)
    // Every character survives, in order, with no duplication or loss.
    const reassembled = result.texts.join(' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
    expect(reassembled).toBe('alpha beta gamma delta epsilon zeta eta theta')

    await page.close()
  }, 180_000)

  it('keeps the indentation of a white-space: pre code block', async () => {
    // draw.io writes a code block's indentation as its own `<span>`, so
    // `toVdom` gives it a run — and therefore a flex item — of its own. Flexbox
    // does not render an anonymous flex item that is nothing but whitespace,
    // even under `white-space: pre`, so the browser collapsed every one of them
    // to zero width and each nested line of a JSON block came out flush against
    // the margin. Satori has no such rule, which is why only this backend was
    // wrong. The Node equivalent is in `test/pretty.test.ts`.
    const code =
      '<span style="font-family: monospace; white-space: pre;">{<br/>      </span>' +
      '<span style="font-family: monospace; white-space: pre; color: #8fb0dc;">"jisx0402"</span>'
    const label =
      '<foreignObject style="overflow: visible;" pointer-events="none" width="100%" height="100%">' +
      '<div xmlns="http://www.w3.org/1999/xhtml" style="display: flex; align-items: unsafe center;' +
      ' justify-content: unsafe center; width: 1px; height: 1px; padding-top: 40px; margin-left: 60px;">' +
      '<div style="box-sizing: border-box; font-size: 0; text-align: left;">' +
      '<div style="display: inline-block; font-size: 12px; font-family: monospace;' +
      ` line-height: 1.2; white-space: nowrap;">${code}</div></div></div></foreignObject>`
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200">' +
      `<switch>${label}<text x="0" y="0">fallback</text></switch></svg>`

    const page = await browser.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(String(error)))
    await page.goto(origin)
    await page.waitForFunction(() => '__optimizer' in globalThis)

    const data = await page.evaluate(async (input: string) => {
      const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
      const output = await optimizer.optimizeDrawioSvg(input, { preset: 'aggressive', satori: true })
      return output.data
    }, svg)
    await page.close()

    expect(errors).toEqual([])
    const runs = absoluteTextRuns(data)
    const brace = runs.find((run) => run.text.includes('{'))
    const key = runs.find((run) => run.text.includes('jisx0402'))
    expect(brace).toBeDefined()
    expect(key).toBeDefined()

    // Six spaces of monospace at 12px is roughly 43px, and was 0 before.
    const indent = key!.x - brace!.x
    expect(indent).toBeGreaterThan(20)

    // And the characters are the label's own, not a non-breaking stand-in.
    expect(data).not.toContain('\u00a0')
  }, 180_000)

  it('places text where draw.io placed its own', async () => {
    // Agreeing with Satori to 0.2px is two implementations agreeing, which is
    // not the same as being right. draw.io's own `<text>` fallback is the only
    // ground truth for what these labels should look like, and it is what the
    // Node path is held to — so the browser path is held to it identically.
    const fallback = readFileSync(`${root}test/fixtures/text-fallback.svg`, 'utf8')

    const truth = new Map<string, { x: number; y: number; anchor: string }>()
    for (const run of absoluteTextRuns(fallback)) {
      const found = new RegExp(
        `<text[^>]*>${run.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</text>`,
      ).exec(fallback)
      const anchor = /text-anchor="(\w+)"/.exec(found?.[0] ?? '')?.[1] ?? 'start'
      truth.set(run.text, { x: run.x, y: run.y, anchor })
    }

    const page = await browser.newPage()
    await page.goto(origin)
    await page.waitForFunction(() => '__optimizer' in globalThis)
    const data = await page.evaluate(async (svg: string) => {
      const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
      // Raw output keeps the per-run `width`, which makes the geometry measurable.
      const output = await optimizer.optimizeDrawioSvg(svg, {
        preset: 'aggressive',
        satori: true,
        compactText: false,
      })
      return output.data
    }, fallback)
    await page.close()

    const lines = new Map<string, Array<{ text: string; x: number; width: number }>>()
    for (const run of absoluteTextRuns(data)) {
      const key = `${run.group}@${run.y.toFixed(2)}`
      const line = lines.get(key) ?? []
      line.push({ text: run.text, x: run.x, width: run.width })
      lines.set(key, line)
    }

    let compared = 0
    const deltas: Array<{ text: string; dx: number; dy: number; anchor: string }> = []
    for (const [key, runs] of lines) {
      const sorted = runs.toSorted((a, b) => a.x - b.x)
      const expected = truth.get(sorted.map((run) => run.text).join(''))
      if (expected === undefined) continue

      const left = sorted[0]!.x
      const right = Math.max(...sorted.map((run) => run.x + run.width))
      const got =
        expected.anchor === 'middle' ? (left + right) / 2 : expected.anchor === 'end' ? right : left

      deltas.push({
        text: sorted.map((r) => r.text).join('').slice(0, 24),
        dx: +Math.abs(got - expected.x).toFixed(2),
        dy: +Math.abs(Number(key.split('@')[1]) - expected.y).toFixed(2),
        anchor: expected.anchor,
      })
      compared += 1
    }
    expect(compared).toBeGreaterThan(10)

    // Tighter horizontally than vertically, and looser than the Node path's 1px
    // — deliberately, and not because the browser is sloppier. The Node spec
    // fetches Arimo, which is metric-compatible with the Helvetica draw.io
    // measured; the browser measures *actual* Helvetica. Two different faces,
    // each placed correctly for itself, land up to 1.5px apart vertically.
    // Measured on the reference export: max dx 0.5, max dy 1.5.
    for (const delta of deltas) {
      expect(delta.dx).toBeLessThan(1)
      expect(delta.dy).toBeLessThan(2)
    }
  }, 180_000)

  it('reports rather than throws when a font source cannot work', async () => {
    const page = await browser.newPage()
    await page.goto(origin)

    await page.waitForFunction(() => '__optimizer' in globalThis)
    const codes = await page.evaluate(async (svg: string) => {
      const optimizer = (globalThis as unknown as { __optimizer: OptimizerModule }).__optimizer
      // A path is unreadable without a filesystem, and the bundled tier does not
      // exist at all. Both must degrade to warnings rather than throwing.
      const output = await optimizer.optimizeDrawioSvg(svg, {
        preset: 'aggressive',
        satori: false,
        fontMode: 'bundled',
        fontFiles: { Helvetica: '/nonexistent/Arial.ttf' },
      })
      return output.warnings.map((warning) => warning.code)
    }, (globalThis as { __fixture?: string }).__fixture!)

    expect(Array.isArray(codes)).toBe(true)
    await page.close()
  }, 180_000)
})
