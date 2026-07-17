export const MAX_TIKZ_SOURCE_BYTES = 256 * 1024
export const MAX_TIKZ_SVG_BYTES = 16 * 1024 * 1024
export const MAX_TIKZ_CACHE_BYTES = 64 * 1024 * 1024
export const TIKZ_RENDER_TIMEOUT_MS = 30_000

export interface TikzRenderResult {
  ok: true
  svg: string
}

export interface TikzRenderError {
  ok: false
  error: string
}

export type TikzRenderResponse = TikzRenderResult | TikzRenderError

export type TikzHostMessage = {
  type: 'render'
  requestId: number
  source: string
}

export type TikzWorkerMessage =
  | { type: 'ready' }
  | { type: 'render-result'; requestId: number; response: TikzRenderResponse }

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}
