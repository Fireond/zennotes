// @vitest-environment jsdom

import { EditorSelection, EditorState, Transaction } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { getCM, vim } from '@replit/codemirror-vim'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserSnippet, UserSnippetNode } from '@bridge-contract/user-config'

const mocks = vi.hoisted(() => ({ state: { vimMode: false } }))

vi.mock('../store', () => ({
  useStore: { getState: () => mocks.state }
}))

import {
  handleUserSnippetInput,
  userSnippetExtension,
  userSnippetSessionDepth
} from './cm-user-snippets'
import {
  USER_SNIPPET_COMMAND_IDS,
  appUserSnippetExtension,
  exitVimInsertModeWithSnippetCleanup,
  mergeSnippetKeyMappings,
  runLocalUserSnippetCommand,
  snippetKeyMappings,
  summarizeSnippetDiagnostics
} from './user-snippet-integration'

const views: EditorView[] = []

function snippet(
  trigger: string,
  body: UserSnippetNode[],
  auto = false
): UserSnippet {
  return {
    id: `test:${trigger}`,
    trigger: { kind: 'literal', value: trigger },
    auto,
    wordTrig: false,
    priority: 1000,
    order: 0,
    source: { file: 'test.lua', line: 1 },
    context: { type: 'always' },
    body
  }
}

function mount(doc: string, extensions = userSnippetExtension([])): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions
    })
  })
  views.push(view)
  view.focus()
  return view
}

function press(view: EditorView, key: string, keyCode: number, shiftKey = false): void {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      keyCode,
      shiftKey,
      bubbles: true,
      cancelable: true
    })
  )
}

function tryTypedInput(view: EditorView, text: string): boolean {
  const from = view.state.selection.main.head
  const insert = () =>
    view.state.update({
      changes: { from, insert: text },
      selection: { anchor: from + text.length },
      annotations: Transaction.userEvent.of('input.type')
    })
  return handleUserSnippetInput(view, from, from, text, insert)
}

beforeEach(() => {
  mocks.state.vimMode = false
})

afterEach(() => {
  while (views.length) views.pop()!.destroy()
  document.body.replaceChildren()
})

describe('user snippet editor integration', () => {
  it('derives insert/visual mappings and keeps explicit mappings last', () => {
    const keys = {
      expandOrJump: 'fj',
      jumpBackward: 'fk',
      nextChoice: '<C-h>',
      previousChoice: '<C-p>',
      storeSelection: '`'
    }
    const derived = snippetKeyMappings(keys)

    expect(derived.map(({ mode, lhs, target }) => [mode, lhs, target])).toEqual([
      ['i', 'fj', { type: 'command', commandId: USER_SNIPPET_COMMAND_IDS.expandOrJump }],
      ['i', 'fk', { type: 'command', commandId: USER_SNIPPET_COMMAND_IDS.jumpBackward }],
      ['i', '<C-h>', { type: 'command', commandId: USER_SNIPPET_COMMAND_IDS.nextChoice }],
      ['i', '<C-p>', { type: 'command', commandId: USER_SNIPPET_COMMAND_IDS.previousChoice }],
      ['v', '`', { type: 'command', commandId: USER_SNIPPET_COMMAND_IDS.storeSelection }]
    ])

    const explicit = {
      mode: 'i' as const,
      lhs: 'fj',
      target: { type: 'keys' as const, keys: '<Esc>', recursive: false }
    }
    expect(mergeSnippetKeyMappings(keys, [explicit]).at(-1)).toEqual(explicit)
  })

  it('expands automatically only while app text input is active', () => {
    const auto = snippet('aa', [{ type: 'text', text: 'AUTO' }], true)
    const plain = mount('', appUserSnippetExtension([auto]))

    expect(tryTypedInput(plain, 'aa')).toBe(true)
    expect(plain.state.doc.toString()).toBe('AUTO')

    mocks.state.vimMode = true
    const vimView = mount('', [vim(), appUserSnippetExtension([auto])])
    expect(tryTypedInput(vimView, 'aa')).toBe(false)

    press(vimView, 'i', 73)
    expect(getCM(vimView)?.state.vim?.insertMode).toBe(true)
    expect(tryTypedInput(vimView, 'aa')).toBe(true)
    expect(vimView.state.doc.toString()).toBe('AUTO')
  })

  it('routes local expansion without host IPC and clears a session before Vim exits insert mode', () => {
    const manual = snippet('xx', [
      { type: 'text', text: '(' },
      { type: 'insert', index: 1 },
      { type: 'text', text: ')' }
    ])
    const view = mount('xx', [vim(), userSnippetExtension([manual])])
    press(view, 'i', 73)

    expect(
      runLocalUserSnippetCommand(USER_SNIPPET_COMMAND_IDS.expandOrJump, view)
    ).toBe(true)
    expect(view.state.doc.toString()).toBe('()')
    expect(userSnippetSessionDepth(view.state)).toBe(1)

    expect(exitVimInsertModeWithSnippetCleanup(view)).toBe(true)
    expect(getCM(view)?.state.vim?.insertMode).toBe(false)
    expect(userSnippetSessionDepth(view.state)).toBe(0)
  })

  it('cuts a stored visual selection, enters insert mode, and reuses it in a snippet', () => {
    const wrapped = snippet('w', [
      { type: 'text', text: '[' },
      {
        type: 'selected',
        index: 1,
        whenSelected: 'text',
        whenEmpty: 'insert'
      },
      { type: 'text', text: ']' }
    ])
    const view = mount('abc', [vim(), userSnippetExtension([wrapped])])
    view.dispatch({ selection: EditorSelection.cursor(0) })
    press(view, 'v', 86)
    press(view, 'l', 76)
    expect(getCM(view)?.state.vim?.visualMode).toBe(true)

    expect(
      runLocalUserSnippetCommand(USER_SNIPPET_COMMAND_IDS.storeSelection, view)
    ).toBe(true)
    expect(getCM(view)?.state.vim?.visualMode).toBe(false)
    expect(getCM(view)?.state.vim?.insertMode).toBe(true)
    expect(view.state.doc.toString()).toBe('c')
    expect(view.state.selection.main.head).toBe(0)

    const insertion = view.state.selection.main.head
    view.dispatch({
      changes: { from: insertion, insert: 'w' },
      selection: { anchor: insertion + 1 }
    })
    runLocalUserSnippetCommand(USER_SNIPPET_COMMAND_IDS.expandOrJump, view)
    expect(view.state.doc.toString()).toBe('[ab]c')
  })

  it('summarizes only the first diagnostic with a compact source', () => {
    expect(
      summarizeSnippetDiagnostics([
        {
          severity: 'warning',
          code: 'unsupported',
          message: 'Skipped arbitrary callback',
          source: { file: '/home/me/snippets/font.lua', line: 42 }
        },
        {
          severity: 'error',
          code: 'undefined',
          message: 'Unknown alias',
          source: { file: '/home/me/snippets/env.lua', line: 7 }
        }
      ])
    ).toBe('Snippet import: 2 diagnostics. font.lua:42: Skipped arbitrary callback')
    expect(summarizeSnippetDiagnostics([])).toBeNull()
  })
})
