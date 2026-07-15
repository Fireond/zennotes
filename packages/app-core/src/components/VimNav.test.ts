// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const jumpToPreviousNote = vi.fn().mockResolvedValue(undefined)
  const jumpToNextNote = vi.fn().mockResolvedValue(undefined)
  const closeActiveNote = vi.fn().mockResolvedValue(undefined)
  const state = {
    activeNote: null,
    bufferPaletteOpen: false,
    commandPaletteOpen: false,
    editorViewRef: null as EditorView | null,
    keymapOverrides: {} as Record<string, string | null>,
    searchOpen: false,
    selectedPath: 'inbox/n.md',
    settingsOpen: false,
    vaultTextSearchOpen: false,
    vimMode: true,
    whichKeyHintMode: 'timed',
    whichKeyHintTimeoutMs: 1200,
    whichKeyHints: true,
    jumpToPreviousNote,
    jumpToNextNote,
    closeActiveNote,
    setFocusedPanel: vi.fn()
  }
  const useStore = Object.assign(
    (selector: (current: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
  return { closeActiveNote, jumpToNextNote, jumpToPreviousNote, state, useStore }
})

vi.mock('../store', () => ({
  isTagsViewActive: () => false,
  isTasksViewActive: () => false,
  useStore: mocks.useStore
}))

import { VimNav } from './VimNav'
import { applyUserVimMappings, clearUserVimMappings } from '../lib/user-vim-keymaps'

describe('VimNav note-history precedence', () => {
  let host: HTMLDivElement
  let root: Root
  let editorHost: HTMLDivElement
  let view: EditorView

  beforeEach(async () => {
    vi.clearAllMocks()
    clearUserVimMappings()
    mocks.state.keymapOverrides = {}
    mocks.state.vimMode = true
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        getAppInfo: () => ({ runtime: 'desktop' }),
        getCapabilities: () => ({
          supportsLocalFilesystemPickers: true,
          supportsRemoteWorkspace: false
        }),
        platformSync: () => 'linux'
      }
    })

    host = document.createElement('div')
    editorHost = document.createElement('div')
    document.body.append(host, editorHost)
    root = createRoot(host)
    view = new EditorView({
      state: EditorState.create({ doc: 'hello', extensions: [vim()] }),
      parent: editorHost
    })
    mocks.state.editorViewRef = view
    view.focus()

    await act(async () => {
      root.render(createElement(VimNav))
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    view.destroy()
    clearUserVimMappings()
    mocks.state.editorViewRef = null
    host.remove()
    editorHost.remove()
  })

  it('routes Ctrl+I to forward note history in Vim normal mode without editing', () => {
    const event = new KeyboardEvent('keydown', {
      key: 'i',
      code: 'KeyI',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(mocks.jumpToNextNote).toHaveBeenCalledOnce()
    expect(mocks.jumpToPreviousNote).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe('hello')
  })

  it('does not route Ctrl+I when forward history is explicitly unbound', () => {
    mocks.state.keymapOverrides = { 'vim.historyForward': null }
    const event = new KeyboardEvent('keydown', {
      key: 'i',
      code: 'KeyI',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(mocks.jumpToNextNote).not.toHaveBeenCalled()
    expect(mocks.jumpToPreviousNote).not.toHaveBeenCalled()
  })

  it('does not route Ctrl+I through note history when Vim mode is disabled', () => {
    mocks.state.vimMode = false
    const event = new KeyboardEvent('keydown', {
      key: 'i',
      code: 'KeyI',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(mocks.jumpToNextNote).not.toHaveBeenCalled()
    expect(mocks.jumpToPreviousNote).not.toHaveBeenCalled()
  })

  it('yields a conflicting key to an explicit user Vim mapping', () => {
    const runCommand = vi.fn()
    applyUserVimMappings(
      [{ mode: 'n', lhs: '<C-i>', target: { type: 'command', commandId: 'user.override' } }],
      { runCommand }
    )
    const event = new KeyboardEvent('keydown', {
      key: 'i',
      code: 'KeyI',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(mocks.jumpToNextNote).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledOnce()
  })

  it('yields every key in a pending user mapping when a later key is an app shortcut', () => {
    const runCommand = vi.fn()
    applyUserVimMappings(
      [{ mode: 'n', lhs: 'g<C-i>', target: { type: 'command', commandId: 'user.sequence' } }],
      { runCommand }
    )

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'g',
        code: 'KeyG',
        bubbles: true,
        cancelable: true
      })
    )
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'i',
        code: 'KeyI',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )

    expect(mocks.jumpToNextNote).not.toHaveBeenCalled()
    expect(runCommand).toHaveBeenCalledOnce()
  })

  it('lets an unbound pane prefix release Ctrl+W to close the active tab', () => {
    mocks.state.keymapOverrides = { 'vim.panePrefix': null }
    const event = new KeyboardEvent('keydown', {
      key: 'w',
      code: 'KeyW',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(mocks.closeActiveNote).toHaveBeenCalledOnce()
  })
})
