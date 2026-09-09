import { stat } from 'node:fs/promises'
import { basename, extname, join, sep } from 'node:path'

/**
 * Where a given input should be written.
 *
 * With one input, `--out` names the output *file*. It only means a directory
 * when it demonstrably is one — an existing directory, or a path written with a
 * trailing separator. Guessing from the presence of an extension gets
 * `--out build/diagram` wrong, and silently producing
 * `build/diagram/example.svg` is a confusing way to fail.
 *
 * With several inputs there is nothing to name, so `--out` is always a directory.
 */
export async function outputPath(
  input: string,
  out: string | undefined,
  many: boolean,
): Promise<string> {
  if (out === undefined) {
    const extension = extname(input)
    return `${input.slice(0, input.length - extension.length)}.min${extension || '.svg'}`
  }

  if (many || out.endsWith(sep) || out.endsWith('/')) return join(out, basename(input))

  const isDirectory = await stat(out)
    .then((stats) => stats.isDirectory())
    .catch(() => false)
  return isDirectory ? join(out, basename(input)) : out
}
