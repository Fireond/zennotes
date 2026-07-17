/**
 * TikZ rendering host.
 *
 * Compilation runs in one lazily created Electron utility process. This keeps
 * node-tikzjax's synchronous WebAssembly work and roughly 80 MB of TeX state
 * out of the Electron main process, while retaining one warm engine shared by
 * every window. Requests are serialized because node-tikzjax uses global state.
 */
import { utilityProcess, type UtilityProcess } from 'electron'
import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  MAX_TIKZ_CACHE_BYTES,
  MAX_TIKZ_SOURCE_BYTES,
  TIKZ_RENDER_TIMEOUT_MS,
  errorText,
  type TikzHostMessage,
  type TikzRenderError,
  type TikzRenderResponse,
  type TikzRenderResult,
  type TikzWorkerMessage
} from './tikz-protocol'

export type { TikzRenderError, TikzRenderResponse, TikzRenderResult } from './tikz-protocol'

interface PendingRender {
  resolve(response: TikzRenderResponse): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

class TikzWorkerConnection {
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRender>()
  private readonly readyPromise: Promise<void>
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private stopped = false

  constructor(
    private readonly child: UtilityProcess,
    private readonly timeoutMs: number,
    private readonly onStopped: () => void
  ) {
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    // Prevent an idle worker crash from producing an unhandled rejection.
    void this.readyPromise.catch(() => {})

    child.on('message', (raw) => this.onMessage(raw as TikzWorkerMessage))
    child.on('exit', (code) => this.fail(new Error(`TikZ renderer exited with code ${code}.`)))
    child.on('error', (type, location) => {
      this.fail(new Error(`TikZ renderer process ${type}${location ? ` at ${location}` : ''}.`))
    })
    child.on('spawn', () => {
      if (this.stopped && child.pid !== undefined) child.kill()
    })
    child.stdout?.on('data', (chunk) => process.stdout.write(`[tikz] ${String(chunk)}`))
    child.stderr?.on('data', (chunk) => process.stderr.write(`[tikz] ${String(chunk)}`))
  }

  render(source: string): Promise<TikzRenderResponse> {
    if (this.stopped) return Promise.reject(new Error('TikZ renderer is not running.'))
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        const seconds = this.timeoutMs / 1000
        reject(new Error(`TikZ rendering timed out after ${seconds}s.`))
        this.terminate()
      }, this.timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer })

      void this.readyPromise.then(
        () => {
          if (!this.pending.has(requestId) || this.stopped) return
          const message: TikzHostMessage = {
            type: 'render',
            requestId,
            source
          }
          this.child.postMessage(message)
        },
        (error: unknown) => {
          const pending = this.pending.get(requestId)
          if (!pending) return
          this.pending.delete(requestId)
          clearTimeout(pending.timer)
          pending.reject(error instanceof Error ? error : new Error(errorText(error)))
        }
      )
    })
  }

  terminate(): void {
    if (this.stopped) return
    this.stopped = true
    this.rejectPending(new Error('TikZ renderer stopped.'))
    this.readyReject?.(new Error('TikZ renderer stopped.'))
    this.readyResolve = null
    this.readyReject = null
    if (this.child.pid !== undefined) this.child.kill()
    this.onStopped()
  }

  private onMessage(message: TikzWorkerMessage): void {
    if (!message || typeof message !== 'object') return
    if (message.type === 'ready') {
      this.readyResolve?.()
      this.readyResolve = null
      this.readyReject = null
      return
    }
    if (message.type !== 'render-result') return
    const pending = this.pending.get(message.requestId)
    if (!pending) return
    this.pending.delete(message.requestId)
    clearTimeout(pending.timer)
    pending.resolve(message.response)
  }

  private fail(error: Error): void {
    if (this.stopped) return
    this.stopped = true
    this.readyReject?.(error)
    this.readyResolve = null
    this.readyReject = null
    this.rejectPending(error)
    if (this.child.pid !== undefined) this.child.kill()
    this.onStopped()
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export interface TikzRendererHostOptions {
  workerPath: string
  timeoutMs?: number
  cacheLimitBytes?: number
}

export class TikzRendererHost {
  private worker: TikzWorkerConnection | null = null
  private renderQueue: Promise<void> = Promise.resolve()
  private readonly cache = new Map<string, { result: TikzRenderResult; bytes: number }>()
  private readonly inFlight = new Map<string, Promise<TikzRenderResponse>>()
  private readonly timeoutMs: number
  private readonly cacheLimitBytes: number
  private cacheBytes = 0
  private stopped = false

  constructor(private readonly options: TikzRendererHostOptions) {
    this.timeoutMs = options.timeoutMs ?? TIKZ_RENDER_TIMEOUT_MS
    this.cacheLimitBytes = options.cacheLimitBytes ?? MAX_TIKZ_CACHE_BYTES
  }

  async render(source: string): Promise<TikzRenderResponse> {
    if (typeof source !== 'string') return { ok: false, error: 'TikZ source must be a string.' }
    if (!source.trim()) return { ok: false, error: 'Empty TikZ block' }
    if (this.stopped) return { ok: false, error: 'TikZ renderer has stopped.' }
    const sourceBytes = Buffer.byteLength(source, 'utf8')
    if (sourceBytes > MAX_TIKZ_SOURCE_BYTES) {
      return {
        ok: false,
        error: `TikZ block is ${sourceBytes} bytes; the limit is ${MAX_TIKZ_SOURCE_BYTES} bytes.`
      }
    }

    const key = createHash('sha1').update(source).digest('hex')
    const cached = this.cache.get(key)
    if (cached) return cached.result
    const pending = this.inFlight.get(key)
    if (pending) return pending

    const run = this.enqueue(async () => {
      if (this.stopped) return { ok: false as const, error: 'TikZ renderer has stopped.' }
      const worker = this.getWorker()
      try {
        const response = await worker.render(source)
        if (response.ok) {
          const bytes = Buffer.byteLength(response.svg, 'utf8')
          const previous = this.cache.get(key)
          if (previous) this.cacheBytes -= previous.bytes
          this.cache.set(key, { result: response, bytes })
          this.cacheBytes += bytes
          this.pruneCache()
        }
        return response
      } catch (error) {
        if (this.worker === worker) {
          this.worker = null
          worker.terminate()
        }
        return { ok: false as const, error: errorText(error) }
      }
    })
    this.inFlight.set(key, run)
    try {
      return await run
    } finally {
      this.inFlight.delete(key)
    }
  }

  stop(): void {
    this.stopped = true
    this.worker?.terminate()
    this.worker = null
  }

  private getWorker(): TikzWorkerConnection {
    if (this.worker) return this.worker
    const child = utilityProcess.fork(this.options.workerPath, [], {
      serviceName: 'ZenNotes TikZ Renderer',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let connection: TikzWorkerConnection
    connection = new TikzWorkerConnection(child, this.timeoutMs, () => {
      if (this.worker === connection) this.worker = null
    })
    this.worker = connection
    return connection
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.renderQueue.then(job, job)
    this.renderQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  private pruneCache(): void {
    const entryLimit = 200
    while (this.cache.size > entryLimit || this.cacheBytes > this.cacheLimitBytes) {
      const oldest = this.cache.entries().next().value as
        | [string, { result: TikzRenderResult; bytes: number }]
        | undefined
      if (!oldest) break
      const [key, entry] = oldest
      this.cache.delete(key)
      this.cacheBytes -= entry.bytes
    }
  }
}

const renderer = new TikzRendererHost({
  workerPath: path.join(__dirname, 'tikz-worker.js')
})

/** Compile TikZ source without blocking Electron's main process. */
export function renderTikz(source: string): Promise<TikzRenderResult | TikzRenderError> {
  return renderer.render(source)
}

/** Stop the warm TeX utility process during app shutdown. */
export function stopTikzRenderer(): void {
  renderer.stop()
}
