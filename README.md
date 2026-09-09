# drawio-svg-optimizer

[![CI](https://github.com/moriyoshi/drawio-svg-optimizer/actions/workflows/ci.yml/badge.svg)](https://github.com/moriyoshi/drawio-svg-optimizer/actions/workflows/ci.yml)

Optimize SVGs exported from [diagrams.net](https://www.drawio.com) (draw.io).

```bash
npx @moriyoshi/drawio-svg-optimizer diagram.svg -o diagram.min.svg

# also convert HTML labels to SVG text
npx @moriyoshi/drawio-svg-optimizer --preset aggressive --stats diagram.svg
```

Needs Node 20+. `drawio-svgo` is a shorter alias for the same command.

## Results

Bytes, raw / gzip:

| | `example.svg` | `text-fallback.svg` |
| --- | ---: | ---: |
| original | 515,741 / 353,959 | 49,109 / 6,017 |
| `--preset safe` | 46,023 / 4,092 | 35,869 / 5,679 |
| `--preset default` | 43,253 / 3,507 | 31,059 / 2,974 |
| `--preset aggressive` | **22,101 / 2,855** | **22,658 / 2,602** |
| ↳ `--consolidate-styles` | 13,125 / 2,855 | 12,971 / 2,707 |
| aggressive vs original | −95.7% raw, −99.2% gzip | −53.9% raw, −56.8% gzip |

The two fixtures are real exports in the two modes draw.io produces, and the
difference between them drives most of the design.

## Installing

The package is published to GitHub Packages rather than the public npm registry,
so the `@moriyoshi` scope has to be pointed at `npm.pkg.github.com`. GitHub
Packages requires a token even for public packages; any PAT with `read:packages`
works. In `.npmrc`:

```ini
@moriyoshi:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then `npm install @moriyoshi/drawio-svg-optimizer`. Inside GitHub Actions,
`secrets.GITHUB_TOKEN` is enough.

From a checkout:

```bash
npm install        # builds dist/ via `prepare`
node dist/cli.js --help
```

## What it does

**Drops rasterised label fallbacks.** When draw.io cannot guarantee the fallback
font will render (notably for CJK text) it rasterises the label and embeds it as
a base64 PNG inside the `<switch>`. On `example.svg` those 19 images are 469,716
of 515,741 bytes: 91% of the file, and nearly all of the achievable gzip win,
since base64 PNG is already-compressed data. `<image>` anywhere else is real
diagram content and is never touched, and a linked (non-`data:`) fallback is
kept.

**Collapses `<switch>` onto draw.io's own `<text>`.** Where the export carries a
faithful `<text>` fallback, the HTML branch is dropped and the text hoisted at
its existing positions. Text equivalence is checked first, because draw.io
truncates the fallback with an ellipsis when a label overflows its shape
(`AWS Firehose Sink` → `AWS Firehose S...`); collapsing onto a truncated
fallback would corrupt six labels in `text-fallback.svg`.

**Strips editor bookkeeping.** `data-cell-id` (29 in `example.svg`; not `id`
attributes, so SVGO's `cleanupIds` cannot see them), empty `<style/>`, the
redundant transparent-background declaration. `color-scheme: light dark` is kept,
since it is what makes `light-dark()` resolve. `content="<mxfile>…"` is removed
outside `--preset safe`; that is what makes an SVG re-editable in diagrams.net,
so it is a one-way door.

**Cleans up ids.** Referenced ids are collected from `url()`, `href`, ARIA
attributes, animation timing and CSS. `example.svg` has exactly one id, and it is
referenced only from an `@supports` rule driving the adaptive background.

**Converts HTML labels to SVG text** (`--satori`, on under `aggressive`). The
only way to remove a `foreignObject` from an export with no `<text>` fallback,
and the only way to make those labels render outside a browser.

**Collapses group scaffolding.** draw.io wraps every shape in several empty
groups (`<g><g data-cell-id="…"><g transform="translate(-0.5 -0.5)">`): 106 and
136 groups for 27 and 60 paths in the two fixtures, down to 31 and 30. Path data
is tidied at the same time. The tests resolve every path's absolute bounding box
through its transforms and require an exact match (0.0000 delta on both
fixtures). `mergePaths` is deliberately unused; it is unsafe across the differing
strokes and fill-rules draw.io shapes have.

**Folds repeated styling into classes** (`--consolidate-styles`, off by
default). Both `style` attributes and `fill`/`stroke`/font presentation
attributes are folded; the attributes are the larger half once labels are SVG
text (7.2 KB of the 9 KB saved on `example.svg`). Class names no rule defines are
dropped separately, on by default.

## Usage

```
drawio-svgo [options] <file.svg...>

  -o, --out <path>       Output file (single input), or directory
      --preset <name>    safe | default | aggressive            (default: default)
      --satori           Convert HTML labels to SVG text        (default: aggressive only)
      --fonts <mode>     auto | webfont | system | bundled | off  (default: auto)
      --font <F=path>    Use this font file for family F        (repeatable)
      --font-dir <path>  Directory the bundled font tier reads
      --font-backend <b> auto | scanner   Where installed fonts come from
      --font-delivery <m>  none | inline | import               (default: none)
      --offline          Never fetch webfonts
      --allow-host <h>   Permit references to this host         (repeatable)
      --no-sanitize      Keep script, external references and the DOCTYPE
      --keep-source      Keep the embedded <mxfile>
      --consolidate-styles  Fold repeated inline styles into CSS classes
      --unscoped-classes    Short global class names (standalone files only)
      --keep-classes <re>   Keep class names matching this pattern
      --no-fold-attrs       Fold only style="", not fill=/stroke= attributes
      --pretty           Pretty-print the output
      --stats            Report raw and gzip bytes per stage
  -q, --quiet            Suppress warnings
```

```ts
import { optimizeDrawioSvg } from '@moriyoshi/drawio-svg-optimizer'

const { data, stats, warnings } = await optimizeDrawioSvg(svg, {
  preset: 'aggressive',
  stats: true,
})
```

`--stats` reports raw and gzip because they disagree sharply. Folding repeated
styling into classes cuts raw bytes by 41–43% on aggressive output but leaves the
gzipped file unchanged or slightly larger: gzip already dedupes those repeated
strings, and class attributes add entropy in their place. Hence
`--consolidate-styles` is off by default; turn it on for files kept in a
repository, embedded in a document, or opened in an editor, and leave it off for
transfer size over a compressing server.

Stray-class removal is conservative: an unreferenced class is not provably dead,
only unused in this file, so `--keep-classes <regexp>` exists for names external
CSS or scripts rely on.

## Fonts

Resolution runs config → bundled → system → webfont, and only substitutes once
the real family is unavailable.

Arimo, Tinos and Cousine are metric-compatible with Helvetica/Arial, Times and
Courier, so text lands unchanged. They are fetched as webfonts; no font files are
bundled. To serve them locally, put `.ttf` files named `<Family>-Regular.ttf` /
`<Family>-Bold.ttf` in a directory and point `--font-dir` (or `fontDir`) at it;
that is what the `bundled` tier reads. Without it the tier looks for a `fonts/`
directory beside the package, which is rarely writable once installed.
`--fonts bundled --font-dir ./fonts` gives byte-reproducible output in CI.

Where no metric-compatible match exists (nothing free matches `Lucida Console`,
so Cousine shifts every glyph in those code blocks) a `font-substituted-metrics`
warning says so.

Webfont downloads use Google's `text=` parameter to subset to exactly the
characters used — 17 KB rather than a multi-megabyte CJK face — and are cached
under `$XDG_CACHE_HOME/drawio-svg-optimizer/fonts`. `--offline` never touches the
network and falls back to system fonts; a label whose font cannot be resolved is
left as HTML rather than rendered as tofu.

### The system tier

Installed fonts are read from the platform's font registry: CoreText on macOS,
DirectWrite on Windows, fontconfig on Linux, reached through `koffi`. That
replaces an `fc-match` subprocess which only ever worked on Linux.

`koffi` is an optional dependency. Where it is absent (an unlisted platform,
`--no-optional`, a pruned lockfile) the tier falls back to walking the font
directories with `font-finder`, a hard dependency. `--font-backend scanner` or
`fontBackend: 'scanner'` declines the native path deliberately.

The difference is fidelity, not availability. On a stock Mac the registry reports
246 families where a recursive directory scan finds 194, because Helvetica,
Helvetica Neue, Hiragino and PingFang ship inside `.ttc` collections a
filename-keyed scan cannot describe. A scan also cannot see fonts deactivated in
Font Book, or ones activated from elsewhere by a font manager. Both tiers unpack
collections, so those families resolve either way.

Neither tier substitutes: a family that is not installed comes back empty, and
choosing a stand-in stays with the resolver, where it is reported.

The tiers are tried in order and each result decides whether the next is needed,
so those `await`s are sequential by design; parallelising them would fire
redundant requests and defeat the cache. That is why `no-await-in-loop` is off in
`.oxlintrc.json`.

## In a browser

```js
import { optimizeDrawioSvg } from '@moriyoshi/drawio-svg-optimizer'   // resolves to the browser build
```

The `browser` export condition selects a build with no Node built-ins in it.
`npm run check:browser` fails the release if one creeps back, and a headless
Chromium spec runs the real thing.

Labels are shaped by the browser rather than by Satori: the browser build renders
each label into a hidden node and reads back the geometry the engine produced.
Measured against the Node path on the reference export, the two agree to 0.2 px
vertically and about 0.7 px horizontally, the horizontal difference being
harfbuzz and the browser disagreeing on advance widths.

That has three consequences:

- No font is ever fetched or parsed, so there is nothing for CORS or a
  `font-src` policy to refuse. It also sidesteps a format problem the Node path
  has: the Google Fonts CSS API answers a real browser with WOFF2, which
  `@shuding/opentype.js` cannot read.
- Satori is not in the bundle. It, harfbuzz, yoga and opentype.js account for
  most of the difference between 2187 KB and 1200 KB.
- There are no font bytes to embed unless you supply them; output says so with a
  `fonts-measured-locally` warning.

To make the output portable, pass the bytes:

```js
await optimizeDrawioSvg(svg, {
  satori: true,
  fontDelivery: 'inline',
  fontFiles: { Helvetica: helveticaBytes },   // Uint8Array, not a path
})
```

Supplied fonts are registered with `document.fonts` before measuring, so the face
that is measured and the face that is embedded are the same one.

Reported gzip sizes read about 3% high, because `CompressionStream` is zlib level
6 where Node uses level 9. The font resolution tiers do not run in the browser at
all.

### Choosing which fonts to load

Because the browser build measures whatever the page has loaded, output is
deterministic only if the page decides what that is.
`@moriyoshi/drawio-svg-optimizer/fonts` exports the tables that decision needs,
with no Node dependencies:

```js
import {
  repairFamily,        // normalises a family name (whitespace only)
  substituteFamily,    // -> { family, metricCompatible }
  needsWideCoverage,   // true when no Latin substitute will do
  fallbackFamilyFor,   // a Noto family for a run of characters, by script
  familiesDeclaredIn,  // families the document itself names
} from '@moriyoshi/drawio-svg-optimizer/fonts'
```

`substituteFamily` reports `metricCompatible` because the distinction decides
whether text moves; see [Fonts](#fonts).

### Bundler configuration

The `browser` field object map must be honoured, not just the `browser` export
condition. The condition picks the entry point; the field map is what swaps
`svgo` for `svgo/browser`, the Node gzip for `CompressionStream`, and the Satori
stage for the DOM one. A bundler that reads the condition and ignores the field
pulls in `node:zlib` and the whole of Satori. webpack, Vite, Rollup with
`@rollup/plugin-node-resolve`, esbuild with `--platform=browser` and Parcel all
honour both.

No `fs` stub is required. Earlier versions needed one because `harfbuzzjs`,
reached through `satori`, has an unconditional `require("fs")` in a dead
`if (ENVIRONMENT_IS_NODE)` branch; the DOM stage removed satori, harfbuzz and
yoga from the browser graph entirely.

## Warnings

Nothing here fails loudly: an unconvertible label, an unreadable font or a
blocked request is reported and the document is returned intact. Every warning
carries a stable `code`.

| Code | Means |
| --- | --- |
| `label-lost` | A label disappeared during optimization and could not be restored. Content loss; the one code that always warrants investigation. |
| `fallback-mismatch` | A `<switch>` fallback did not match the label it replaced. |
| `label-kept-as-html` | A label could not be converted and was left as `<foreignObject>`. Larger output, not lost content. |
| `satori-skipped` | The conversion stage was skipped entirely. |
| `font-name-repaired` | A family name was normalised before resolution. |
| `font-substituted` | A metric-compatible stand-in was used; text does not move. |
| `font-substituted-metrics` | A stand-in was used whose advance widths differ, so text shifts. |
| `font-unavailable` | No font could be found for a family; its labels stay as HTML. |
| `font-coverage-missing` | A family needs non-Latin coverage that no substitute provides. |
| `font-config-unreadable` | A `fontFiles` entry could not be read. |
| `fonts-not-supplied` | Converted text names fonts the file does not embed, and embedding was possible. |
| `fonts-measured-locally` | Browser only: text was shaped with the page's own fonts, so there are no bytes to embed. |
| `fonts-embedded` | Font subsets were inlined as `@font-face`. |
| `font-import-added`, `font-import-rewritten` | A webfont `@import` was written or corrected. |
| `font-import-blocked` | An `@import` was refused because no host is allowed by the policy. |
| `raster-fallback-kept` | A base64 raster fallback was left in place. |
| `diagram-source-removed` | The embedded `<mxfile>` was stripped, so the file is no longer re-editable. |
| `stray-classes-removed`, `styles-consolidated` | Class and style bookkeeping. |
| `attribute-removed`, `element-removed`, `doctype-removed`, `css-declaration-removed`, `css-import-removed`, `css-url-removed`, `dangerous-reference-removed`, `external-reference-removed`, `external-stylesheet-removed` | Removed by the sanitizer; see [Security](#security). |

`label-lost` and `fallback-mismatch` mean something went wrong. The rest are a
record of what was done.

## Security

These files usually come from someone else, so input is sanitized by default.
Two separate things are being prevented:

- At processing time, a document must not make this tool fetch anything. SVGO's
  parser rejects external entities outright rather than resolving them (pinned by
  a test, since a regression there would turn every optimization into a
  server-side request), and the only network access, font resolution, is
  restricted to a host allowlist no document can influence.
- At render time, the output must not make a viewer's browser fetch anything. A
  remote `<image>`, a webfont, an `@import` or a `<use>` into another document
  leaks the viewer's IP, user agent and referrer to whoever authored the diagram.

| Layer | Removed |
| --- | --- |
| XML | `DOCTYPE` (entity declarations, external DTD), `<?xml-stylesheet?>`, XInclude |
| SVG | `<script>`, `on*` handlers, external `<use>`/`<image>`/`href`, `javascript:` and `vbscript:`, SMIL (`<set>`/`<animate>` can retarget an attribute), `<feImage>`, `<iframe>`/`<object>`/`<embed>`/`<link>`/`<meta>`/media elements |
| CSS | `@import` in all four spellings, `url()` anywhere including inside `@supports`/`@font-face`, `behavior`, `-moz-binding`, `expression()` |

Kept: same-document fragments (`url(#gradient)`, `<use href="#id">`) and `data:`
URIs, which are how a self-contained SVG refers to itself. `data:image/svg+xml`
and `data:text/html` are not kept; those are documents rather than pictures, and
nesting one hides script and external references inside something inert-looking.

Matching is on the element's local name, so `<svg:script>` and `<xi:include>` are
caught. Scheme detection strips entities and control characters first, so
`&#106;avascript:` and `java\tscript:` classify as `javascript:`.

`--allow-host <host>` permits a specific host (subdomains included);
`--no-sanitize` turns sanitizing off.

### Fonts in the output

Writing an `@import` for the families the converter shaped with is an
unauthorized external reference under the strict policy, so `--font-delivery`
decides, and defaults to emitting nothing:

| Mode | `pretty-large.svg` | Network at render time |
| --- | ---: | --- |
| `none` *(default)* | 20,235 / 2,706 gzip | none |
| `import` | 20,478 / 2,776 | fetches the families; needs `--allow-host fonts.googleapis.com` |
| `inline` | 59,468 / 25,417 | none; embeds the subsets as `data:` URIs |

`none` degrades gracefully: every run is absolutely positioned, so a viewer
lacking the font gets different glyph advances within a line but each line still
starts in the right place, and a `fonts-not-supplied` warning names the families.
`inline` is the choice when the file must be exactly right and self-contained, at
roughly three times the size.

## Using it as SVGO plugins

Most of this works as ordinary `svgo` plugins, so it can run from a plain
`svgo.config.js`:

```js
import { drawioPlugins, drawioJs2Svg } from '@moriyoshi/drawio-svg-optimizer/svgo'

export default {
  plugins: drawioPlugins(),
  js2svg: drawioJs2Svg(),
}
```

```bash
npx svgo --config svgo.config.js -i diagram.svg -o diagram.min.svg
```

That covers dropping raster fallbacks, collapsing `<switch>` onto a faithful
`<text>`, stripping editor bookkeeping, and the structural pass, verified through
the real SVGO API to be geometrically lossless (0.0000 bbox delta) and to keep
label text byte-identical. A worked config lives in
[`examples/svgo.config.js`](examples/svgo.config.js).

Two things do not fit the plugin model:

- Label conversion cannot be a plugin. Fetching fonts and running Satori are
  asynchronous and `optimize()` is synchronous: an `async` visitor runs, but SVGO
  never awaits it, so the mutations land after the tree has been stringified and
  are discarded. Use `optimizeDrawioSvg()` or the CLI instead.
- Two fixes happen outside the plugin list. `drawioPlugins()` calls
  `patchTextElements()`, which adds `div`/`span` to SVGO's `textElems` set so the
  parser stops trimming label whitespace, damage that happens during parsing
  before any plugin runs. And `drawioJs2Svg()` supplies a `js2svg` setting a
  plugin cannot reach, stopping quotes in text content being escaped. Both are
  exported so the behaviour is visible in the config rather than hidden.
  `patchTextElements()` mutates SVGO's module state; it is additive and
  idempotent, but it is a monkey-patch.

## Implementation notes

Non-obvious constraints, each covered by a test.

**SVGO cannot round-trip these files.** Its parser calls `.trim()` on text in any
element outside its `textElems` set (`lib/parser.js:173`). `div` and `span` are
not in that set, so a no-op `optimize()` on `example.svg` destroys 159 spaces and
10 ideographic spaces (U+3000): the indentation of `white-space: pre` code blocks
and the spacing of Japanese labels, before any plugin runs. Separately, the
stringifier escapes `[&'"<>]` in every text node, turning `@import url("…")` into
`url(&quot;…&quot;)`, which breaks when the SVG is inlined into an HTML page
(`<style>` is raw text there). Neither is configurable, so `foreignObject`
subtrees and `<style>` text are withheld from SVGO and spliced back afterwards.

**Satori is used for shaping, not placement.** draw.io's label scaffold is a
degenerate flex box (`width: 628px; height: 1px; padding-top: 72px; margin-left:
221px; align-items: unsafe center`) meaning "centre this on (221 + 628/2, 72)".
Yoga does not reproduce a browser's handling of a 1px-high box with an
overflowing child: feeding it the scaffold verbatim yields the right `y` but
ignores `justify-content`, while removing the height fixes `x` and breaks `y`. So
the scaffold is stripped, the text is shaped in a clean box, and the offset is
computed as plain CSS box alignment. Accuracy against draw.io's own `<text>`
coordinates lands within 1px on both axes across 16 labels.

**Fonts are verified, not assumed.** Google Fonts answers a plain request for a
CJK family with a Latin-only subset: 34 KB that covers `A` but not one kana, which
would render the label as tofu. Every font is checked with
`@shuding/opentype.js`, the same parser Satori uses.

**Pretty-printed exports differ in three ways.** The indentation inside label
markup is whitespace CSS collapses, so rendering it verbatim shifts every label
right by its own indent. U+3000 is not in the CSS white-space set and must
survive that collapsing, which rules out a plain `\s` regex. And htmlparser2
reports every decoded character reference as its own text event, so an export
writing its Japanese as `&#x30B5;` arrives as one text node per character, which
would become one `<span>` per character: unable to wrap, shaped without kerning.

**SVG strips whitespace from `<text>` too.** With the default
`xml:space="default"` a renderer removes leading and trailing spaces and
collapses internal runs, so `<text x="0">    {</text>` draws `{` flush at x=0.
Runs that need it carry `xml:space="preserve"`. Only U+0020, tab, CR and LF are
affected, which is why the ideographic indents of Japanese labels never showed
this. Whitespace-only runs that cannot merge into a neighbour are dropped: they
draw no ink, and the following run's absolute position already expresses the gap.

**Labels wrap where the browser wraps them.** CJK breaks between almost any two
characters, so a 58px box holding 84px of Japanese becomes two lines. Forcing
`white-space: pre` on runs to protect their spacing disabled that; spacing is
preserved by following the CSS collapsing rules instead, and only genuinely `pre`
runs are marked as such.

**Font fallback is per character.** draw.io writes whatever family the shape
style names, even when the label is in a script that family has never covered:
the reference export sets Japanese in `Helvetica` and puts `東京都` inside a
`Lucida Console` code block. A browser resolves this through the system fallback
chain, so text is attributed to the face that actually renders it (following CSS
inheritance), and any gap is covered by an extra face, trying the families the
document declares before a script default.

**Dark mode survives.** Satori cannot parse `light-dark()`, so those colours are
resolved to their light half for shaping and rewritten back into pairs
afterwards. `example.svg` uses `light-dark()` 199 times.

**The output names fonts that exist.** An export's own `@import` names the
families the document asked for, which is not the set the converted text ends up
naming: a family that could not be obtained has been substituted, and one
resolved from a local file needs no import. Since every run is positioned using
the metrics of the face it was shaped with, a viewer loading the wrong set sees
visibly misaligned text. Converted text therefore names the resolved family, and
the import is rewritten to load exactly those. A family that resolves to nothing
gets no substitute if it needs non-Latin coverage; that label stays as HTML.

**The generated CSS contains no ampersand.** A `<style>` body has no encoding
that works in both contexts an SVG is read in: as XML a raw `&` is a parse error
and must be `&amp;`, while as inline SVG in an HTML page `<style>` is a raw-text
element where `&amp;` stays literal and corrupts the URL. So the webfont import
is emitted as one `@import` per family rather than the `&family=` form, and
`display=swap` is dropped for the same reason. Every preset combination is
checked to parse back as XML.

**Folding presentation attributes preserves the cascade.** A presentation
attribute is the weakest thing in the author origin, weaker than any selector,
while an inline `style` is the strongest. Turning both into equal-specificity
classes preserves that order only if the presentation-derived rules are emitted
first, so a style-derived rule still wins on document order. The tests assert the
fully resolved cascade is unchanged rather than merely that the bytes shrank.

Units matter here too: `font-size="12"` means twelve user units as an attribute,
but `font-size: 12` is invalid CSS and is dropped, rendering the text at the
inherited default. Length properties get an explicit `px`; `stroke-miterlimit`,
`font-weight` and the opacities, which take bare numbers in CSS, do not.

**A lost label is reported.** Placeholders stand in for label markup while SVGO
runs, and a pass that removes one legitimately (collapsing a label onto its
`<text>` fallback) says so. Any other disappearance is content loss and is raised
as `label-lost`.

## Upstream alternative

For diagrams you author yourself,
[`simpleLabels`](https://www.drawio.com/docs/reference/configure-diagram-editor/)
and [Convert labels to SVG](https://www.drawio.com/docs/manual/text/svg-labels/)
(`convertToSvg`, 28.0.3+) make draw.io emit native `<text>` at export time, which
is cheaper and more faithful than converting afterwards. Both are opt-in per cell
at authoring time, so they do nothing for exports you receive from others, which
is what this tool is for.

## Development

```bash
npm run build         # tsc
npm run typecheck
npm run lint          # oxlint
npm test              # vitest
npm run test:visual   # Playwright; needs `npx playwright install chromium`
```

Network-dependent tests skip themselves when offline.

`npm run test:visual` renders both the original and the optimized SVG in Chromium
and compares them. Three details make the comparison mean something:

- Both sides render as a standalone `.svg`. A draw.io export whose labels are
  `<foreignObject>` renders differently when pasted into an HTML page: on
  `pretty-large.svg` the inline rendering loses more than half its ink, because
  the label boxes are `width="100%" height="100%"` and paint over the shapes
  beneath. An earlier version of this harness inlined the SVG and scored a
  faithful conversion as an 18% regression.
- Both sides get the same fonts. The reference exports name `Noto Sans JP`,
  `Helvetica` and `Lucida Console`, none of which exist on a typical Linux box,
  so rendering as-is would compare Chromium's font fallback rather than the
  conversion. The harness supplies the exact faces the converter shaped with via
  `@font-face`, aliased onto the names the document writes.
- Position is measured, not eyeballed. Chromium laying out the original
  `<foreignObject>` is what the conversion reproduces, so the harness reads back
  its line boxes with `Range.getClientRects()` and compares them to the converted
  `<text>` coordinates. Displacement is a median of 0.00px and a p90 of 0.37px on
  `example.svg`; median 0.00 and p90 ≤ 1px across the pretty-printed fixtures.

A whole-image pixel diff is kept only as a coarse smoke test: Chromium rasterises
HTML text and SVG text through different antialiasing paths, so identical glyphs
at identical coordinates still differ across a few percent of edge pixels. Where
an exact answer is possible it is asserted exactly: with text hidden the shapes
must be pixel-identical, and folding styles into classes must change nothing.

Fixtures cover the three export modes draw.io produces (a rasterised `<image>`
fallback, a faithful or truncated `<text>` fallback, and no fallback at all) in
both minified and pretty-printed form, with Japanese written both as raw UTF-8
and as numeric character references.

Deduplicating `<defs>` (gradients, markers, clip paths) is not implemented:
neither reference export contains one, so there is nothing to validate a
deduplicator against.

## Licensing

MIT; see [LICENSE](LICENSE).

Runtime dependencies are MIT except Satori, which is MPL-2.0. That is file-level
copyleft: the obligation attaches to Satori's own files, and only if you modify
them. Declaring it as an npm dependency distributes nothing of Satori's. If you
vendor or bundle Satori into a build artifact you ship, MPL-2.0 §3 applies to
those files and you must make their source available under MPL-2.0.

| Dependency | License |
| --- | --- |
| svgo, htmlparser2, @shuding/opentype.js | MIT |
| satori | MPL-2.0 |
| playwright, typescript *(dev)* | Apache-2.0 |
| pixelmatch *(dev)* | ISC |
| pngjs, vitest, oxlint *(dev)* | MIT |

If you populate `fonts/` with the Chrome OS core fonts (Arimo, Tinos, Cousine),
those are OFL-1.1: ship `OFL.txt` alongside them, keep their Reserved Font Names
if you modify them, and do not sell the fonts on their own. Nothing is bundled by
default.
