import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TikzRenderResponse } from './tikz-protocol'

const electronState = vi.hoisted(() => ({
  queue: [] as unknown[],
  forkCount: 0
}))

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      electronState.forkCount += 1
      const child = electronState.queue.shift() as FakeUtilityProcess | undefined
      if (!child) throw new Error('No fake TikZ renderer queued')
      queueMicrotask(() => {
        child.emit('spawn')
        child.emit('message', { type: 'ready' })
      })
      return child
    })
  }
}))

import { MAX_TIKZ_SOURCE_BYTES } from './tikz-protocol'
import { TikzRendererHost } from './tikz'

type Behavior = TikzRenderResponse | 'hang' | 'manual' | 'crash'

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 100
  stdout = null
  stderr = null
  killed = false
  readonly requests: Array<{ requestId: number; source: string }> = []

  constructor(private readonly behaviors: Behavior[]) {
    super()
  }

  postMessage(message: { type: string; requestId: number; source: string }): void {
    if (message.type !== 'render') return
    this.requests.push({
      requestId: message.requestId,
      source: message.source
    })
    const behavior = this.behaviors.shift() ?? 'manual'
    if (behavior === 'hang' || behavior === 'manual') return
    if (behavior === 'crash') {
      queueMicrotask(() => {
        this.pid = undefined
        this.emit('exit', 1)
      })
      return
    }
    queueMicrotask(() => this.respond(message.requestId, behavior))
  }

  respond(requestId: number, response: TikzRenderResponse): void {
    this.emit('message', { type: 'render-result', requestId, response })
  }

  kill(): boolean {
    if (this.killed) return true
    this.killed = true
    this.pid = undefined
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

const hosts: TikzRendererHost[] = []

function host(timeoutMs = 1000, cacheLimitBytes?: number): TikzRendererHost {
  const instance = new TikzRendererHost({
    workerPath: '/fake/tikz-worker.js',
    timeoutMs,
    cacheLimitBytes
  })
  hosts.push(instance)
  return instance
}

beforeEach(() => {
  electronState.queue.length = 0
  electronState.forkCount = 0
})

afterEach(() => {
  for (const instance of hosts.splice(0)) instance.stop()
})

describe('TikzRendererHost', () => {
  it('returns a normal error for malformed IPC input', async () => {
    const result = await host().render(null as unknown as string)

    expect(result).toEqual({ ok: false, error: 'TikZ source must be a string.' })
    expect(electronState.forkCount).toBe(0)
  })

  it('rejects oversized input without starting the renderer', async () => {
    const result = await host().render('x'.repeat(MAX_TIKZ_SOURCE_BYTES + 1))

    expect(result).toMatchObject({ ok: false })
    if (!result.ok) expect(result.error).toContain('limit')
    expect(electronState.forkCount).toBe(0)
  })

  it('deduplicates concurrent work and caches successful SVG output', async () => {
    const child = new FakeUtilityProcess([{ ok: true, svg: '<svg>same</svg>' }])
    electronState.queue.push(child)
    const instance = host()

    const [first, second] = await Promise.all([
      instance.render('same source'),
      instance.render('same source')
    ])
    const cached = await instance.render('same source')

    expect(first).toEqual({ ok: true, svg: '<svg>same</svg>' })
    expect(second).toEqual(first)
    expect(cached).toEqual(first)
    expect(child.requests).toHaveLength(1)
  })

  it('evicts oldest SVGs when the byte-bounded cache is full', async () => {
    const child = new FakeUtilityProcess([
      { ok: true, svg: '<svg>first</svg>' },
      { ok: true, svg: '<svg>second</svg>' },
      { ok: true, svg: '<svg>first-again</svg>' }
    ])
    electronState.queue.push(child)
    const instance = host(1000, 20)

    await expect(instance.render('first source')).resolves.toMatchObject({ ok: true })
    await expect(instance.render('second source')).resolves.toMatchObject({ ok: true })
    await expect(instance.render('first source')).resolves.toEqual({
      ok: true,
      svg: '<svg>first-again</svg>'
    })
    expect(child.requests.map((request) => request.source)).toEqual([
      'first source',
      'second source',
      'first source'
    ])
  })

  it('serializes different sources through one warm process', async () => {
    const child = new FakeUtilityProcess(['manual', { ok: true, svg: '<svg>b</svg>' }])
    electronState.queue.push(child)
    const instance = host()

    const first = instance.render('source a')
    const second = instance.render('source b')
    await vi.waitFor(() => expect(child.requests).toHaveLength(1))
    expect(child.requests[0].source).toBe('source a')

    child.respond(child.requests[0].requestId, {
      ok: true,
      svg: '<svg>a</svg>'
    })
    await expect(first).resolves.toEqual({ ok: true, svg: '<svg>a</svg>' })
    await expect(second).resolves.toEqual({ ok: true, svg: '<svg>b</svg>' })
    expect(child.requests.map((request) => request.source)).toEqual(['source a', 'source b'])
    expect(electronState.forkCount).toBe(1)
  })

  it('kills a timed-out process and starts a fresh one for the next request', async () => {
    const hung = new FakeUtilityProcess(['hang'])
    const recovered = new FakeUtilityProcess([{ ok: true, svg: '<svg>recovered</svg>' }])
    electronState.queue.push(hung, recovered)
    const instance = host(20)

    const timedOut = await instance.render('hang forever')
    expect(timedOut).toMatchObject({ ok: false })
    if (!timedOut.ok) expect(timedOut.error).toContain('timed out')
    expect(hung.killed).toBe(true)

    await expect(instance.render('valid source')).resolves.toEqual({
      ok: true,
      svg: '<svg>recovered</svg>'
    })
    expect(electronState.forkCount).toBe(2)
  })

  it('keeps the worker alive after an ordinary TeX error', async () => {
    const child = new FakeUtilityProcess([
      { ok: false, error: 'Undefined control sequence' },
      { ok: true, svg: '<svg>valid</svg>' }
    ])
    electronState.queue.push(child)
    const instance = host()

    await expect(instance.render('broken source')).resolves.toEqual({
      ok: false,
      error: 'Undefined control sequence'
    })
    await expect(instance.render('valid source')).resolves.toEqual({
      ok: true,
      svg: '<svg>valid</svg>'
    })
    expect(electronState.forkCount).toBe(1)
    expect(child.killed).toBe(false)
  })

  it('does not respawn the process for queued work after shutdown', async () => {
    const child = new FakeUtilityProcess(['manual'])
    electronState.queue.push(child)
    const instance = host()

    const active = instance.render('active source')
    const queued = instance.render('queued source')
    await vi.waitFor(() => expect(child.requests).toHaveLength(1))
    instance.stop()

    await expect(active).resolves.toMatchObject({ ok: false })
    await expect(queued).resolves.toEqual({ ok: false, error: 'TikZ renderer has stopped.' })
    expect(child.killed).toBe(true)
    expect(electronState.forkCount).toBe(1)
  })
})
