import { Vim } from '@replit/codemirror-vim'
import { isMacPlatform } from './keymaps'

/** Modes accepted by the user configuration file. */
export type UserVimMappingMode = 'n' | 'v' | 'i' | 'o'

/**
 * A target stays deliberately small and serializable. Command IDs are resolved
 * by the renderer's command registry, which may contain both built-in ZenNotes
 * commands and commands registered by the user-script host.
 */
export type UserVimMappingTarget =
  | { type: 'keys'; keys: string; recursive?: boolean }
  | { type: 'command'; commandId: string }
  | { type: 'disabled' }

export interface UserVimMappingRegistration {
  mode: UserVimMappingMode
  lhs: string
  target: UserVimMappingTarget
}

export interface UserVimCommandInvocation {
  commandId: string
  mode: UserVimMappingMode
  lhs: string
  count: number | null
  register: string | null
  /** The codemirror-vim adapter for the editor that received the mapping. */
  cm: unknown
}

export interface UserVimMappingRuntime {
  runCommand(invocation: UserVimCommandInvocation): void | Promise<void>
  onCommandError?(error: unknown, invocation: UserVimCommandInvocation): void
}

export type UserVimSequenceMatch = 'none' | 'prefix' | 'exact' | 'exact-prefix'

const COMMAND_ACTION = 'zenUserVimCommand'
const DISABLED_ACTION = 'zenUserVimDisabled'
export const USER_VIM_EDITOR_SELECTOR = '[data-user-vim-config="true"]'

export function isUserVimEditorTarget(target: unknown): boolean {
  return target instanceof Element && target.closest(USER_VIM_EDITOR_SELECTOR) !== null
}

const MODE_CONTEXT: Record<UserVimMappingMode, string> = {
  n: 'normal',
  v: 'visual',
  i: 'insert',
  o: 'operatorPending'
}

interface NormalizedMapping extends UserVimMappingRegistration {
  lhs: string
  target: UserVimMappingTarget
  key: string
  lhsTokens: string[]
}

let activeMappings: NormalizedMapping[] = []
let activeByKey = new Map<string, NormalizedMapping>()
let runtime: UserVimMappingRuntime | null = null

function mappingKey(mode: UserVimMappingMode, lhs: string): string {
  return JSON.stringify([mode, lhs])
}

/**
 * Tokenize Vim notation without changing ordinary-key case. Angle-bracket key
 * names are case-insensitive in codemirror-vim, so canonicalize just those.
 */
function vimSequenceTokens(sequence: string): string[] {
  const tokens = sequence.match(/<[^>]+>|./gu) ?? []
  return tokens.map((token) =>
    token.startsWith('<') && token.endsWith('>') ? token.toLowerCase() : token
  )
}

/** codemirror-vim calls the OS Meta/Command modifier M; Neovim calls it D. */
function normalizeVimNotation(sequence: string): string {
  return sequence.trim().replace(/<D-/gi, '<M-')
}

function isTokenPrefix(prefix: readonly string[], sequence: readonly string[]): boolean {
  return prefix.length <= sequence.length && prefix.every((token, index) => token === sequence[index])
}

function assertMode(mode: unknown, index: number): asserts mode is UserVimMappingMode {
  if (mode !== 'n' && mode !== 'v' && mode !== 'i' && mode !== 'o') {
    throw new TypeError(`Vim mapping ${index}: mode must be one of n, v, i, or o`)
  }
}

function normalizeTarget(target: unknown, index: number): UserVimMappingTarget {
  if (!target || typeof target !== 'object' || !('type' in target)) {
    throw new TypeError(`Vim mapping ${index}: target is required`)
  }
  const candidate = target as Record<string, unknown>
  if (candidate.type === 'disabled') return { type: 'disabled' }
  if (candidate.type === 'keys') {
    const keys = typeof candidate.keys === 'string' ? normalizeVimNotation(candidate.keys) : ''
    if (!keys) throw new TypeError(`Vim mapping ${index}: key target must not be empty`)
    if (candidate.recursive !== undefined && typeof candidate.recursive !== 'boolean') {
      throw new TypeError(`Vim mapping ${index}: recursive must be a boolean`)
    }
    return { type: 'keys', keys, recursive: candidate.recursive === true }
  }
  if (candidate.type === 'command') {
    const commandId = typeof candidate.commandId === 'string' ? candidate.commandId.trim() : ''
    if (!commandId) throw new TypeError(`Vim mapping ${index}: command ID must not be empty`)
    return { type: 'command', commandId }
  }
  throw new TypeError(`Vim mapping ${index}: unknown target type`)
}

function normalizeMappings(registrations: readonly UserVimMappingRegistration[]): NormalizedMapping[] {
  const byKey = new Map<string, NormalizedMapping>()
  registrations.forEach((registration, index) => {
    if (!registration || typeof registration !== 'object') {
      throw new TypeError(`Vim mapping ${index}: mapping must be an object`)
    }
    assertMode(registration.mode, index)
    const lhs = typeof registration.lhs === 'string' ? normalizeVimNotation(registration.lhs) : ''
    if (!lhs) throw new TypeError(`Vim mapping ${index}: lhs must not be empty`)
    const lhsTokens = vimSequenceTokens(lhs)
    if (lhsTokens.length === 0) throw new TypeError(`Vim mapping ${index}: lhs must not be empty`)
    const key = mappingKey(registration.mode, lhs)
    const normalized: NormalizedMapping = {
      mode: registration.mode,
      lhs,
      target: normalizeTarget(registration.target, index),
      key,
      lhsTokens
    }

    // Match Vim's config semantics: a later mapping of the same lhs and mode
    // replaces the earlier one. Moving it also preserves declaration order for
    // installation, where the last installed mapping has highest precedence.
    byKey.delete(key)
    byKey.set(key, normalized)
  })
  return [...byKey.values()]
}

function reportCommandError(
  error: unknown,
  invocation: UserVimCommandInvocation,
  commandRuntime: UserVimMappingRuntime
): void {
  if (commandRuntime.onCommandError) {
    commandRuntime.onCommandError(error, invocation)
    return
  }
  console.error(`User Vim command failed: ${invocation.commandId}`, error)
}

function registerActions(): void {
  // defineAction replaces an action with the same name. Re-registering on each
  // apply is intentional: codemirror-vim is a renderer singleton that survives
  // Vite HMR while this module's closures do not.
  Vim.defineAction(COMMAND_ACTION, (cm: unknown, args: unknown) => {
    const actionArgs = args as
      | {
          zenUserVimMappingKey?: unknown
          repeat?: unknown
          repeatIsExplicit?: unknown
          registerName?: unknown
        }
      | undefined
    const key = actionArgs?.zenUserVimMappingKey
    if (typeof key !== 'string') return
    const mapping = activeByKey.get(key)
    if (!mapping || mapping.target.type !== 'command' || !runtime) return
    const commandRuntime = runtime
    const invocation: UserVimCommandInvocation = {
      commandId: mapping.target.commandId,
      mode: mapping.mode,
      lhs: mapping.lhs,
      count:
        actionArgs?.repeatIsExplicit === true && typeof actionArgs.repeat === 'number'
          ? actionArgs.repeat
          : null,
      register: typeof actionArgs?.registerName === 'string' ? actionArgs.registerName : null,
      cm
    }
    try {
      const result = commandRuntime.runCommand(invocation)
      if (result && typeof (result as PromiseLike<void>).then === 'function') {
        void Promise.resolve(result).catch((error) =>
          reportCommandError(error, invocation, commandRuntime)
        )
      }
    } catch (error) {
      reportCommandError(error, invocation, commandRuntime)
    }
  })
  Vim.defineAction(DISABLED_ACTION, () => {})
}

function installMapping(mapping: NormalizedMapping): void {
  const context = MODE_CONTEXT[mapping.mode]
  if (mapping.target.type === 'keys') {
    if (mapping.target.recursive) Vim.map(mapping.lhs, mapping.target.keys, context)
    else Vim.noremap(mapping.lhs, mapping.target.keys, context)
    return
  }
  Vim.mapCommand(
    mapping.lhs,
    'action',
    mapping.target.type === 'disabled' ? DISABLED_ACTION : COMMAND_ACTION,
    { zenUserVimMappingKey: mapping.key },
    { context }
  )
}

function uninstallMappings(mappings: readonly NormalizedMapping[]): void {
  // Every mode/lhs pair is unique and user mappings are installed last by the
  // integration point, so unmap removes precisely the generation we own.
  for (const mapping of mappings) {
    try {
      Vim.unmap(mapping.lhs, MODE_CONTEXT[mapping.mode])
    } catch {
      /* An absent stale mapping is already clean. */
    }
  }
}

function setActive(mappings: NormalizedMapping[], nextRuntime: UserVimMappingRuntime | null): void {
  activeMappings = mappings
  activeByKey = new Map(mappings.map((mapping) => [mapping.key, mapping]))
  runtime = nextRuntime
}

/**
 * Replace the complete user mapping generation.
 *
 * Validation finishes before any live mapping is changed. If installation
 * unexpectedly fails, the previous generation is restored so a bad config
 * reload cannot leave a half-applied keymap.
 */
export function applyUserVimMappings(
  registrations: readonly UserVimMappingRegistration[],
  nextRuntime: UserVimMappingRuntime
): readonly UserVimMappingRegistration[] {
  const next = normalizeMappings(registrations)
  if (!nextRuntime || typeof nextRuntime.runCommand !== 'function') {
    throw new TypeError('A Vim command runner is required')
  }

  const previous = activeMappings
  const previousRuntime = runtime
  uninstallMappings(previous)
  setActive([], nextRuntime)
  registerActions()
  const installed: NormalizedMapping[] = []
  try {
    for (const mapping of next) {
      installMapping(mapping)
      installed.push(mapping)
    }
    setActive(next, nextRuntime)
  } catch (error) {
    uninstallMappings(installed)
    registerActions()
    previous.forEach(installMapping)
    setActive(previous, previousRuntime)
    throw error
  }
  return getUserVimMappings()
}

/** Remove all mappings owned by the user configuration generation. */
export function clearUserVimMappings(): void {
  uninstallMappings(activeMappings)
  setActive([], null)
}

/** A detached, serializable snapshot suitable for diagnostics. */
export function getUserVimMappings(): readonly UserVimMappingRegistration[] {
  return activeMappings.map(({ mode, lhs, target }) => ({
    mode,
    lhs,
    target: { ...target }
  }))
}

/**
 * Classify a sequence against user-owned lhs values. App-level capture handlers
 * use this before consuming prefixes such as `<C-w>` or the configured leader.
 */
export function getUserVimSequenceMatch(
  mode: UserVimMappingMode,
  sequence: string
): UserVimSequenceMatch {
  const prefix = vimSequenceTokens(sequence.trim())
  if (prefix.length === 0) return 'none'
  let exact = false
  let longer = false
  for (const mapping of activeMappings) {
    if (mapping.mode !== mode || !isTokenPrefix(prefix, mapping.lhsTokens)) continue
    if (prefix.length === mapping.lhsTokens.length) exact = true
    else longer = true
  }
  if (exact && longer) return 'exact-prefix'
  if (exact) return 'exact'
  if (longer) return 'prefix'
  return 'none'
}

export function userVimMappingsOwnPrefix(mode: UserVimMappingMode, sequence: string): boolean {
  return getUserVimSequenceMatch(mode, sequence) !== 'none'
}

/** Convert ZenNotes' portable key token syntax (`Ctrl+W`, `Space`) to Vim notation. */
export function sequenceTokenToVimNotation(token: string | null | undefined): string | null {
  if (!token) return null
  const parts = token.split('+').map((part) => part.trim()).filter(Boolean)
  const base = parts.pop()
  if (!base) return null
  if (parts.length === 0) {
    if (base.length === 1) return base
    const name = base === 'Escape' ? 'Esc' : base.replace(/^Arrow/, '')
    return `<${name}>`
  }
  const modifiers = parts
    .map((part) => {
      if (part === 'Ctrl') return 'C'
      if (part === 'Alt') return 'A'
      if (part === 'Shift') return 'S'
      if (part === 'Meta') return 'M'
      if (part === 'Mod') return isMacPlatform() ? 'M' : 'C'
      return null
    })
    .filter((part) => part !== null)
  const name = base.length === 1 ? base.toLowerCase() : base.replace(/^Arrow/, '')
  return `<${[...modifiers, name].join('-')}>`
}

if (import.meta.hot) {
  import.meta.hot.dispose(clearUserVimMappings)
}
