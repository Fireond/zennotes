/** Canonical Vim modes understood by the user configuration API. */
export type UserVimMode = 'n' | 'v' | 'i' | 'o'
export type UserVimModeInput =
  | UserVimMode
  | 'normal'
  | 'visual'
  | 'insert'
  | 'operatorPending'

export type UserVimMappingTarget =
  | { type: 'keys'; keys: string; recursive: boolean }
  | { type: 'command'; commandId: string }
  | { type: 'disabled' }

/** A mapping declared by ~/.config/zennotes/init.mjs. */
export interface UserVimMapping {
  mode: UserVimMode
  lhs: string
  target: UserVimMappingTarget
}

/** Only metadata crosses into the renderer; command handlers stay in the host. */
export interface UserCommandDescriptor {
  id: string
  title: string
}

export interface UserConfigSnapshot {
  /** Increments whenever a successful or failed reload changes the exposed state. */
  revision: number
  configPath: string
  /** Last successfully loaded mappings. */
  mappings: UserVimMapping[]
  /** Last successfully loaded user-command metadata. */
  commands: UserCommandDescriptor[]
  /** Most recent load/runtime error. A failed load retains the last good config. */
  error: string | null
}

export interface UserBufferSelection {
  from: number
  to: number
}

export interface UserBufferCursor {
  offset: number
  line: number
  column: number
}

export interface UserCommandContext {
  path: string
  text: string
  version: number
  selections: UserBufferSelection[]
  cursor: UserBufferCursor
  vim: {
    mode: UserVimMode
    count: number | null
    register: string | null
  }
}

export interface UserBufferEdit {
  from: number
  to: number
  insert: string
}

export interface UserCommandSelection {
  anchor: number
  head?: number
}

/** Shared host/renderer limits for one declarative user-command result. */
export const USER_COMMAND_RESULT_LIMITS = Object.freeze({
  maxEdits: 1_000,
  maxInsertedTextLength: 8 * 1024 * 1024,
  maxMessageLength: 4_096
})

/** Declarative changes returned by a trusted user command. */
export interface UserCommandResult {
  edits?: UserBufferEdit[]
  selection?: 'preserve' | UserCommandSelection
  message?: string
}

export type UserCommandInvocation =
  | { ok: true; result: UserCommandResult | null }
  | { ok: false; error: string }

export interface UserKeyTargetOptions {
  recursive?: boolean
  /** Neovim-style inverse alias for recursive; mappings are non-recursive by default. */
  noremap?: boolean
}

export interface UserCommandDefinition {
  id: string
  title?: string
  run(context: UserCommandContext):
    | UserCommandResult
    | null
    | void
    | Promise<UserCommandResult | null | void>
}

export interface UserTransformDefinition {
  id: string
  title?: string
  run(selectedText: string, context: UserCommandContext): string | Promise<string>
}

/** The trusted API passed to the default export of init.mjs. */
export interface UserConfigApi {
  keys(keys: string): Extract<UserVimMappingTarget, { type: 'keys' }>
  command(commandId: string): Extract<UserVimMappingTarget, { type: 'command' }>
  keymap: {
    set(
      mode: UserVimModeInput,
      lhs: string,
      target: string | Exclude<UserVimMappingTarget, { type: 'disabled' }> | null,
      options?: UserKeyTargetOptions
    ): void
    /** Override a Vim binding with a no-op. Equivalent to set(mode, lhs, null). */
    disable(mode: UserVimModeInput, lhs: string): void
    /** Remove a mapping declared earlier during the current setup pass. */
    del(mode: UserVimModeInput, lhs: string): void
  }
  commands: {
    register(definition: UserCommandDefinition): void
    registerTransform(definition: UserTransformDefinition): void
  }
}
