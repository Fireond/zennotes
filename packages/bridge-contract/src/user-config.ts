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

export type UserSnippetContext =
  | { type: 'always' }
  | { type: 'math' }
  | { type: 'text' }
  | { type: 'markdown-math' }
  | { type: 'markdown-text' }
  | { type: 'line-begin' }
  | { type: 'tikzcd' }
  | { type: 'and'; all: UserSnippetContext[] }

export type UserSnippetNode =
  | { type: 'text'; text: string }
  | { type: 'insert'; index: number; default?: string }
  | {
      type: 'choice'
      index: number
      choices: UserSnippetNode[][]
      /** Keep text-only alternatives cyclable without selecting their contents. */
      editable?: boolean
    }
  | { type: 'mirror'; index: number }
  | {
      type: 'capture'
      index: number
      transform?: 'copy' | 'upper' | 'repeat-hashes'
    }
  | {
      type: 'selected'
      index: number
      whenSelected: 'text' | 'insert'
      whenEmpty: 'text' | 'insert'
    }
  | { type: 'date'; format: string }

export interface UserSnippetSource {
  file: string
  line: number
}

export interface UserSnippet {
  id: string
  trigger: {
    kind: 'literal' | 'lua-pattern'
    value: string
  }
  auto: boolean
  wordTrig: boolean
  priority: number
  /** Stable import order used to break otherwise-identical candidates. */
  order: number
  source: UserSnippetSource
  context: UserSnippetContext
  body: UserSnippetNode[]
}

export interface UserSnippetDiagnostic {
  severity: 'warning' | 'error'
  code: string
  message: string
  source: UserSnippetSource
}

export interface UserSnippetKeybindings {
  expandOrJump: string | null
  jumpBackward: string | null
  nextChoice: string | null
  previousChoice: string | null
  storeSelection: string | null
}

export interface UserConfigSnapshot {
  /** Increments whenever a successful or failed reload changes the exposed state. */
  revision: number
  /** Increments only after a successful load of a new snippet generation. */
  snippetRevision: number
  configPath: string
  /** Last successfully loaded mappings. */
  mappings: UserVimMapping[]
  /** Last successfully loaded user-command metadata. */
  commands: UserCommandDescriptor[]
  /** Last successfully loaded declarative snippets. */
  snippets: UserSnippet[]
  /** Non-fatal findings from static snippet imports. */
  snippetDiagnostics: UserSnippetDiagnostic[]
  /** Optional editor bindings for snippet navigation and selection capture. */
  snippetKeys: UserSnippetKeybindings
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

export interface UserLuaSnipImportOptions {
  /** LuaSnip loader root, for example ~/.config/nvim/LuaSnip. */
  root: string
  /** Primary LuaSnip filetype group, for example markdown. */
  filetype: string
  /** Additional inherited groups, matching LuaSnip filetype_extend(). */
  extend?: string[]
  /** Optional snippet-control bindings. Omitted bindings remain unchanged. */
  keys?: Partial<UserSnippetKeybindings>
}

export interface UserLuaSnipImportResult {
  imported: number
  diagnostics: UserSnippetDiagnostic[]
  /** Absolute files/directories that the desktop host will watch for reloads. */
  dependencies: string[]
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
  snippets: {
    /** Statically import a supported LuaSnip subset without executing Lua. */
    importLuaSnip(options: UserLuaSnipImportOptions): Promise<UserLuaSnipImportResult>
  }
}
