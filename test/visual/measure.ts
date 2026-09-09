import { chromium } from 'playwright'
import type { FontFaceRule } from './render.js'
import { svgDocument } from './render.js'

/**
 * Ask the browser where it actually put each line of an HTML label.
 *
 * This is the strongest reference available. draw.io's `<text>` fallback only
 * exists in some exports, is often truncated, and never covers multi-line
 * labels — whereas Chromium laying out the original `<foreignObject>` *is* the
 * thing the conversion is trying to reproduce. Reading its line boxes back gives
 * a per-line ground truth for every label in the document.
 *
 * Positions are returned in the SVG's own user units, so they can be compared
 * directly against the converted `<text>` coordinates.
 */

export interface MeasuredLine {
  text: string
  /** Left edge and baseline-ish top, in SVG user units. */
  left: number
  top: number
  right: number
  bottom: number
}

export async function measureHtmlLines(
  svg: string,
  faces: FontFaceRule[],
): Promise<MeasuredLine[]> {
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext({ deviceScaleFactor: 1 })
    const url = 'https://drawio-svgo.test/diagram.svg'
    const body = svgDocument(svg, faces)
    await context.route('**/*', (route) => {
      if (route.request().url() === url) {
        void route.fulfill({ status: 200, contentType: 'image/svg+xml', body })
        return
      }
      void route.abort()
    })

    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts.ready)

    const lines = await page.evaluate(() => {
      const root = document.querySelector('svg')
      if (root === null) return []
      const origin = root.getBoundingClientRect()

      // Map client pixels back into the SVG's user coordinate system.
      const viewBox = root.getAttribute('viewBox')?.split(/[\s,]+/).map(Number)
      const userWidth = viewBox?.[2] ?? origin.width
      const userHeight = viewBox?.[3] ?? origin.height
      const minX = viewBox?.[0] ?? 0
      const minY = viewBox?.[1] ?? 0
      const scaleX = userWidth / origin.width
      const scaleY = userHeight / origin.height

      const out: Array<{
        text: string
        left: number
        top: number
        right: number
        bottom: number
      }> = []

      for (const host of document.querySelectorAll('foreignObject')) {
        const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node !== null) {
          const value = node.nodeValue ?? ''
          if (value.trim() !== '') {
            const range = document.createRange()
            range.selectNodeContents(node)
            // One rect per line box, which is exactly the granularity we want.
            for (const rect of range.getClientRects()) {
              if (rect.width === 0 && rect.height === 0) continue
              out.push({
                text: value,
                left: (rect.left - origin.left) * scaleX + minX,
                top: (rect.top - origin.top) * scaleY + minY,
                right: (rect.right - origin.left) * scaleX + minX,
                bottom: (rect.bottom - origin.top) * scaleY + minY,
              })
            }
          }
          node = walker.nextNode()
        }
      }
      return out
    })

    await context.close()
    return lines
  } finally {
    await browser.close()
  }
}
