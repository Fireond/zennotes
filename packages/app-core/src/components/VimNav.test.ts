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
  const splitPaneWithTab = vi.fn().mockResolvedValue(undefined)
  const state = {
    activeNote: null,
    activePaneId: 'pane-1',
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
    splitPaneWithTab,
    setFocusedPanel: vi.fn()
  }
  const useStore = Object.assign(
    (selector: (current: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
  return {
    closeActiveNote,
    jumpToNextNote,
    jumpToPreviousNote,
    splitPaneWithTab,
    state,
    useStore
  }
})

vi.mock('../store', () => ({
  isTagsViewActive: () => false,
  isTasksViewActive: () => false,
  useStore: mocks.useStore
}))

import { VimNav } from './VimNav'
import { applyUserVimMappings, clearUserVimMappings } from '../lib/user-vim-keymaps'
import { isVimFlashActive, vimFlashExtension } from '../lib/cm-vim-flash'

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
      state: EditorState.create({
        doc: 'hello',
        extensions: [vim(), vimFlashExtension]
      }),
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

  it('starts and consumes the default s Flash binding', () => {
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(isVimFlashActive(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('hello')
  })

  it('lets stock Vim handle s when Flash is explicitly unbound', () => {
    mocks.state.keymapOverrides = { 'vim.flashJump': null }
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(isVimFlashActive(view)).toBe(false)
    // Vim's stock `s` command deletes the character under the cursor and
    // enters insert mode; this proves the Settings action yielded fully.
    expect(view.state.doc.toString()).toBe('ello')
  })

  it('gives an explicit init.mjs s mapping precedence over Flash', () => {
    const runCommand = vi.fn()
    applyUserVimMappings(
      [
        {
          mode: 'n',
          lhs: 's',
          target: { type: 'command', commandId: 'user.flash-override' }
        }
      ],
      { runCommand }
    )
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(runCommand).toHaveBeenCalledOnce()
    expect(isVimFlashActive(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('hello')
  })

  it('starts Flash from a remapped single-key Settings binding', () => {
    mocks.state.keymapOverrides = { 'vim.flashJump': 'x' }
    const event = new KeyboardEvent('keydown', {
      key: 'x',
      code: 'KeyX',
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(isVimFlashActive(view)).toBe(true)
    // Stock Vim `x` would delete `h`; the remapped action consumed it first.
    expect(view.state.doc.toString()).toBe('hello')
  })

  it('lets a pending f motion consume s as its literal character', async () => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'a s s' },
      selection: { anchor: 0 }
    })

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'f',
        code: 'KeyF',
        bubbles: true,
        cancelable: true
      })
    )
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 's',
        code: 'KeyS',
        bubbles: true,
        cancelable: true
      })
    )
    await Promise.resolve()

    expect(view.state.selection.main.head).toBe(2)
    expect(view.state.doc.toString()).toBe('a s s')
  })

  it('keeps the leader search prefix ahead of standalone Flash', async () => {
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      bubbles: true,
      cancelable: true
    })

    await act(async () => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true
        })
      )
      view.contentDOM.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(isVimFlashActive(view)).toBe(false)
  })

  it('keeps Ctrl+W split-down ahead of standalone Flash', () => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'w',
        code: 'KeyW',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(isVimFlashActive(view)).toBe(false)
    expect(mocks.splitPaneWithTab).toHaveBeenCalledWith({
      targetPaneId: 'pane-1',
      edge: 'bottom',
      path: 'inbox/n.md'
    })
  })

  it('allows a numeric Vim count before the Flash binding', () => {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: '2',
        code: 'Digit2',
        bubbles: true,
        cancelable: true
      })
    )
    const event = new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      bubbles: true,
      cancelable: true
    })

    view.contentDOM.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(isVimFlashActive(view)).toBe(true)
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
