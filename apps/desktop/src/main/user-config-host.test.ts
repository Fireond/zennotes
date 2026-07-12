import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  UserCommandContext,
  UserCommandInvocation,
  UserVimMapping
} from '@zennotes/bridge-contract/user-config'

const electronState = vi.hoisted(() => ({ queue: [] as unknown[] }))

vi.mock('electron', () => ({
  utilityProcess: {
    fork: vi.fn(() => {
      const child = electronState.queue.shift() as FakeUtilityProcess | undefined
      if (!child) throw new Error('No fake user config process queued')
      queueMicrotask(() => child.emit('spawn'))
      return child
    })
  }
}))

import { DEFAULT_USER_CONFIG_SOURCE, UserConfigHost } from './user-config-host'

type LoadResult =
  | { ok: true; mappings: UserVimMapping[]; commands: Array<{ id: string; title: string }> }
  | { ok: false; error: string }

class FakeUtilityProcess extends EventEmitter {
  pid: number | undefined = 100
  stdout = null
  stderr = null
  killed = false
  invocation: UserCommandInvocation = { ok: true, result: null }
  crashOnInvoke = false

  constructor(private readonly loadResult: LoadResult) {
    super()
  }

  postMessage(message: Record<string, unknown>): void {
    if (message.type === 'load') {
      queueMicrotask(() => {
        if (this.loadResult.ok) {
          this.emit('message', {
            type: 'ready',
            mappings: this.loadResult.mappings,
            commands: this.loadResult.commands
          })
        } else {
          this.emit('message', { type: 'load-error', error: this.loadResult.error })
        }
      })
      return
    }
    if (message.type === 'invoke') {
      queueMicrotask(() => {
        if (this.crashOnInvoke) {
          this.pid = undefined
          this.emit('exit', 1)
          return
        }
        this.emit('message', {
          type: 'invoke-result',
          requestId: message.requestId,
          response: this.invocation
        })
      })
    }
  }

  kill(): boolean {
    this.killed = true
    this.pid = undefined
    queueMicrotask(() => this.emit('exit', 0))
    return true
  }
}

const hosts: UserConfigHost[] = []
const tempDirs: string[] = []

function context(): UserCommandContext {
  return {
    path: 'inbox/example.md',
    text: 'abc',
    version: 1,
    selections: [{ from: 0, to: 3 }],
    cursor: { offset: 3, line: 1, column: 3 },
    vim: { mode: 'v', count: null, register: null }
  }
}

beforeEach(() => {
  electronState.queue.length = 0
})

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.stop()))
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('UserConfigHost', () => {
  it('keeps the previous process and snapshot when a reload fails', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zennotes-user-host-'))
    tempDirs.push(dir)
    const first = new FakeUtilityProcess({
      ok: true,
      mappings: [
        { mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^', recursive: false } }
      ],
      commands: [{ id: 'user.upper', title: 'Uppercase' }]
    })
    electronState.queue.push(first)
    const snapshots: number[] = []
    const host = new UserConfigHost({
      configPath: path.join(dir, 'init.mjs'),
      workerPath: '/fake/user-config-worker.js',
      onChange: (snapshot) => snapshots.push(snapshot.revision)
    })
    hosts.push(host)

    const loaded = await host.start()
    expect(loaded.mappings[0]).toMatchObject({ mode: 'n', lhs: 'H' })
    await expect(fs.readFile(path.join(dir, 'init.mjs'), 'utf8')).resolves.toBe(
      DEFAULT_USER_CONFIG_SOURCE
    )

    const broken = new FakeUtilityProcess({ ok: false, error: 'SyntaxError: unexpected token' })
    electronState.queue.push(broken)
    const retained = await host.reload()

    expect(retained.mappings).toEqual(loaded.mappings)
    expect(retained.commands).toEqual(loaded.commands)
    expect(retained.error).toContain('unexpected token')
    expect(first.killed).toBe(false)
    expect(broken.killed).toBe(true)

    first.invocation = {
      ok: true,
      result: { edits: [{ from: 0, to: 3, insert: 'ABC' }] }
    }
    await expect(host.invoke('user.upper', context())).resolves.toEqual(first.invocation)
    expect(snapshots).toEqual([1, 2])
  })

  it('atomically replaces the old process after a successful reload', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zennotes-user-host-'))
    tempDirs.push(dir)
    const first = new FakeUtilityProcess({ ok: true, mappings: [], commands: [] })
    electronState.queue.push(first)
    const host = new UserConfigHost({
      configPath: path.join(dir, 'init.mjs'),
      workerPath: '/fake/user-config-worker.js'
    })
    hosts.push(host)
    await host.start()

    const second = new FakeUtilityProcess({
      ok: true,
      mappings: [{ mode: 'v', lhs: 'U', target: { type: 'disabled' } }],
      commands: []
    })
    electronState.queue.push(second)
    const reloaded = await host.reload()

    expect(reloaded.error).toBeNull()
    expect(reloaded.mappings).toHaveLength(1)
    expect(first.killed).toBe(true)
    expect(second.killed).toBe(false)
  })

  it('restarts the last-good config once after the command process crashes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zennotes-user-host-'))
    tempDirs.push(dir)
    const first = new FakeUtilityProcess({
      ok: true,
      mappings: [],
      commands: [{ id: 'user.upper', title: 'Uppercase' }]
    })
    first.crashOnInvoke = true
    const recovered = new FakeUtilityProcess({
      ok: true,
      mappings: [],
      commands: [{ id: 'user.upper', title: 'Uppercase' }]
    })
    electronState.queue.push(first, recovered)
    const host = new UserConfigHost({
      configPath: path.join(dir, 'init.mjs'),
      workerPath: '/fake/user-config-worker.js'
    })
    hosts.push(host)
    await host.start()

    await expect(host.invoke('user.upper', context())).resolves.toMatchObject({ ok: false })
    await vi.waitFor(() => expect(host.getSnapshot().error).toBeNull())

    recovered.invocation = {
      ok: true,
      result: { edits: [{ from: 0, to: 3, insert: 'ABC' }] }
    }
    await expect(host.invoke('user.upper', context())).resolves.toEqual(recovered.invocation)
  })
})
