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
  const state = {
    activeNote: null,
    bufferPaletteOpen: false,
    commandPaletteOpen: false,
    editorViewRef: null as EditorView | null,
    keymapOverrides: {},
    searchOpen: false,
    settingsOpen: false,
    vaultTextSearchOpen: false,
    vimMode: true,
    whichKeyHintMode: 'timed',
    whichKeyHintTimeoutMs: 1200,
    whichKeyHints: true,
    jumpToPreviousNote,
    jumpToNextNote,
    setFocusedPanel: vi.fn()
  }
  const useStore = Object.assign(
    (selector: (current: typeof state) => unknown) => selector(state),
    { getState: () => state }
  )
  return { jumpToNextNote, jumpToPreviousNote, state, useStore }
})

vi.mock('../store', () => ({
  isTagsViewActive: () => false,
  isTasksViewActive: () => false,
  useStore: mocks.useStore
}))

import { VimNav } from './VimNav'

describe('VimNav note-history precedence', () => {
  let host: HTMLDivElement
  let root: Root
  let editorHost: HTMLDivElement
  let view: EditorView

  beforeEach(async () => {
    vi.clearAllMocks()
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
})
