// @vitest-environment jsdom

import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserCommandInvocation, UserSnippet } from '@bridge-contract/user-config'

const mocks = vi.hoisted(() => {
  const state = {
    activePaneId: 'pane-1',
    selectedPath: 'notes/example.md',
    activeNote: null as { path: string } | null,
    setCommandPaletteOpen: vi.fn(),
    setActivePane: vi.fn((paneId: string) => {
      state.activePaneId = paneId
    })
  }
  return {
    state,
    addToast: vi.fn(),
    commands: [] as Array<{
      id: string
      title: string
      when?: () => boolean
      run: () => void | Promise<void>
    }>
  }
})

vi.mock('../store', () => ({
  useStore: { getState: () => mocks.state }
}))

vi.mock('./commands', () => ({
  buildCommands: () => mocks.commands
}))

vi.mock('./toast', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) }
}))

vi.mock('./user-config-state', () => ({
  isHostedUserCommand: (id: string) => id === 'user.uppercase-selection'
}))

import { executeUserVimCommand } from './user-command-execution'
import { userSnippetExtension } from './cm-user-snippets'
import { USER_SNIPPET_COMMAND_IDS } from './user-snippet-integration'

const views: EditorView[] = []

function mount(scoped = true, extensions: Extension = []): EditorView {
  const pane = document.createElement('div')
  pane.dataset.userVimPaneId = 'pane-2'
  pane.dataset.userVimNotePath = 'notes/example.md'
  if (scoped) pane.dataset.userVimConfig = 'true'
  document.body.append(pane)
  const view = new EditorView({
    parent: pane,
    state: EditorState.create({
      doc: 'abc def',
      selection: EditorSelection.range(0, 3),
      extensions
    })
  })
  views.push(view)
  return view
}

function invocation(view: EditorView) {
  return {
    commandId: 'user.uppercase-selection',
    mode: 'v' as const,
    lhs: '<Space>u',
    count: null,
    register: null,
    cm: { cm6: view }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.activePaneId = 'pane-1'
  mocks.state.selectedPath = 'notes/example.md'
  mocks.commands.length = 0
})

afterEach(() => {
  while (views.length) views.pop()!.destroy()
  document.body.replaceChildren()
})

describe('user command execution', () => {
  it('rejects mappings invoked from secondary Vim editor surfaces', async () => {
    const invokeUserCommand = vi.fn()
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { invokeUserCommand }
    })
    const view = mount(false)

    await expect(executeUserVimCommand(invocation(view))).rejects.toThrow(
      'only available in the main note editor'
    )
    expect(invokeUserCommand).not.toHaveBeenCalled()
  })

  it('routes Settings keymap IDs through the built-in command registry', async () => {
    const run = vi.fn()
    mocks.commands.push({ id: 'tab.close', title: 'Close tab', run })
    const view = mount()

    await executeUserVimCommand({
      ...invocation(view),
      commandId: 'global.closeActiveTab',
      mode: 'n',
      lhs: '<C-w>'
    })

    expect(run).toHaveBeenCalledOnce()
  })

  it('routes vim.flashJump to the stable Flash command', async () => {
    const run = vi.fn()
    mocks.commands.push({ id: 'editor.flash.jump', title: 'Flash Jump', run })
    const view = mount()

    await executeUserVimCommand({
      ...invocation(view),
      commandId: 'vim.flashJump',
      mode: 'n',
      lhs: '<Space>j'
    })

    expect(run).toHaveBeenCalledOnce()
  })

  it('runs reserved snippet commands in the originating editor without host IPC', async () => {
    const manual: UserSnippet = {
      id: 'test:manual',
      trigger: { kind: 'literal', value: 'def' },
      auto: false,
      wordTrig: true,
      priority: 1000,
      order: 0,
      source: { file: 'test.lua', line: 1 },
      context: { type: 'always' },
      body: [{ type: 'text', text: 'expanded' }]
    }
    const invokeUserCommand = vi.fn()
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { invokeUserCommand }
    })
    const view = mount(true, userSnippetExtension([manual]))
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) })

    await executeUserVimCommand({
      ...invocation(view),
      commandId: USER_SNIPPET_COMMAND_IDS.expandOrJump,
      mode: 'i',
      lhs: 'fj'
    })

    expect(view.state.doc.toString()).toBe('abc expanded')
    expect(invokeUserCommand).not.toHaveBeenCalled()
  })

  it('supports the Settings command-palette action directly', async () => {
    const view = mount()

    await executeUserVimCommand({
      ...invocation(view),
      commandId: 'global.commandPalette',
      mode: 'n',
      lhs: '<Space>p'
    })

    expect(mocks.state.setCommandPaletteOpen).toHaveBeenCalledWith(true)
  })

  it('sends an immutable buffer context and applies the declarative result', async () => {
    const invokeUserCommand = vi.fn(async (): Promise<UserCommandInvocation> => ({
      ok: true,
      result: {
        edits: [{ from: 0, to: 3, insert: 'ABC' }],
        selection: 'preserve',
        message: 'Uppercased selection'
      }
    }))
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { invokeUserCommand }
    })
    const view = mount()

    await executeUserVimCommand(invocation(view))

    expect(mocks.state.setActivePane).toHaveBeenCalledWith('pane-2')
    expect(invokeUserCommand).toHaveBeenCalledWith(
      'user.uppercase-selection',
      expect.objectContaining({
        path: 'notes/example.md',
        text: 'abc def',
        selections: [{ from: 0, to: 3 }],
        cursor: { offset: 3, line: 1, column: 3 },
        vim: { mode: 'v', count: null, register: null }
      })
    )
    expect(view.state.doc.toString()).toBe('ABC def')
    expect(mocks.addToast).toHaveBeenCalledWith('Uppercased selection', 'info')
  })

  it('rejects a result when the buffer changes while the script is running', async () => {
    let finish!: (value: UserCommandInvocation) => void
    const invokeUserCommand = vi.fn(
      () => new Promise<UserCommandInvocation>((resolve) => { finish = resolve })
    )
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { invokeUserCommand }
    })
    const view = mount()

    const pending = executeUserVimCommand(invocation(view))
    view.dispatch({ changes: { from: 7, insert: '!' } })
    finish({
      ok: true,
      result: { edits: [{ from: 0, to: 3, insert: 'ABC' }] }
    })

    await expect(pending).rejects.toThrow('buffer text changed')
    expect(view.state.doc.toString()).toBe('abc def!')
  })

  it('rejects a result after its originating editor is detached', async () => {
    let finish!: (value: UserCommandInvocation) => void
    const invokeUserCommand = vi.fn(
      () => new Promise<UserCommandInvocation>((resolve) => { finish = resolve })
    )
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { invokeUserCommand }
    })
    const view = mount()

    const pending = executeUserVimCommand(invocation(view))
    view.dom.closest('[data-user-vim-config]')?.remove()
    finish({
      ok: true,
      result: { edits: [{ from: 0, to: 3, insert: 'ABC' }] }
    })

    await expect(pending).rejects.toThrow('editor was closed')
    expect(view.state.doc.toString()).toBe('abc def')
  })
})
