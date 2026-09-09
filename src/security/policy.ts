/**
 * What a document is allowed to reference.
 *
 * The threat model is a draw.io export from someone else. Two distinct things
 * can go wrong, and they need separating because the defences differ:
 *
 *  - **At processing time**, this tool could be made to fetch something. The XML
 *    parsers here do not resolve external entities (verified in the tests), and
 *    the only network access is font resolution, which is restricted to a host
 *    allowlist — but a document must never be able to steer it.
 *  - **At render time**, the *output* could make a viewer's browser fetch
 *    something. A remote `<image>`, a webfont, an `@import`, or a `<use>` into
 *    another document all leak the viewer's IP, user agent and referrer to
 *    whoever authored the diagram, and turn a static picture into a beacon.
 *
 * The default is to permit nothing that reaches the network. Same-document
 * fragments and `data:` URIs stay, because those are how a self-contained SVG
 * refers to its own gradients and embeds its own images.
 */

export interface NetworkPolicy {
  /**
   * Hosts an `https:` reference may name.
   *
   * Empty by default. A host here is trusted with the viewer's IP address and
   * referrer, so this is not a list to extend casually.
   */
  allowedHosts: string[]
  /** Permit `data:` URIs for images and fonts. @default true */
  allowDataUris: boolean
  /**
   * Permit `data:image/svg+xml`.
   *
   * Off by default: an SVG is a document, not a picture, and nesting one moves
   * scripts and external references inside something that looks inert.
   *
   * @default false
   */
  allowNestedSvgData: boolean
}

export const STRICT_POLICY: NetworkPolicy = {
  allowedHosts: [],
  allowDataUris: true,
  allowNestedSvgData: false,
}

export type ReferenceKind =
  /** `#gradient` — resolved inside this document. */
  | 'fragment'
  /** An inline `data:` payload. */
  | 'data'
  /** Reaches the network. */
  | 'external'
  /** Executes code, or renders as a document. */
  | 'dangerous'

export interface Verdict {
  kind: ReferenceKind
  allowed: boolean
  /** Short, human-readable justification, used in warnings. */
  reason: string
}

/** Schemes that execute script or navigate, whatever the context. */
const EXECUTABLE = new Set(['javascript', 'vbscript', 'livescript', 'mocha', 'jscript'])

/**
 * Normalise a URL enough to classify it.
 *
 * Attribute values arrive with entities already decoded by the parser, but a
 * hand-written document can still hide a scheme behind whitespace or control
 * characters — browsers strip both before matching, so we do too. `&#106;` for
 * `j` in `javascript:` is the classic form.
 */
function normalise(raw: string): string {
  return raw
    .replace(/&#x?([\da-f]+);?/gi, (whole, code: string) => {
      const point = whole.toLowerCase().includes('x') ? Number.parseInt(code, 16) : Number(code)
      return Number.isFinite(point) && point > 0 && point < 0x11_00_00
        ? String.fromCodePoint(point)
        : whole
    })
    // Browsers ignore C0 controls and whitespace inside a scheme, so matching
    // them here is the point: `java\tscript:` must classify as javascript:.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020\u007F]/g, '')
    .trim()
}

function hostAllowed(host: string, policy: NetworkPolicy): boolean {
  const target = host.toLowerCase()
  return policy.allowedHosts.some((allowed) => {
    const candidate = allowed.toLowerCase()
    return target === candidate || target.endsWith(`.${candidate}`)
  })
}

/**
 * Classify a URL reference against the policy.
 *
 * Anything unrecognised is treated as external rather than assumed safe: a
 * reference this code cannot parse is exactly the kind a browser might parse
 * differently.
 */
export function classify(raw: string, policy: NetworkPolicy = STRICT_POLICY): Verdict {
  const value = normalise(raw)
  if (value === '') return { kind: 'fragment', allowed: true, reason: 'empty' }

  if (value.startsWith('#')) {
    return { kind: 'fragment', allowed: true, reason: 'same-document fragment' }
  }

  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value)?.[1]?.toLowerCase()

  if (scheme !== undefined && EXECUTABLE.has(scheme)) {
    return { kind: 'dangerous', allowed: false, reason: `${scheme}: executes script` }
  }

  if (scheme === 'data') {
    const media = /^data:([^;,]*)/i.exec(value)?.[1]?.toLowerCase() ?? ''
    if (media.includes('html') || media.includes('xhtml')) {
      return { kind: 'dangerous', allowed: false, reason: 'data: HTML renders as a document' }
    }
    if (media.includes('svg')) {
      return policy.allowNestedSvgData
        ? { kind: 'data', allowed: true, reason: 'nested SVG data allowed by policy' }
        : { kind: 'dangerous', allowed: false, reason: 'data: SVG can carry script' }
    }
    return policy.allowDataUris
      ? { kind: 'data', allowed: true, reason: 'inline data' }
      : { kind: 'data', allowed: false, reason: 'data: URIs disabled by policy' }
  }

  // Protocol-relative `//host/path` reaches the network just as `https:` does.
  if (value.startsWith('//')) {
    const host = value.slice(2).split(/[/?#]/)[0] ?? ''
    return hostAllowed(host, policy)
      ? { kind: 'external', allowed: true, reason: `host ${host} allowed by policy` }
      : { kind: 'external', allowed: false, reason: `protocol-relative reference to ${host}` }
  }

  if (scheme === 'http' || scheme === 'https') {
    let host = ''
    try {
      host = new URL(value).hostname
    } catch {
      return { kind: 'external', allowed: false, reason: 'unparseable absolute URL' }
    }
    return hostAllowed(host, policy)
      ? { kind: 'external', allowed: true, reason: `host ${host} allowed by policy` }
      : { kind: 'external', allowed: false, reason: `remote reference to ${host}` }
  }

  if (scheme !== undefined) {
    // file:, ftp:, blob:, jar:, and anything else a viewer might act on.
    return { kind: 'external', allowed: false, reason: `${scheme}: reference` }
  }

  // A relative path resolves against wherever the file ends up, which for an SVG
  // opened from a page means a request to that origin.
  return { kind: 'external', allowed: false, reason: 'relative reference to another file' }
}

/** Hosts the font resolver may contact. Not configurable from a document. */
export const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'] as const

/** True when a URL this tool is about to fetch is one it is allowed to fetch. */
export function isAllowedFontUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    return FONT_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}
