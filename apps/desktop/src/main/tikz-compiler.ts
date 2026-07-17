import { MAX_TIKZ_SOURCE_BYTES, MAX_TIKZ_SVG_BYTES, type TikzRenderResponse } from './tikz-protocol'

type Tex2Svg = (input: string, options?: Record<string, unknown>) => Promise<string>

let tex2svg: Tex2Svg | null = null
let loadPromise: Promise<Tex2Svg> | null = null

async function load(): Promise<Tex2Svg> {
  if (tex2svg) return tex2svg
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    const mod = await import('node-tikzjax')
    // node-tikzjax is CommonJS, so dynamic import interop may expose its
    // function as either `default` or `default.default`.
    const candidate =
      (mod as unknown as { default?: { default?: Tex2Svg } | Tex2Svg }).default ??
      (mod as unknown as Tex2Svg)
    const fn =
      typeof candidate === 'function' ? candidate : (candidate as { default?: Tex2Svg }).default
    if (typeof fn !== 'function') {
      throw new Error('Could not locate tex2svg in node-tikzjax')
    }
    tex2svg = fn
    return fn
  })().catch((error) => {
    loadPromise = null
    throw error
  })
  return loadPromise
}

/** Normalize a full document or convenient fragment for node-tikzjax. */
export function wrapTikzSource(source: string): string {
  const trimmed = source.trim()
  if (!trimmed) return ''

  const withoutDocumentClass = trimmed
    .replace(/^\s*\\documentclass(?:\[[^\]]*])?\{[^}]+\}\s*$/gm, '')
    .trim()

  const hasBeginDocument = /\\begin\{document\}/.test(withoutDocumentClass)
  const hasEndDocument = /\\end\{document\}/.test(withoutDocumentClass)
  if (hasBeginDocument && hasEndDocument) return withoutDocumentClass

  const withoutDocumentWrappers = withoutDocumentClass
    .replace(/\\begin\{document\}/g, '')
    .replace(/\\end\{document\}/g, '')
    .trim()

  const bodyStart = findDocumentBodyStart(withoutDocumentWrappers)
  if (bodyStart > 0) {
    const preamble = withoutDocumentWrappers.slice(0, bodyStart).trim()
    const body = withoutDocumentWrappers.slice(bodyStart).trim()
    return `${preamble}\n\\begin{document}\n${body}\n\\end{document}`
  }

  return `\\begin{document}\n${withoutDocumentWrappers}\n\\end{document}`
}

function findDocumentBodyStart(source: string): number {
  const candidates = [
    /\\begin\{(?!document\b)[^}]+\}/,
    /\\tikz\b/,
    /\\draw\b/,
    /\\path\b/,
    /\\node\b/,
    /\\coordinate\b/,
    /\\matrix\b/,
    /\\graph\b/
  ]

  let earliest = -1
  for (const pattern of candidates) {
    const match = pattern.exec(source)
    if (!match || match.index < 0) continue
    if (earliest < 0 || match.index < earliest) earliest = match.index
  }
  return earliest
}

/** Compile one request. The utility-process host guarantees calls are serialized. */
export async function compileTikz(source: string): Promise<TikzRenderResponse> {
  if (typeof source !== 'string') return { ok: false, error: 'TikZ source must be a string.' }
  if (!source.trim()) return { ok: false, error: 'Empty TikZ block' }
  if (Buffer.byteLength(source, 'utf8') > MAX_TIKZ_SOURCE_BYTES) {
    return {
      ok: false,
      error: `TikZ block exceeds the ${MAX_TIKZ_SOURCE_BYTES}-byte source limit.`
    }
  }

  // node-tikzjax exposes TeX diagnostics only through console.log. Capturing
  // it is safe here because this process is dedicated to TikZ compilation.
  const captured: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]): void => {
    captured.push(
      args.map((value) => (typeof value === 'string' ? value : String(value))).join(' ')
    )
  }

  try {
    const fn = await load()
    const texPackages: Record<string, string> = { amsmath: '', amssymb: '' }
    const usesPgfPlots =
      source.includes('pgfplots') || source.includes('axis') || source.includes('plot')
    if (usesPgfPlots) texPackages.pgfplots = ''

    const usesCircuitikz = source.includes('circuitikz') || source.includes('ctikzset')
    if (usesCircuitikz) texPackages.circuitikz = ''

    const svg = await fn(wrapTikzSource(source), {
      showConsole: true,
      texPackages,
      tikzLibraries:
        'arrows.meta,calc,positioning,shapes,decorations.pathreplacing,intersections,patterns'
    })
    if (Buffer.byteLength(svg, 'utf8') > MAX_TIKZ_SVG_BYTES) {
      return {
        ok: false,
        error: `Rendered TikZ SVG exceeds the ${MAX_TIKZ_SVG_BYTES}-byte output limit.`
      }
    }
    return { ok: true, svg }
  } catch (error) {
    const base = error instanceof Error ? error.message : 'Unknown TikZ render error'
    const texDiagnostic = extractTexError(captured.join('\n'))
    const message = texDiagnostic ? `${base}\n\n${texDiagnostic}` : base
    console.error('[tikz] render failed:', message)
    return { ok: false, error: message }
  } finally {
    console.log = originalLog
  }
}

function extractTexError(log: string): string {
  const lines = log.split(/\r?\n/)
  let index = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('!')) {
      index = i
      break
    }
  }
  if (index < 0) return ''
  return lines.slice(index, Math.min(index + 4, lines.length)).join('\n')
}
