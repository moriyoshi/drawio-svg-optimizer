/**
 * Bundle the browser entry point the way a consumer's bundler would.
 *
 * Shared by `check-browser.mjs` and the Chromium smoke test so there is one
 * definition of "as a bundler would see it" rather than two that can drift.
 *
 * esbuild only applies the `browser` field to files inside `node_modules`, and
 * this runs against `dist/` in place, so the field is applied by hand.
 */
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * Resolve a package subpath through its `exports` map, without a resolver.
 *
 * `import.meta.resolve` is unavailable under Vitest's transform and
 * `require.resolve` cannot see `svgo/browser`, whose export declares only
 * `import` and `types` conditions.
 */
function resolveSubpath(specifier) {
  const slash = specifier.indexOf('/')
  const name = slash < 0 ? specifier : specifier.slice(0, slash)
  const subpath = slash < 0 ? '.' : `.${specifier.slice(slash)}`
  const dir = `${root}node_modules/${name}/`
  const pkg = JSON.parse(readFileSync(`${dir}package.json`, 'utf8'))
  const entry = pkg.exports?.[subpath]
  const file = typeof entry === 'string' ? entry : (entry?.import ?? entry?.default)
  if (file === undefined) throw new Error(`cannot resolve ${specifier}`)
  return dir + file.replace(/^\.\//, '')
}

export async function bundleBrowser({ minify = false, entry = 'dist/browser/index.js' } = {}) {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
  const remap = Object.fromEntries(
    Object.entries(pkg.browser)
      .filter(([, to]) => to !== false)
      .map(([from, to]) => [from.startsWith('./') ? `${root}${from.slice(2)}` : from, to]),
  )
  const stubbed = Object.keys(pkg.browser).filter((key) => pkg.browser[key] === false)

  return build({
    entryPoints: [`${root}${entry}`],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    minify,
    logLevel: 'silent',
    plugins: [
      {
        name: 'browser-field',
        setup(pluginBuild) {
          pluginBuild.onResolve({ filter: /.*/ }, (args) => {
            if (stubbed.includes(args.path)) return { path: args.path, namespace: 'stub' }
            const direct = remap[args.path]
            if (direct !== undefined) return { path: resolveSubpath(direct) }
            if (args.importer !== '' && args.path.startsWith('.')) {
              const resolved = new URL(args.path, `file://${args.importer}`).pathname
              const mapped = remap[resolved]
              if (mapped !== undefined) return { path: `${root}${mapped.slice(2)}` }
            }
            return undefined
          })
          pluginBuild.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export default {}',
          }))
        },
      },
    ],
  })
}
