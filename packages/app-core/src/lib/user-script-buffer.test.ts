// @vitest-environment jsdom

import { history, undo } from '@codemirror/commands'
import {
  EditorSelection,
  EditorState,
  type EditorStateConfig,
  type Extension
} from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyUserScriptResult,
  createUserScriptBufferSnapshot,
  validateUserScriptResult,
  type UserScriptBufferSnapshot
} from './user-script-buffer'

const views: EditorView[] = []

function mount(
  doc = 'one\ntwo\nthree',
  selection: EditorStateConfig['selection'] = EditorSelection.range(4, 7),
  extensions: Extension = []
): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({ doc, selection, extensions })
  })
  views.push(view)
  return view
}

function snapshot(view: EditorView, version = 3): UserScriptBufferSnapshot {
  return createUserScriptBufferSnapshot(view, {
    path: '/vault/note.md',
    version,
    vim: { mode: 'visual', count: 2, register: 'a' }
  })
}

afterEach(() => {
  while (views.length) views.pop()!.destroy()
  document.body.replaceChildren()
})

describe('createUserScriptBufferSnapshot', () => {
  it('captures immutable buffer, selection, cursor, and Vim state', () => {
    const view = mount()
    const value = snapshot(view)

    expect(value).toEqual({
      path: '/vault/note.md',
      text: 'one\ntwo\nthree',
      version: 3,
      selections: [{ anchor: 4, head: 7, from: 4, to: 7 }],
      cursor: { offset: 7, line: 2, column: 3 },
      vim: { mode: 'visual', count: 2, register: 'a' }
    })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.selections)).toBe(true)
    expect(Object.isFrozen(value.selections[0])).toBe(true)
    expect(Object.isFrozen(value.cursor)).toBe(true)
    expect(Object.isFrozen(value.vim)).toBe(true)
  })

  it('preserves anchor/head direction and all selections', () => {
    const view = mount(
      'abcdef',
      EditorSelection.create([EditorSelection.range(4, 1), EditorSelection.cursor(6)], 1),
      [EditorState.allowMultipleSelections.of(true)]
    )

    expect(snapshot(view).selections).toEqual([
      { anchor: 4, head: 1, from: 1, to: 4 },
      { anchor: 6, head: 6, from: 6, to: 6 }
    ])
    expect(snapshot(view).cursor).toEqual({ offset: 6, line: 1, column: 6 })
  })

  it('rejects invalid versions', () => {
    const view = mount()
    expect(() =>
      createUserScriptBufferSnapshot(view, {
        path: '/vault/note.md',
        version: -1,
        vim: { mode: 'normal', count: null, register: null }
      })
    ).toThrow(RangeError)
  })
})

describe('validateUserScriptResult', () => {
  it('normalizes unsorted edits and validates selection against the resulting document', () => {
    const view = mount('abcdef', EditorSelection.cursor(0))
    const value = snapshot(view)
    const outcome = validateUserScriptResult(value, 3, {
      edits: [
        { from: 4, to: 6, insert: 'Z' },
        { from: 0, to: 1, insert: 'XX' }
      ],
      selection: { anchor: 6 },
      message: 'done'
    })

    expect(outcome).toEqual({
      ok: true,
      value: {
        edits: [
          { from: 0, to: 1, insert: 'XX' },
          { from: 4, to: 6, insert: 'Z' }
        ],
        selection: { anchor: 6, head: 6 },
        message: 'done',
        resultingDocumentLength: 6
      }
    })
  })

  it('accepts null output as an empty command result', () => {
    const value = snapshot(mount())
    expect(validateUserScriptResult(value, 3, null)).toMatchObject({
      ok: true,
      value: { edits: [], selection: 'preserve', resultingDocumentLength: value.text.length }
    })
  })

  it('rejects stale versions', () => {
    const value = snapshot(mount())
    expect(validateUserScriptResult(value, 4, {})).toMatchObject({
      ok: false,
      error: { code: 'stale-buffer' }
    })
  })

  it.each([
    [{ edits: 'nope' }, 'invalid-result'],
    [{ edits: [{ from: -1, to: 1, insert: 'x' }] }, 'edit-out-of-bounds'],
    [{ edits: [{ from: 2, to: 1, insert: 'x' }] }, 'edit-out-of-bounds'],
    [{ edits: [{ from: 0, to: 99, insert: 'x' }] }, 'edit-out-of-bounds'],
    [{ edits: [{ from: 0, to: 1, insert: 4 }] }, 'invalid-result'],
    [
      {
        edits: [
          { from: 0, to: 3, insert: 'x' },
          { from: 2, to: 4, insert: 'y' }
        ]
      },
      'overlapping-edits'
    ],
    [
      {
        edits: [
          { from: 2, to: 2, insert: 'x' },
          { from: 2, to: 2, insert: 'y' }
        ]
      },
      'overlapping-edits'
    ],
    [{ selection: { anchor: 99 } }, 'invalid-selection'],
    [{ message: 4 }, 'invalid-result']
  ])('rejects malformed or ambiguous result %#', (result, code) => {
    expect(validateUserScriptResult(snapshot(mount()), 3, result)).toMatchObject({
      ok: false,
      error: { code }
    })
  })

  it('enforces configurable output limits', () => {
    const value = snapshot(mount())

    expect(
      validateUserScriptResult(
        value,
        3,
        { edits: [{ from: 0, to: 0, insert: 'xx' }] },
        { maxEdits: 1, maxInsertedTextLength: 1, maxMessageLength: 2 }
      )
    ).toMatchObject({ ok: false, error: { code: 'output-too-large' } })
    expect(
      validateUserScriptResult(
        value,
        3,
        { edits: [{ from: 0, to: 0, insert: '' }, { from: 1, to: 1, insert: '' }] },
        { maxEdits: 1, maxInsertedTextLength: 1, maxMessageLength: 2 }
      )
    ).toMatchObject({ ok: false, error: { code: 'too-many-edits' } })
    expect(
      validateUserScriptResult(value, 3, { message: 'long' }, {
        maxEdits: 1,
        maxInsertedTextLength: 1,
        maxMessageLength: 2
      })
    ).toMatchObject({ ok: false, error: { code: 'message-too-large' } })
  })
})

describe('applyUserScriptResult', () => {
  it('applies all edits and selection in one normal editor update', () => {
    const listener = vi.fn()
    const view = mount('abc def', EditorSelection.range(0, 3), [
      EditorView.updateListener.of(listener)
    ])
    listener.mockClear()
    const value = snapshot(view, 8)

    const outcome = applyUserScriptResult(view, value, 8, {
      edits: [{ from: 0, to: 3, insert: 'ABC' }],
      selection: { anchor: 0, head: 3 },
      message: 'Uppercased selection'
    })

    expect(outcome).toEqual({ ok: true, applied: true, message: 'Uppercased selection' })
    expect(view.state.doc.toString()).toBe('ABC def')
    expect(view.state.selection.main).toMatchObject({ anchor: 0, head: 3 })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].transactions).toHaveLength(1)
    expect(listener.mock.calls[0][0].transactions[0].isUserEvent('input.user-script')).toBe(true)
  })

  it('maps an existing selection when selection is preserved', () => {
    const view = mount('abc', EditorSelection.range(1, 3))
    const value = snapshot(view)

    expect(
      applyUserScriptResult(view, value, 3, {
        edits: [{ from: 0, to: 0, insert: '!' }],
        selection: 'preserve'
      })
    ).toMatchObject({ ok: true, applied: true })
    expect(view.state.selection.main).toMatchObject({ anchor: 2, head: 4 })
  })

  it('creates one undoable history event', () => {
    const view = mount('abc', EditorSelection.range(0, 3), [history()])
    const value = snapshot(view)

    applyUserScriptResult(view, value, 3, {
      edits: [{ from: 0, to: 3, insert: 'ABC' }]
    })
    expect(view.state.doc.toString()).toBe('ABC')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('abc')
  })

  it('rejects a changed view even if the caller supplies the old version', () => {
    const view = mount('abc', EditorSelection.cursor(0))
    const value = snapshot(view)
    view.dispatch({ changes: { from: 3, insert: '!' } })

    expect(
      applyUserScriptResult(view, value, 3, {
        edits: [{ from: 0, to: 1, insert: 'A' }]
      })
    ).toMatchObject({ ok: false, error: { code: 'stale-buffer' } })
    expect(view.state.doc.toString()).toBe('abc!')
  })

  it('does not dispatch for an empty result but still returns its message', () => {
    const listener = vi.fn()
    const view = mount('abc', EditorSelection.cursor(0), [EditorView.updateListener.of(listener)])
    listener.mockClear()

    expect(applyUserScriptResult(view, snapshot(view), 3, { message: 'Nothing to do' })).toEqual({
      ok: true,
      applied: false,
      message: 'Nothing to do'
    })
    expect(listener).not.toHaveBeenCalled()
  })
})
