/**
 * Prove the browser-facing entry points bundle with no Node built-ins in them.
 *
 * This is the only thing that can: `tsc` never resolves the `browser` field, so
 * a platform variant that drifted, or a new `node:` import added to a shared
 * module, would be invisible until someone tried to bundle the package.
 *
 * The `./fonts` subpath is checked too. It exports pure family tables precisely
 * so a browser consumer can reach them, and "pure" is a claim that needs a test
 * rather than a comment.
 */
import { bundleBrowser } from './browser-bundle.mjs'

const entries = [
  { name: 'browser entry', entry: 'dist/browser/index.js' },
  { name: './fonts subpath', entry: 'dist/fonts/index.js' },
]

let failed = false
for (const { name, entry } of entries) {
  const result = await bundleBrowser({ entry })
  const inputs = Object.keys(result.metafile.inputs)
  const builtins = inputs.filter((input) => input.startsWith('node:'))

  if (builtins.length > 0) {
    console.error(`${name}: Node built-ins reached the bundle:\n  ${builtins.join('\n  ')}`)
    failed = true
    continue
  }
  const bytes = result.outputFiles[0].contents.byteLength
  console.log(`${name}: ${inputs.length} modules, ${(bytes / 1024).toFixed(0)} KB, no node: imports`)
}

if (failed) process.exit(1)
