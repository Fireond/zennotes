// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it } from 'vitest'
import { invokeVimFlashTarget } from './cm-vim-flash-motion'

describe('resolved Flash target Vim motion', () => {
  const views: EditorView[] = []

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
    document.body.replaceChildren()
  })

  function mount(doc: string, anchor = 0, withVim = true): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: withVim ? [vim()] : []
      })
    })
    views.push(view)
    view.focus()
    return view
  }

  function press(view: EditorView, key: string): void {
    const cm = getCM(view)
    if (!cm) throw new Error('missing Vim adapter')
    Vim.handleKey(cm, key, 'user')
  }

  it('moves to an arbitrary cross-line target in normal mode', () => {
    const view = mount('alpha\nbeta\ngamma')

    expect(invokeVimFlashTarget(view, 13)).toBe(true)

    expect(view.state.selection.main).toMatchObject({ anchor: 13, head: 13 })
  })

  it('extends the existing visual selection through the target', () => {
    const view = mount('abcdef')
    press(view, 'v')

    expect(invokeVimFlashTarget(view, 3)).toBe(true)

    // Vim's characterwise visual selection includes the character under head.
    expect(view.state.selection.main).toMatchObject({ from: 0, to: 4 })
  })

  it('completes a pending operator through the resolved motion', () => {
    const view = mount('abcdef')
    press(view, 'd')

    expect(invokeVimFlashTarget(view, 3, { inclusive: true })).toBe(true)

    expect(view.state.doc.toString()).toBe('ef')
    expect(view.state.selection.main.head).toBe(0)
  })

  it('preserves an operator-pending count until the target is invoked', () => {
    const view = mount('abcdef')
    press(view, 'd')
    press(view, '2')

    expect(invokeVimFlashTarget(view, 2)).toBe(true)

    expect(view.state.doc.toString()).toBe('cdef')
    const cm = getCM(view) as unknown as {
      state?: {
        vim?: { inputState?: { getRepeat?: () => number; operator?: unknown } }
      }
    }
    expect(cm.state?.vim?.inputState?.getRepeat?.()).toBe(0)
    expect(cm.state?.vim?.inputState?.operator).toBeFalsy()
  })

  it('supports a backward pending operator with inferred direction', () => {
    const view = mount('abcdef', 5)
    press(view, 'd')

    expect(invokeVimFlashTarget(view, 2)).toBe(true)

    expect(view.state.doc.toString()).toBe('abf')
    expect(view.state.selection.main.head).toBe(2)
  })

  it('consumes a failed pending operator through a no-op target without editing', () => {
    const view = mount('abcdef', 5)
    press(view, 'd')

    expect(
      invokeVimFlashTarget(view, 5, { forward: true, inclusive: false })
    ).toBe(true)

    expect(view.state.doc.toString()).toBe('abcdef')
    const cm = getCM(view)
    expect(cm?.state.vim?.inputState.operator).toBeFalsy()
  })

  it('rejects insert-mode and non-Vim editors without moving them', () => {
    const insert = mount('abcdef')
    press(insert, 'i')
    expect(invokeVimFlashTarget(insert, 4)).toBe(false)
    expect(insert.state.selection.main.head).toBe(0)

    const plain = mount('abcdef', 0, false)
    expect(invokeVimFlashTarget(plain, 4)).toBe(false)
    expect(plain.state.selection.main.head).toBe(0)
  })
})
