import type { XastElement, XastParent } from 'svgo'

export type { XastElement, XastParent }

/** A non-fatal issue worth surfacing to the caller. */
export interface Warning {
  /** Machine-readable kind, e.g. `font-substitution`, `label-skipped`. */
  code: string
  message: string
  /** Optional detail, e.g. the label text or font family concerned. */
  detail?: string
}

/** Collected by every pass; surfaced by the CLI and the programmatic API. */
export interface PassContext {
  warnings: Warning[]
  warn(code: string, message: string, detail?: string): void
}

export function createContext(): PassContext {
  const warnings: Warning[] = []
  return {
    warnings,
    warn(code, message, detail) {
      warnings.push(detail === undefined ? { code, message } : { code, message, detail })
    },
  }
}

export function isElement(node: { type: string }): node is XastElement {
  return node.type === 'element'
}
