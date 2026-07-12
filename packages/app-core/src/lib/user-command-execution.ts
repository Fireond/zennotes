import type { EditorView } from '@codemirror/view'
import type {
  UserCommandContext,
  UserCommandInvocation as HostCommandInvocation,
  UserVimMode
} from '@bridge-contract/user-config'
import { buildCommands } from './commands'
import type { KeymapId } from './keymaps'
import { useToastStore } from './toast'
import {
  applyUserScriptResult,
  createUserScriptBufferSnapshot,
  type UserScriptVimMode
} from './user-script-buffer'
import { isHostedUserCommand } from './user-config-state'
import type { UserVimCommandInvocation } from './user-vim-keymaps'
import { USER_VIM_EDITOR_SELECTOR } from './user-vim-keymaps'
import { useStore } from '../store'

interface Cm6Adapter {
  cm6?: EditorView
}

interface BufferVersionState {
  doc: EditorView['state']['doc']
  version: number
}

const bufferVersions = new WeakMap<EditorView, BufferVersionState>()

/** Settings keymap IDs with a direct equivalent in the shared command registry. */
const SETTINGS_KEYMAP_COMMAND_ALIASES: Partial<Record<KeymapId, string>> = {
  'global.searchNotes': 'nav.search',
  'global.searchNotesNonVim': 'nav.search',
  'global.newQuickNote': 'note.new.quick',
  'global.openSettings': 'app.settings',
  'global.toggleSidebar': 'view.toggle.sidebar',
  'global.toggleConnections': 'view.toggle.connections',
  'global.toggleOutlinePanel': 'view.outline-panel',
  'global.toggleCommentsPanel': 'view.comments-panel',
  'global.addComment': 'editor.add-comment',
  'global.focusPaneLeft': 'pane.focus.left',
  'global.focusPaneDown': 'pane.focus.down',
  'global.focusPaneUp': 'pane.focus.up',
  'global.focusPaneRight': 'pane.focus.right',
  'global.modeEdit': 'view.mode.edit',
  'global.modeSplit': 'view.mode.split',
  'global.modePreview': 'view.mode.preview',
  'global.toggleZenMode': 'view.focus-mode',
  'global.closeActiveTab': 'tab.close',
  'global.reopenClosedTab': 'tab.reopen',
  'global.toggleWordWrap': 'editor.word-wrap.toggle',
  'global.exportNotePdf': 'note.export-pdf',
  'global.zoomIn': 'view.zoom.in',
  'global.zoomOut': 'view.zoom.out',
  'global.zoomReset': 'view.zoom.reset',
  'global.historyBack': 'nav.back',
  'global.historyForward': 'nav.forward',
  'vim.leaderOpenBuffers': 'tab.buffers',
  'vim.leaderSearchNotes': 'nav.search',
  'vim.leaderSearchVaultText': 'nav.search-text',
  'vim.leaderToggleSidebar': 'view.toggle.sidebar',
  'vim.leaderNoteOutline': 'nav.outline',
  'vim.leaderSwitchVault': 'app.vault.switch',
  'vim.leaderFormatNote': 'note.format',
  'vim.leaderCopyMarkdown': 'note.copy-markdown',
  'vim.leaderTemplatePicker': 'template.create',
  'vim.leaderInsertTemplate': 'template.insert',
  'vim.leaderDailyNote': 'note.daily.today',
  'vim.leaderWeeklyNote': 'note.weekly.thisWeek',
  'vim.leaderMonthlyNote': 'note.monthly.thisMonth',
  'vim.leaderCalendar': 'view.calendar-panel',
  'vim.paneFocusLeft': 'pane.focus.left',
  'vim.paneFocusDown': 'pane.focus.down',
  'vim.paneFocusUp': 'pane.focus.up',
  'vim.paneFocusRight': 'pane.focus.right',
  'vim.paneSplitRight': 'split.right',
  'vim.paneSplitDown': 'split.down',
  'vim.historyBack': 'nav.back',
  'vim.historyForward': 'nav.forward',
  'vim.foldCurrent': 'fold.heading',
  'vim.unfoldCurrent': 'fold.unfold-heading',
  'vim.foldAll': 'fold.all',
  'vim.unfoldAll': 'fold.unfold-all'
}

export function resolveUserCommandId(commandId: string): string {
  return SETTINGS_KEYMAP_COMMAND_ALIASES[commandId as KeymapId] ?? commandId
}

function currentBufferVersion(view: EditorView): number {
  const current = bufferVersions.get(view)
  if (!current) {
    bufferVersions.set(view, { doc: view.state.doc, version: 1 })
    return 1
  }
  if (current.doc !== view.state.doc) {
    current.doc = view.state.doc
    current.version += 1
  }
  return current.version
}

function scriptMode(mode: UserVimMode): UserScriptVimMode {
  if (mode === 'v') return 'visual'
  if (mode === 'i') return 'insert'
  if (mode === 'o') return 'operatorPending'
  return 'normal'
}

function originatingPane(view: EditorView): HTMLElement | null {
  return view.dom.closest<HTMLElement>(USER_VIM_EDITOR_SELECTOR)
}

function activateOriginatingPane(view: EditorView): string | null {
  const pane = originatingPane(view)
  if (!pane) return null
  const state = useStore.getState()
  const paneId = pane.dataset.userVimPaneId
  if (paneId && paneId !== state.activePaneId) state.setActivePane(paneId)
  return pane.dataset.userVimNotePath || null
}

function assertLiveOriginatingBuffer(view: EditorView, expectedPath: string): void {
  const destroyed = (view as unknown as { destroyed?: boolean }).destroyed === true
  const pane = originatingPane(view)
  if (destroyed || !view.dom.isConnected || !pane) {
    throw new Error('The editor was closed while the user command was running')
  }
  if (pane.dataset.userVimNotePath !== expectedPath) {
    throw new Error('The active note changed while the user command was running')
  }
}

async function invokeHostedCommand(
  view: EditorView,
  invocation: UserVimCommandInvocation,
  path: string
): Promise<void> {
  const bridge = window.zen as typeof window.zen & {
    invokeUserCommand?: (
      id: string,
      context: UserCommandContext
    ) => Promise<HostCommandInvocation>
  }
  if (typeof bridge.invokeUserCommand !== 'function') {
    throw new Error('User scripts are unavailable in this application build')
  }

  const version = currentBufferVersion(view)
  const snapshot = createUserScriptBufferSnapshot(view, {
    path,
    version,
    vim: {
      mode: scriptMode(invocation.mode),
      count: invocation.count,
      register: invocation.register
    }
  })
  const context: UserCommandContext = {
    path: snapshot.path,
    text: snapshot.text,
    version: snapshot.version,
    selections: snapshot.selections.map(({ from, to }) => ({ from, to })),
    cursor: snapshot.cursor,
    vim: {
      mode: invocation.mode,
      count: invocation.count,
      register: invocation.register
    }
  }

  const response = await bridge.invokeUserCommand(invocation.commandId, context)
  if (!response.ok) throw new Error(response.error)
  assertLiveOriginatingBuffer(view, snapshot.path)
  const outcome = applyUserScriptResult(
    view,
    snapshot,
    currentBufferVersion(view),
    response.result
  )
  if (!outcome.ok) throw new Error(outcome.error.message)
  if (outcome.message) useToastStore.getState().addToast(outcome.message, 'info')
  if (view.dom.isConnected) view.focus()
}

/** Execute either a built-in command-palette action or a hosted user command. */
export async function executeUserVimCommand(
  invocation: UserVimCommandInvocation
): Promise<void> {
  const view = (invocation.cm as Cm6Adapter | null)?.cm6
  if (!view) throw new Error(`Vim mapping ${invocation.lhs} has no active editor`)
  const path = activateOriginatingPane(view)
  if (!path) {
    throw new Error('User Vim commands are only available in the main note editor')
  }

  const resolvedCommandId = resolveUserCommandId(invocation.commandId)
  if (invocation.commandId === 'global.commandPalette') {
    useStore.getState().setCommandPaletteOpen(true)
    return
  }
  const builtIn = buildCommands({ includeUnavailable: true }).find(
    (command) => command.id === resolvedCommandId
  )
  if (builtIn) {
    if (builtIn.when && !builtIn.when()) {
      throw new Error(`Command “${builtIn.title}” is unavailable in the current context`)
    }
    await builtIn.run()
    return
  }

  if (isHostedUserCommand(invocation.commandId)) {
    await invokeHostedCommand(view, invocation, path)
    return
  }
  throw new Error(`Unknown command: ${invocation.commandId}`)
}

export function reportUserVimCommandError(
  error: unknown,
  invocation: UserVimCommandInvocation
): void {
  const message = error instanceof Error ? error.message : String(error)
  useToastStore.getState().addToast(
    `User mapping ${invocation.lhs} failed: ${message}`,
    'error'
  )
}
