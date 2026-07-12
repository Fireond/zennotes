// @vitest-environment jsdom

import { EditorState } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import { getCM, vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it } from 'vitest'
import { inlineFormatKeymap } from './cm-inline-format-keymap'

const views: EditorView[] = []

function mount(vimMode: boolean): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: 'text',
      extensions: [vimMode ? vim() : [], inlineFormatKeymap]
    })
  })
  views.push(view)
  view.focus()
  return view
}

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const upper = key.toUpperCase()
  return new KeyboardEvent('keydown', {
    key,
    code: key.length === 1 && /[a-z]/i.test(key) ? `Key${upper}` : key,
    keyCode: key.length === 1 ? upper.charCodeAt(0) : 0,
    bubbles: true,
    cancelable: true,
    ...init
  })
}

function enterVimMode(view: EditorView, key: 'i' | 'v'): void {
  view.contentDOM.dispatchEvent(keydown(key))
}

function runCtrlI(view: EditorView): boolean {
  return runScopeHandlers(view, keydown('i', { ctrlKey: true }), 'editor')
}

const formatCases: Array<{
  name: string
  key: string
  init: KeyboardEventInit
  expected: string
}> = [
  { name: 'bold', key: 'b', init: { ctrlKey: true }, expected: '****text' },
  { name: 'italic', key: 'i', init: { ctrlKey: true }, expected: '**text' },
  { name: 'code', key: 'e', init: { ctrlKey: true }, expected: '``text' },
  {
    name: 'strikethrough',
    key: 's',
    init: { ctrlKey: true, shiftKey: true },
    expected: '~~~~text'
  },
  {
    name: 'highlight',
    key: 'h',
    init: { ctrlKey: true, shiftKey: true },
    expected: '====text'
  },
  { name: 'math', key: 'm', init: { ctrlKey: true, shiftKey: true }, expected: '$$text' },
  { name: 'link', key: 'k', init: { ctrlKey: true }, expected: '[]()text' }
]

afterEach(() => {
  while (views.length) {
    const view = views.pop()!
    view.dom.parentElement?.remove()
    view.destroy()
  }
})

describe('inlineFormatKeymap', () => {
  it.each(formatCases)('applies $name in a non-Vim editor', ({ key, init, expected }) => {
    const view = mount(false)

    expect(runScopeHandlers(view, keydown(key, init), 'editor')).toBe(true)
    expect(view.state.doc.toString()).toBe(expected)
  })

  it('returns false for every format chord without mutating in Vim normal mode', () => {
    for (const { key, init } of formatCases) {
      const view = mount(true)
      expect(getCM(view)?.state.vim?.insertMode).toBe(false)

      expect(runScopeHandlers(view, keydown(key, init), 'editor')).toBe(false)
      expect(view.state.doc.toString()).toBe('text')
    }
  })

  it('returns false without mutating in Vim visual mode', () => {
    const view = mount(true)
    enterVimMode(view, 'v')
    expect(getCM(view)?.state.vim?.visualMode).toBe(true)

    expect(runCtrlI(view)).toBe(false)
    expect(view.state.doc.toString()).toBe('text')
  })

  it('formats from the live Vim insert mode', () => {
    const view = mount(true)
    enterVimMode(view, 'i')
    expect(getCM(view)?.state.vim?.insertMode).toBe(true)

    expect(runCtrlI(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('**text')
  })
})
