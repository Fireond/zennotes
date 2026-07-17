import type { Extension } from '@codemirror/state'
import type { Command, EditorView } from '@codemirror/view'
import { Vim, getCM } from '@replit/codemirror-vim'
import type {
  UserSnippet,
  UserSnippetDiagnostic,
  UserSnippetKeybindings
} from '@bridge-contract/user-config'
import { useStore } from '../store'
import {
  clearUserSnippetSession,
  expandOrJumpUserSnippet,
  nextUserSnippetChoice,
  previousUserSnippetChoice,
  previousUserSnippetField,
  storeUserSnippetSelection,
  userSnippetExtension
} from './cm-user-snippets'
import type { UserVimMappingRegistration } from './user-vim-keymaps'
import { isEditorInsertMode } from './vim-nav'

/** Renderer-local command IDs used by LuaSnip-derived Vim mappings. */
export const USER_SNIPPET_COMMAND_IDS = Object.freeze({
  expandOrJump: 'editor.snippet.expand-or-jump',
  jumpBackward: 'editor.snippet.jump-backward',
  nextChoice: 'editor.snippet.choice-next',
  previousChoice: 'editor.snippet.choice-previous',
  storeSelection: 'editor.snippet.store-selection'
})

const LOCAL_SNIPPET_COMMANDS: Readonly<Record<string, Command>> = Object.freeze({
  [USER_SNIPPET_COMMAND_IDS.expandOrJump]: expandOrJumpUserSnippet,
  [USER_SNIPPET_COMMAND_IDS.jumpBackward]: previousUserSnippetField,
  [USER_SNIPPET_COMMAND_IDS.nextChoice]: nextUserSnippetChoice,
  [USER_SNIPPET_COMMAND_IDS.previousChoice]: previousUserSnippetChoice,
  [USER_SNIPPET_COMMAND_IDS.storeSelection]: storeUserSnippetSelection
})

/**
 * Main-editor wrapper around the pure snippet engine.
 *
 * The predicate reads current app/Vim state for every attempted expansion, so
 * toggling Vim does not require rebuilding the extension. User snippets are
 * intentionally independent of the built-in Markdown delimiter-auto-close
 * preference.
 */
export function appUserSnippetExtension(
  snippets: readonly UserSnippet[]
): Extension {
  return userSnippetExtension(snippets, {
    shouldHandle: (view) => {
      const state = useStore.getState()
      return !state.vimMode || isEditorInsertMode(view, state.vimMode)
    }
  })
}

function commandMapping(
  mode: 'i' | 'v',
  lhs: string | null,
  commandId: string
): UserVimMappingRegistration | null {
  if (!lhs) return null
  return {
    mode,
    lhs,
    target: { type: 'command', commandId }
  }
}

/** Convert imported LuaSnip control keys into renderer-local Vim commands. */
export function snippetKeyMappings(
  keys: UserSnippetKeybindings | null | undefined
): UserVimMappingRegistration[] {
  if (!keys) return []
  return [
    commandMapping('i', keys.expandOrJump, USER_SNIPPET_COMMAND_IDS.expandOrJump),
    commandMapping('i', keys.jumpBackward, USER_SNIPPET_COMMAND_IDS.jumpBackward),
    commandMapping('i', keys.nextChoice, USER_SNIPPET_COMMAND_IDS.nextChoice),
    commandMapping('i', keys.previousChoice, USER_SNIPPET_COMMAND_IDS.previousChoice),
    commandMapping('v', keys.storeSelection, USER_SNIPPET_COMMAND_IDS.storeSelection)
  ].filter((mapping): mapping is UserVimMappingRegistration => mapping !== null)
}

/**
 * Snippet-derived mappings are defaults. Explicit init.mjs mappings are later
 * in the list so applyUserVimMappings' last declaration for a mode/lhs wins.
 */
export function mergeSnippetKeyMappings(
  keys: UserSnippetKeybindings | null | undefined,
  explicit: readonly UserVimMappingRegistration[]
): UserVimMappingRegistration[] {
  return [...snippetKeyMappings(keys), ...explicit]
}

/**
 * Execute a reserved snippet command in the originating CodeMirror view.
 * Returns false only when the ID is not one of the renderer-local commands.
 */
export function runLocalUserSnippetCommand(
  commandId: string,
  view: EditorView
): boolean {
  const command = LOCAL_SNIPPET_COMMANDS[commandId]
  if (!command) return false
  // A configured mapping owns its key even when there is currently no matching
  // snippet/field/choice, matching LuaSnip's no-op control mappings.
  const applied = command(view)
  if (commandId === USER_SNIPPET_COMMAND_IDS.storeSelection && applied) {
    const cm = getCM(view)
    if (cm?.state.vim?.visualMode) {
      // LuaSnip's selection-storage mapping cuts the visual selection and
      // enters Insert mode at its start. Let CodeMirror-Vim's visual `c`
      // perform that transition so its cursor/register bookkeeping stays
      // consistent; the engine has already copied the selected text above.
      Vim.handleKey(cm, 'c', 'user')
    }
  }
  return true
}

/** Leave Vim insert mode without retaining stale snippet-field state. */
export function exitVimInsertModeWithSnippetCleanup(view: EditorView): boolean {
  const cm = getCM(view)
  if (!cm?.state.vim?.insertMode) return false
  clearUserSnippetSession(view)
  Vim.exitInsertMode(cm as Parameters<typeof Vim.exitInsertMode>[0], true)
  return true
}

/** Concise, non-fatal import summary suitable for one informational toast. */
export function summarizeSnippetDiagnostics(
  diagnostics: readonly UserSnippetDiagnostic[]
): string | null {
  const first = diagnostics[0]
  if (!first) return null
  const file = first.source.file.split(/[\\/]/).pop() || first.source.file
  const location = `${file}:${first.source.line}`
  const label = diagnostics.length === 1 ? 'diagnostic' : 'diagnostics'
  return `Snippet import: ${diagnostics.length} ${label}. ${location}: ${first.message}`
}
