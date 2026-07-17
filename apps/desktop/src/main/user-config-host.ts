import { utilityProcess, type UtilityProcess } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type {
  UserCommandContext,
  UserCommandInvocation,
  UserConfigSnapshot
} from '@zennotes/bridge-contract/user-config'
import {
  errorText,
  type UserConfigHostMessage,
  type UserConfigWorkerMessage
} from './user-config-protocol'

const LOAD_TIMEOUT_MS = 10_000
const INVOKE_TIMEOUT_MS = 10_000
const WATCH_DEBOUNCE_MS = 150
const RUNTIME_RECOVERY_DELAY_MS = 100

export const DEFAULT_USER_CONFIG_SOURCE = `// ZenNotes programmable Vim configuration.
// This is trusted local JavaScript with normal Node.js access. Changes reload live.
// Reference: docs/reference/programmable-vim-config.md in the ZenNotes source tree.

export default async function setup(zen) {
  // Neovim-style motions:
  // zen.keymap.set('n', 'H', '^')
  // zen.keymap.set('n', 'L', '$')

  // Run a built-in ZenNotes command from Vim normal mode:
  // zen.keymap.set('n', '<C-w>', zen.command('global.closeActiveTab'))

  // Disable a Vim binding (mapping it to a no-op):
  // zen.keymap.disable('n', 'Q')

  // Transform every non-empty visual selection:
  // zen.commands.registerTransform({
  //   id: 'user.uppercase-selection',
  //   title: 'Uppercase selection',
  //   run(text) { return text.toUpperCase() }
  // })
  // zen.keymap.set('v', '<leader>u', zen.command('user.uppercase-selection'))

  // Statically import LuaSnip files without executing their Lua code:
  // await zen.snippets.importLuaSnip({
  //   root: '~/.config/nvim/LuaSnip',
  //   filetype: 'markdown',
  //   extend: ['tex_shared'],
  //   keys: {
  //     expandOrJump: 'fj',
  //     jumpBackward: 'fk',
  //     nextChoice: '<C-h>',
  //     previousChoice: '<C-p>',
  //     storeSelection: '\`'
  //   }
  // })
}
`

interface PendingInvocation {
  resolve(value: UserCommandInvocation): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

class WorkerConnection {
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingInvocation>()
  private loadResolve:
    | ((message: Extract<UserConfigWorkerMessage, { type: 'ready' }>) => void)
    | null = null
  private loadReject: ((error: Error) => void) | null = null
  private loadTimer: ReturnType<typeof setTimeout> | null = null
  private expectedExit = false
  private ready = false
  private unexpectedExit: ((error: Error) => void) | null = null

  constructor(private readonly child: UtilityProcess) {
    child.on('message', (raw) => this.onMessage(raw as UserConfigWorkerMessage))
    child.on('exit', (code) => this.onExit(code))
    child.on('error', (type, location) => {
      this.fail(new Error(`User config process ${type}${location ? ` at ${location}` : ''}.`))
    })
    child.stdout?.on('data', (chunk) => process.stdout.write(`[user-config] ${String(chunk)}`))
    child.stderr?.on('data', (chunk) => process.stderr.write(`[user-config] ${String(chunk)}`))
  }

  load(configPath: string): Promise<Extract<UserConfigWorkerMessage, { type: 'ready' }>> {
    return new Promise((resolve, reject) => {
      this.loadResolve = resolve
      this.loadReject = reject
      this.loadTimer = setTimeout(() => {
        this.loadTimer = null
        this.fail(new Error(`Loading ${configPath} timed out after ${LOAD_TIMEOUT_MS / 1000}s.`))
        this.terminate()
      }, LOAD_TIMEOUT_MS)

      this.child.once('spawn', () => {
        const message: UserConfigHostMessage = { type: 'load', configPath }
        this.child.postMessage(message)
      })
    })
  }

  setUnexpectedExitHandler(handler: (error: Error) => void): void {
    this.unexpectedExit = handler
  }

  isRunning(): boolean {
    return this.ready && this.child.pid !== undefined
  }

  invoke(commandId: string, context: UserCommandContext): Promise<UserCommandInvocation> {
    if (!this.ready || this.child.pid === undefined) {
      return Promise.reject(new Error('User config process is not running.'))
    }
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(
          new Error(`User command "${commandId}" timed out after ${INVOKE_TIMEOUT_MS / 1000}s.`)
        )
      }, INVOKE_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      const message: UserConfigHostMessage = {
        type: 'invoke',
        requestId,
        commandId,
        context
      }
      this.child.postMessage(message)
    })
  }

  terminate(): void {
    this.expectedExit = true
    this.rejectPending(new Error('User config process stopped.'))
    if (this.child.pid !== undefined) this.child.kill()
  }

  private onMessage(message: UserConfigWorkerMessage): void {
    if (!message || typeof message !== 'object') return
    if (message.type === 'ready') {
      if (!this.loadResolve) return
      this.ready = true
      this.clearLoadTimer()
      const resolve = this.loadResolve
      this.loadResolve = null
      this.loadReject = null
      resolve(message)
      return
    }
    if (message.type === 'load-error') {
      this.fail(new Error(message.error))
      return
    }
    if (message.type === 'invoke-result') {
      const pending = this.pending.get(message.requestId)
      if (!pending) return
      this.pending.delete(message.requestId)
      clearTimeout(pending.timer)
      pending.resolve(message.response)
    }
  }

  private onExit(code: number): void {
    const error = new Error(`User config process exited with code ${code}.`)
    this.fail(error)
    if (!this.expectedExit && this.ready) this.unexpectedExit?.(error)
  }

  private fail(error: Error): void {
    this.clearLoadTimer()
    if (this.loadReject) {
      const reject = this.loadReject
      this.loadResolve = null
      this.loadReject = null
      reject(error)
    }
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer)
    this.loadTimer = null
  }
}

export interface UserConfigHostOptions {
  configPath: string
  workerPath: string
  onChange?(snapshot: UserConfigSnapshot): void
}

/** Owns the last-good config process and atomically replaces it after a valid reload. */
export class UserConfigHost {
  private active: WorkerConnection | null = null
  private candidate: WorkerConnection | null = null
  private watcher: FSWatcher | null = null
  private watchedDependencies = new Set<string>()
  private watchTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private runtimeRecoveryUsed = false
  private reloadQueue: Promise<void> = Promise.resolve()
  private stopped = false
  private snapshot: UserConfigSnapshot

  constructor(private readonly options: UserConfigHostOptions) {
    this.snapshot = {
      revision: 0,
      snippetRevision: 0,
      configPath: options.configPath,
      mappings: [],
      commands: [],
      snippets: [],
      snippetDiagnostics: [],
      snippetKeys: {
        expandOrJump: null,
        jumpBackward: null,
        nextChoice: null,
        previousChoice: null,
        storeSelection: null
      },
      error: null
    }
  }

  async start(): Promise<UserConfigSnapshot> {
    this.stopped = false
    await fs.mkdir(path.dirname(this.options.configPath), { recursive: true })
    await this.ensureStarterFile()
    this.startWatching()
    return await this.reload()
  }

  getSnapshot(): UserConfigSnapshot {
    return structuredClone(this.snapshot)
  }

  reload(): Promise<UserConfigSnapshot> {
    // A hand reload or watcher-triggered reload starts a fresh recovery budget.
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    this.runtimeRecoveryUsed = false
    return this.enqueueReload()
  }

  private enqueueReload(): Promise<UserConfigSnapshot> {
    const next = this.reloadQueue.catch(() => {}).then(() => this.reloadNow())
    this.reloadQueue = next.then(
      () => {},
      () => {}
    )
    return next
  }

  async invoke(commandId: string, context: UserCommandContext): Promise<UserCommandInvocation> {
    const active = this.active
    if (!active) return { ok: false, error: 'User configuration is not running.' }
    if (!this.snapshot.commands.some((command) => command.id === commandId)) {
      return { ok: false, error: `Unknown user command "${commandId}".` }
    }
    try {
      const response = await active.invoke(commandId, context)
      this.runtimeRecoveryUsed = false
      return response
    } catch (error) {
      if (this.active === active) {
        active.terminate()
        this.active = null
        this.publishError(errorText(error))
      }
      this.scheduleRuntimeRecovery()
      return { ok: false, error: errorText(error) }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.watchTimer) clearTimeout(this.watchTimer)
    this.watchTimer = null
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer)
    this.recoveryTimer = null
    this.candidate?.terminate()
    this.candidate = null
    this.active?.terminate()
    this.active = null
    const watcher = this.watcher
    this.watcher = null
    this.watchedDependencies.clear()
    await watcher?.close().catch(() => {})
  }

  private async reloadNow(): Promise<UserConfigSnapshot> {
    if (this.stopped) return this.getSnapshot()
    let candidate: WorkerConnection | null = null
    try {
      const child = utilityProcess.fork(this.options.workerPath, [], {
        serviceName: 'ZenNotes User Config',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      candidate = new WorkerConnection(child)
      this.candidate = candidate
      const ready = await candidate.load(this.options.configPath)
      if (!candidate.isRunning()) throw new Error('User config process exited during startup.')
      if (this.stopped) {
        candidate.terminate()
        if (this.candidate === candidate) this.candidate = null
        return this.getSnapshot()
      }

      const previous = this.active
      this.active = candidate
      this.candidate = null
      candidate.setUnexpectedExitHandler((error) => {
        if (this.active !== candidate) return
        this.active = null
        this.publishError(errorText(error))
        this.scheduleRuntimeRecovery()
      })
      previous?.terminate()

      this.updateWatchedDependencies(ready.dependencies)

      this.snapshot = {
        revision: this.snapshot.revision + 1,
        snippetRevision: this.snapshot.snippetRevision + 1,
        configPath: this.options.configPath,
        mappings: ready.mappings,
        commands: ready.commands,
        snippets: ready.snippets,
        snippetDiagnostics: ready.snippetDiagnostics,
        snippetKeys: ready.snippetKeys,
        error: null
      }
      this.publish()
    } catch (error) {
      candidate?.terminate()
      if (this.candidate === candidate) this.candidate = null
      if (!this.stopped) this.publishError(errorText(error))
    }
    return this.getSnapshot()
  }

  private startWatching(): void {
    void this.watcher?.close().catch(() => {})
    this.watchedDependencies.clear()
    this.watcher = chokidar.watch(this.options.configPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
    })
    const schedule = (): void => {
      if (this.watchTimer) clearTimeout(this.watchTimer)
      this.watchTimer = setTimeout(() => {
        this.watchTimer = null
        void this.reload()
      }, WATCH_DEBOUNCE_MS)
    }
    this.watcher.on('add', schedule).on('change', schedule).on('unlink', schedule)
  }

  private updateWatchedDependencies(dependencies: string[]): void {
    const watcher = this.watcher
    if (!watcher) return
    const configPath = path.resolve(this.options.configPath)
    const next = new Set(
      dependencies
        .map((dependency) => path.resolve(dependency))
        .filter((dependency) => dependency !== configPath)
    )
    const removed = [...this.watchedDependencies].filter((dependency) => !next.has(dependency))
    const added = [...next].filter((dependency) => !this.watchedDependencies.has(dependency))
    if (removed.length) void watcher.unwatch(removed)
    if (added.length) watcher.add(added)
    this.watchedDependencies = next
  }

  private scheduleRuntimeRecovery(): void {
    if (this.stopped || this.runtimeRecoveryUsed || this.recoveryTimer) return
    this.runtimeRecoveryUsed = true
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      void this.enqueueReload()
    }, RUNTIME_RECOVERY_DELAY_MS)
  }

  private async ensureStarterFile(): Promise<void> {
    try {
      await fs.writeFile(this.options.configPath, DEFAULT_USER_CONFIG_SOURCE, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      })
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        (error as NodeJS.ErrnoException).code !== 'EEXIST'
      ) {
        throw error
      }
    }
  }

  private publishError(error: string): void {
    this.snapshot = {
      ...this.snapshot,
      revision: this.snapshot.revision + 1,
      error
    }
    this.publish()
  }

  private publish(): void {
    this.options.onChange?.(this.getSnapshot())
  }
}
