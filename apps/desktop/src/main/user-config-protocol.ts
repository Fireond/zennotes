import type {
  UserCommandContext,
  UserCommandDescriptor,
  UserCommandInvocation,
  UserSnippet,
  UserSnippetDiagnostic,
  UserSnippetKeybindings,
  UserVimMapping
} from '@zennotes/bridge-contract/user-config'

export type UserConfigHostMessage =
  | { type: 'load'; configPath: string }
  | {
      type: 'invoke'
      requestId: number
      commandId: string
      context: UserCommandContext
    }

export type UserConfigWorkerMessage =
  | {
      type: 'ready'
      mappings: UserVimMapping[]
      commands: UserCommandDescriptor[]
      snippets: UserSnippet[]
      snippetDiagnostics: UserSnippetDiagnostic[]
      snippetKeys: UserSnippetKeybindings
      dependencies: string[]
    }
  | { type: 'load-error'; error: string }
  | {
      type: 'invoke-result'
      requestId: number
      response: UserCommandInvocation
    }

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  return typeof error === 'string' ? error : String(error)
}
