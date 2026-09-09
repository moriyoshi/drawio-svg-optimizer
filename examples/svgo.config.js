// Use this optimizer's passes from the plain `svgo` CLI or Node API.
//
//   npx svgo --config examples/svgo.config.js -i diagram.svg -o diagram.min.svg
//
// This covers everything except converting HTML labels to SVG text, which needs
// to fetch fonts and run Satori — both asynchronous, and `optimize()` is not.
// For that, use the `drawio-svgo` CLI or `optimizeDrawioSvg()` instead.
import { drawioPlugins, drawioJs2Svg } from '@moriyoshi/drawio-svg-optimizer/svgo'

export default {
  plugins: drawioPlugins({
    // Keep the embedded <mxfile> so the SVG stays re-editable in diagrams.net.
    stripDiagramSource: true,
    floatPrecision: 2,
  }),
  // Not settable from a plugin: stops SVGO escaping quotes in text content,
  // which inflates the quote-heavy JSON in draw.io code-block labels.
  js2svg: drawioJs2Svg(),
}
