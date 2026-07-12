// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import {
  applyUserVimMappings,
  clearUserVimMappings,
  isUserVimEditorTarget
} from './user-vim-keymaps'

describe('user Vim keymaps with codemirror-vim', () => {
  const views: EditorView[] = []

  afterEach(() => {
    clearUserVimMappings()
    views.splice(0).forEach((view) => view.destroy())
    document.body.replaceChildren()
  })

  function mount(doc: string): EditorView {
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: [vim()] }),
      parent: document.body
    })
    views.push(view)
    view.focus()
    return view
  }

  it('recognizes only explicitly scoped main editor targets', () => {
    const main = document.createElement('div')
    main.dataset.userVimConfig = 'true'
    const child = document.createElement('span')
    const secondary = document.createElement('div')
    main.append(child)
    document.body.append(main, secondary)

    expect(isUserVimEditorTarget(child)).toBe(true)
    expect(isUserVimEditorTarget(secondary)).toBe(false)
  })

  function press(
    view: EditorView,
    key: string,
    keyCode: number,
    options: Pick<KeyboardEventInit, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> = {}
  ): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
        keyCode,
        bubbles: true,
        cancelable: true,
        ...options
      })
    )
  }

  it("remaps normal-mode H to Vim's first-nonblank motion", () => {
    applyUserVimMappings(
      [{ mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^' } }],
      { runCommand: vi.fn() }
    )
    const view = mount('  alpha')
    view.dispatch({ selection: { anchor: 5 } })

    press(view, 'H', 72)

    expect(view.state.selection.main.head).toBe(2)
  })

  it('can disable a built-in normal-mode key', () => {
    applyUserVimMappings([{ mode: 'n', lhs: 'x', target: { type: 'disabled' } }], {
      runCommand: vi.fn()
    })
    const view = mount('abc')

    press(view, 'x', 88)

    expect(view.state.doc.toString()).toBe('abc')

    clearUserVimMappings()
    press(view, 'x', 88)
    expect(view.state.doc.toString()).toBe('bc')
  })

  it('dispatches a command target from the active editor', () => {
    const runCommand = vi.fn()
    applyUserVimMappings(
      [{ mode: 'n', lhs: 'X', target: { type: 'command', commandId: 'tab.close' } }],
      { runCommand }
    )
    const view = mount('abc')

    press(view, 'X', 88)

    expect(runCommand).toHaveBeenCalledOnce()
    expect(runCommand.mock.calls[0]?.[0]).toMatchObject({
      commandId: 'tab.close',
      mode: 'n',
      lhs: 'X'
    })
  })

  it('dispatches a visual command with the selected text still available', () => {
    let selected = ''
    const runCommand = vi.fn((invocation: { cm: unknown }) => {
      const cm = invocation.cm as { cm6?: EditorView }
      const view = cm.cm6
      if (!view) return
      const range = view.state.selection.main
      selected = view.state.sliceDoc(range.from, range.to)
    })
    applyUserVimMappings(
      [{ mode: 'v', lhs: 'U', target: { type: 'command', commandId: 'user.upper' } }],
      { runCommand }
    )
    const view = mount('abc def')

    press(view, 'v', 86)
    press(view, 'l', 76)
    press(view, 'l', 76)
    press(view, 'U', 85, { shiftKey: true })

    expect(runCommand).toHaveBeenCalledOnce()
    expect(runCommand.mock.calls[0]?.[0]).toMatchObject({ mode: 'v' })
    expect(selected).toBe('abc')
  })

  it('can replace Vim\'s Ctrl+W prefix with an app command', () => {
    const runCommand = vi.fn()
    applyUserVimMappings(
      [{ mode: 'n', lhs: '<C-w>', target: { type: 'command', commandId: 'tab.close' } }],
      { runCommand }
    )
    const view = mount('abc')

    press(view, 'w', 87, { ctrlKey: true })

    expect(runCommand).toHaveBeenCalledOnce()
    expect(runCommand.mock.calls[0]?.[0]).toMatchObject({
      commandId: 'tab.close',
      mode: 'n',
      lhs: '<C-w>'
    })
  })
})
