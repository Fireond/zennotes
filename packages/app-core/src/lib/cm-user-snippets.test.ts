// @vitest-environment jsdom

import { history, undo, undoDepth } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState, Transaction, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { vim } from '@replit/codemirror-vim'
import type { UserSnippet, UserSnippetContext, UserSnippetNode } from '@bridge-contract/user-config'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expandUserSnippet,
  handleUserSnippetInput,
  luaPatternToRegExpSource,
  nextUserSnippetChoice,
  nextUserSnippetField,
  previousUserSnippetChoice,
  previousUserSnippetField,
  storeUserSnippetSelection,
  userSnippetExtension,
  type UserSnippetExtensionOptions,
  userSnippetSessionDepth
} from './cm-user-snippets'

const views: EditorView[] = []
let snippetOrder = 0

function snippet(
  trigger: string,
  body: UserSnippetNode[],
  options: Partial<
    Pick<UserSnippet, 'auto' | 'wordTrig' | 'priority' | 'context'> & {
      kind: UserSnippet['trigger']['kind']
    }
  > = {}
): UserSnippet {
  return {
    id: `test-${snippetOrder}`,
    trigger: { kind: options.kind ?? 'literal', value: trigger },
    auto: options.auto ?? true,
    wordTrig: options.wordTrig ?? false,
    priority: options.priority ?? 1_000,
    order: snippetOrder++,
    source: { file: 'test.lua', line: snippetOrder },
    context: options.context ?? { type: 'always' },
    body
  }
}

function mount(
  doc: string,
  snippets: readonly UserSnippet[],
  cursor = doc.length,
  extra: Extension[] = [],
  snippetOptions: UserSnippetExtensionOptions = {}
): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [
        markdown(),
        history(),
        ...extra,
        userSnippetExtension(snippets, {
          ...snippetOptions,
          now: snippetOptions.now ?? (() => new Date(2025, 0, 2, 3, 4, 5))
        })
      ]
    })
  })
  views.push(view)
  return view
}

function typeText(view: EditorView, text: string): boolean {
  const cursor = view.state.selection.main.head
  const typed = view.state.update({
    changes: { from: cursor, insert: text },
    selection: { anchor: cursor + text.length },
    annotations: Transaction.userEvent.of('input.type')
  })
  const handled = handleUserSnippetInput(view, cursor, cursor, text, () => typed)
  if (!handled) view.dispatch(typed)
  return handled
}

function typeWithoutFallback(view: EditorView, text: string): boolean {
  const cursor = view.state.selection.main.head
  const typed = view.state.update({
    changes: { from: cursor, insert: text },
    selection: { anchor: cursor + text.length },
    annotations: Transaction.userEvent.of('input.type')
  })
  return handleUserSnippetInput(view, cursor, cursor, text, () => typed)
}

function replaceSelections(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text))
}

function and(...all: UserSnippetContext[]): UserSnippetContext {
  return { type: 'and', all }
}

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
  document.body.replaceChildren()
  snippetOrder = 0
})

describe('Lua-pattern translation', () => {
  it('supports captures, classes, escaped magic, backreferences, and Lua non-greedy repetition', () => {
    const capture = new RegExp(`${luaPatternToRegExpSource('ex(%d)')}$`, 'u').exec('ex3')
    expect(capture?.[1]).toBe('3')
    expect(new RegExp(`${luaPatternToRegExpSource('(%a)%1')}$`, 'u').test('xx')).toBe(true)
    expect(new RegExp(`${luaPatternToRegExpSource('\\(%a-)')}$`, 'u').exec('\\alpha')?.[1]).toBe(
      'alpha'
    )
    expect(new RegExp(`${luaPatternToRegExpSource('([%a%)%]%}])(%d)')}$`, 'u').test('}2')).toBe(
      true
    )
  })
})

describe('automatic and manual expansion', () => {
  it('expands representative literal and Lua-pattern math snippets', () => {
    const snippets = [
      snippet('oo', [{ type: 'text', text: '\\infty' }], {
        context: { type: 'math' }
      }),
      snippet('**', [{ type: 'text', text: '^*' }], {
        context: { type: 'math' }
      }),
      snippet(
        'ex(%d)',
        [
          { type: 'text', text: '^' },
          { type: 'capture', index: 1 }
        ],
        { kind: 'lua-pattern', context: { type: 'math' } }
      ),
      snippet(
        'bb(%w)',
        [
          { type: 'text', text: '\\mathbb{' },
          { type: 'capture', index: 1, transform: 'upper' },
          { type: 'text', text: '}' }
        ],
        { kind: 'lua-pattern', context: { type: 'math' } }
      )
    ]

    const infinity = mount('$o$', snippets, 2)
    expect(typeText(infinity, 'o')).toBe(true)
    expect(infinity.state.doc.toString()).toBe('$\\infty$')

    const star = mount('$*$', snippets, 2)
    expect(typeText(star, '*')).toBe(true)
    expect(star.state.doc.toString()).toBe('$^*$')

    const exponent = mount('$ex$', snippets, 3)
    expect(typeText(exponent, '3')).toBe(true)
    expect(exponent.state.doc.toString()).toBe('$^3$')

    const blackboard = mount('$bb$', snippets, 3)
    expect(typeText(blackboard, 'x')).toBe(true)
    expect(blackboard.state.doc.toString()).toBe('$\\mathbb{X}$')
  })

  it('supports #3 line-begin transforms and applies wordTrig boundaries', () => {
    const headings = snippet(
      '#(%d)',
      [
        { type: 'capture', index: 1, transform: 'repeat-hashes' },
        { type: 'text', text: ' ' }
      ],
      { kind: 'lua-pattern', context: { type: 'line-begin' }, wordTrig: true }
    )
    const words = snippet('oo', [{ type: 'text', text: '∞' }], {
      wordTrig: true
    })

    const heading = mount('#', [headings, words])
    expect(typeText(heading, '3')).toBe(true)
    expect(heading.state.doc.toString()).toBe('### ')

    const embedded = mount('zo', [words])
    expect(typeText(embedded, 'o')).toBe(false)
    expect(embedded.state.doc.toString()).toBe('zoo')
  })

  it('chooses context-specific ii snippets in text and math', () => {
    const snippets = [
      snippet('ii', [{ type: 'text', text: '\\int' }], {
        context: { type: 'math' }
      }),
      snippet('ii', [{ type: 'text', text: '$\\int$' }], {
        context: { type: 'text' }
      })
    ]
    const text = mount('i', snippets)
    typeText(text, 'i')
    expect(text.state.doc.toString()).toBe('$\\int$')

    const math = mount('$i$', snippets, 2)
    typeText(math, 'i')
    expect(math.state.doc.toString()).toBe('$\\int$')
  })

  it('resolves conflicts by priority, then stable import order', () => {
    const lower = snippet('x', [{ type: 'text', text: 'lower' }], {
      priority: 500
    })
    const firstHigh = snippet('x', [{ type: 'text', text: 'first' }], {
      priority: 2_000
    })
    const laterHigh = snippet('x', [{ type: 'text', text: 'later' }], {
      priority: 2_000
    })
    const view = mount('', [laterHigh, lower, firstHigh])

    typeText(view, 'x')
    expect(view.state.doc.toString()).toBe('first')
  })

  it('expands non-auto snippets only through the manual command', () => {
    const manual = snippet('manual', [{ type: 'text', text: 'expanded' }], {
      auto: false
    })
    const view = mount('manual', [manual])

    expect(expandUserSnippet(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('expanded')

    const autoOnly = snippet('auto', [{ type: 'text', text: 'wrong' }])
    const untouched = mount('auto', [autoOnly])
    expect(expandUserSnippet(untouched)).toBe(false)
    expect(untouched.state.doc.toString()).toBe('auto')
  })

  it('exposes duplicate manual triggers as choice alternatives', () => {
    const adjective = snippet('iso', [{ type: 'text', text: 'isomorphic' }], {
      auto: false
    })
    const noun = snippet('iso', [{ type: 'text', text: 'isomorphism' }], {
      auto: false
    })
    const shadowed = snippet('iso', [{ type: 'text', text: 'lower priority' }], {
      auto: false,
      priority: 500
    })
    const view = mount('iso', [noun, shadowed, adjective])

    expect(expandUserSnippet(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('isomorphic')
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe('isomorphic'.length)
    expect(nextUserSnippetChoice(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('isomorphism')
    expect(view.state.selection.main.empty).toBe(true)
    expect(view.state.selection.main.head).toBe('isomorphism'.length)
    expect(nextUserSnippetChoice(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('isomorphic')
    expect(previousUserSnippetChoice(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('isomorphism')

    replaceSelections(view, ' ')
    expect(view.state.doc.toString()).toBe('isomorphism ')
    expect(userSnippetSessionDepth(view.state)).toBe(0)
    expect(nextUserSnippetChoice(view)).toBe(false)
  })

  it('records automatic expansion separately so undo restores the literal trigger', () => {
    const alpha = snippet('alp', [{ type: 'text', text: '\\alpha' }])
    const view = mount('', [alpha])

    expect(typeText(view, 'a')).toBe(false)
    expect(typeText(view, 'l')).toBe(false)
    expect(typeText(view, 'p')).toBe(true)
    expect(view.state.doc.toString()).toBe('\\alpha')
    expect(undoDepth(view.state)).toBe(2)

    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('alp')
    expect(undo(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('')
  })

  it('retires a final exit on typing instead of nesting later text-only autosnippets', () => {
    const snippets = [
      snippet('alp', [{ type: 'text', text: '\\alpha' }]),
      snippet('bet', [{ type: 'text', text: '\\beta' }])
    ]
    const view = mount('', snippets)

    let fallbackTabReached = false
    const immediateTab = mount('', snippets, 0, [
      keymap.of([
        {
          key: 'Tab',
          run: () => {
            fallbackTabReached = true
            return true
          }
        }
      ])
    ])
    typeText(immediateTab, 'a')
    typeText(immediateTab, 'l')
    typeText(immediateTab, 'p')
    expect(userSnippetSessionDepth(immediateTab.state)).toBe(1)
    immediateTab.focus()
    immediateTab.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Tab',
        code: 'Tab',
        keyCode: 9,
        bubbles: true,
        cancelable: true
      })
    )
    expect(fallbackTabReached).toBe(true)
    expect(userSnippetSessionDepth(immediateTab.state)).toBe(0)

    typeText(view, 'a')
    typeText(view, 'l')
    typeText(view, 'p')
    expect(view.state.doc.toString()).toBe('\\alpha')
    expect(userSnippetSessionDepth(view.state)).toBe(1)

    typeText(view, 'b')
    expect(userSnippetSessionDepth(view.state)).toBe(0)
    typeText(view, 'e')
    typeText(view, 't')
    expect(view.state.doc.toString()).toBe('\\alpha\\beta')
    expect(userSnippetSessionDepth(view.state)).toBe(1)

    typeText(view, ' ')
    expect(view.state.doc.toString()).toBe('\\alpha\\beta ')
    expect(userSnippetSessionDepth(view.state)).toBe(0)
    expect(nextUserSnippetField(view)).toBe(false)
  })

  it('allows autosnippets only in Vim insert mode', () => {
    const auto = snippet('oo', [{ type: 'text', text: '∞' }])
    const view = mount('o', [auto], 1, [vim()])
    view.focus()

    expect(typeWithoutFallback(view, 'o')).toBe(false)
    expect(view.state.doc.toString()).toBe('o')

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'i',
        code: 'KeyI',
        keyCode: 73,
        bubbles: true,
        cancelable: true
      })
    )
    expect(typeWithoutFallback(view, 'o')).toBe(true)
    expect(view.state.doc.toString()).toBe('∞')
  })

  it('honors a live mode gate when the host toggles Vim without recreating the view', () => {
    let enabled = false
    const auto = snippet('oo', [{ type: 'text', text: '∞' }])
    const view = mount('o', [auto], 1, [], { shouldHandle: () => enabled })

    expect(typeWithoutFallback(view, 'o')).toBe(false)
    enabled = true
    expect(typeWithoutFallback(view, 'o')).toBe(true)
    expect(view.state.doc.toString()).toBe('∞')
  })
})

describe('snippet scopes', () => {
  it('distinguishes markdown math, ordinary text, and TikZ math', () => {
    const markdownMath = snippet('mm', [{ type: 'text', text: 'MATH' }], {
      context: { type: 'markdown-math' }
    })
    const text = snippet('tt', [{ type: 'text', text: 'TEXT' }], {
      context: { type: 'text' }
    })
    const tikz = snippet('zz', [{ type: 'text', text: 'TIKZ' }], {
      context: { type: 'tikzcd' }
    })

    const inline = mount('$m$', [markdownMath, text, tikz], 2)
    expect(typeText(inline, 'm')).toBe(true)
    expect(inline.state.doc.toString()).toBe('$MATH$')

    const ordinary = mount('t', [markdownMath, text, tikz])
    expect(typeText(ordinary, 't')).toBe(true)
    expect(ordinary.state.doc.toString()).toBe('TEXT')

    const tikzDoc =
      '```tikz\n\\begin{document}\n\\begin{tikzcd}\nz\n\\end{tikzcd}\n\\end{document}\n```'
    const cursor = tikzDoc.indexOf('\nz\n') + 2
    const diagram = mount(tikzDoc, [markdownMath, text, tikz], cursor)
    expect(typeText(diagram, 'z')).toBe(true)
    expect(diagram.state.doc.toString()).toContain('\nTIKZ\n')
  })

  it('supports combined line-begin and text scopes', () => {
    const begin = snippet('beg', [{ type: 'text', text: 'BEGIN' }], {
      context: and({ type: 'line-begin' }, { type: 'text' })
    })
    const atStart = mount('  be', [begin])
    expect(typeText(atStart, 'g')).toBe(true)
    expect(atStart.state.doc.toString()).toBe('  BEGIN')

    const afterText = mount('x be', [begin])
    expect(typeText(afterText, 'g')).toBe(false)
  })

  it('treats LaTeX \\text{...} contents as text, not markdown math', () => {
    const snippets = [
      snippet('ii', [{ type: 'text', text: 'MATH' }], {
        context: { type: 'markdown-math' }
      }),
      snippet('ii', [{ type: 'text', text: 'TEXT' }], {
        context: { type: 'text' }
      })
    ]
    const source = '$\\text{i}$'
    const insideText = mount(source, snippets, source.indexOf('i}') + 1)
    typeText(insideText, 'i')
    expect(insideText.state.doc.toString()).toBe('$\\text{TEXT}$')

    const outsideSource = '$\\text{x} + i$'
    const outsideText = mount(outsideSource, snippets, outsideSource.length - 1)
    typeText(outsideText, 'i')
    expect(outsideText.state.doc.toString()).toBe('$\\text{x} + MATH$')
  })
})

describe('fields, mirrors, choices, and selected text', () => {
  it('appends an implicit final exit while preserving an explicit exit position', () => {
    const implicit = snippet(
      'lim',
      [
        { type: 'text', text: '\\lim_{' },
        { type: 'insert', index: 1, default: 'n' },
        { type: 'text', text: '}' }
      ],
      { auto: false }
    )
    const implicitView = mount('lim', [implicit])
    expect(expandUserSnippet(implicitView)).toBe(true)
    expect(implicitView.state.doc.toString()).toBe('\\lim_{n}')
    expect(
      implicitView.state.sliceDoc(
        implicitView.state.selection.main.from,
        implicitView.state.selection.main.to
      )
    ).toBe('n')
    expect(nextUserSnippetField(implicitView)).toBe(true)
    expect(implicitView.state.selection.main.head).toBe(implicitView.state.doc.length)
    expect(previousUserSnippetField(implicitView)).toBe(true)
    expect(
      implicitView.state.sliceDoc(
        implicitView.state.selection.main.from,
        implicitView.state.selection.main.to
      )
    ).toBe('n')

    const explicit = snippet(
      'positioned',
      [
        { type: 'text', text: '[' },
        { type: 'insert', index: 1, default: 'x' },
        { type: 'text', text: ']' },
        { type: 'insert', index: 0 },
        { type: 'text', text: 'tail' }
      ],
      { auto: false }
    )
    const explicitView = mount('positioned', [explicit])
    expect(expandUserSnippet(explicitView)).toBe(true)
    expect(explicitView.state.doc.toString()).toBe('[x]tail')
    expect(nextUserSnippetField(explicitView)).toBe(true)
    expect(explicitView.state.selection.main.head).toBe('[x]'.length)
  })

  it('keeps mirrors synchronized and navigates forward/backward with exit last', () => {
    const beg = snippet(
      'beg',
      [
        { type: 'insert', index: 1, default: 'name' },
        { type: 'text', text: ' + ' },
        { type: 'mirror', index: 1 },
        { type: 'insert', index: 0 }
      ],
      { auto: false }
    )
    const view = mount('beg', [beg])
    expandUserSnippet(view)

    expect(view.state.doc.toString()).toBe('name + name')
    expect(view.state.selection.ranges).toHaveLength(2)
    replaceSelections(view, 'x')
    expect(view.state.doc.toString()).toBe('x + x')

    expect(nextUserSnippetField(view)).toBe(true)
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    expect(previousUserSnippetField(view)).toBe(true)
    expect(view.state.selection.ranges).toHaveLength(2)
  })

  it('gives active sessions highest-priority Tab, Shift-Tab, and Escape handling', () => {
    const fields = snippet(
      'fields',
      [
        { type: 'insert', index: 1, default: 'x' },
        { type: 'insert', index: 0 }
      ],
      { auto: false }
    )
    let escapeReachedFollowingHandler = false
    const view = mount('fields', [fields], 'fields'.length, [
      keymap.of([
        {
          key: 'Escape',
          run: () => {
            escapeReachedFollowingHandler = true
            return true
          }
        }
      ])
    ])
    view.focus()
    expandUserSnippet(view)

    const press = (shiftKey = false, key = 'Tab', keyCode = 9): void => {
      view.contentDOM.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          code: key,
          keyCode,
          shiftKey,
          bubbles: true,
          cancelable: true
        })
      )
    }
    press()
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    press(true)
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'x'
    )
    press(false, 'Escape', 27)
    expect(userSnippetSessionDepth(view.state)).toBe(0)
    expect(escapeReachedFollowingHandler).toBe(true)
  })

  it('cycles choice nodes in both directions', () => {
    const choice = snippet(
      'ch',
      [
        {
          type: 'choice',
          index: 1,
          choices: [[{ type: 'text', text: 'red' }], [{ type: 'text', text: 'blue' }]]
        },
        { type: 'insert', index: 0 }
      ],
      { auto: false }
    )
    const view = mount('ch', [choice])
    expandUserSnippet(view)
    expect(view.state.doc.toString()).toBe('red')

    expect(nextUserSnippetChoice(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('blue')
    expect(previousUserSnippetChoice(view)).toBe(true)
    expect(view.state.doc.toString()).toBe('red')
    expect(nextUserSnippetField(view)).toBe(true)
    expect(userSnippetSessionDepth(view.state)).toBe(1)
    expect(previousUserSnippetField(view)).toBe(true)
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'red'
    )
  })

  it('selects inner choice fields and replaces vb/sum branches as one range', () => {
    const vb = snippet(
      'vb',
      [
        {
          type: 'choice',
          index: 1,
          choices: [
            [
              { type: 'text', text: '\\vb{' },
              { type: 'insert', index: 1 },
              { type: 'text', text: '}' }
            ],
            [
              { type: 'text', text: '\\vb*{' },
              { type: 'insert', index: 1 },
              { type: 'text', text: '}' }
            ]
          ]
        },
        { type: 'insert', index: 0 }
      ],
      { auto: false }
    )
    const vector = mount('vb', [vb])
    expandUserSnippet(vector)
    expect(vector.state.doc.toString()).toBe('\\vb{}')
    expect(vector.state.selection.main.head).toBe('\\vb{'.length)
    nextUserSnippetChoice(vector)
    expect(vector.state.doc.toString()).toBe('\\vb*{}')
    expect(vector.state.selection.main.head).toBe('\\vb*{'.length)

    const sum = snippet(
      'sum',
      [
        {
          type: 'choice',
          index: 1,
          choices: [
            [
              { type: 'text', text: '\\sum_{' },
              { type: 'insert', index: 1, default: 'i=1' },
              { type: 'text', text: '} ' }
            ],
            [
              { type: 'text', text: '\\sum_{' },
              { type: 'insert', index: 1, default: 'n=1' },
              { type: 'text', text: '}^{' },
              { type: 'insert', index: 2, default: '\\infty' },
              { type: 'text', text: '} ' }
            ]
          ]
        }
      ],
      { auto: false }
    )
    const summation = mount('sum', [sum])
    expandUserSnippet(summation)
    expect(summation.state.doc.toString()).toBe('\\sum_{i=1} ')
    expect(
      summation.state.sliceDoc(
        summation.state.selection.main.from,
        summation.state.selection.main.to
      )
    ).toBe('i=1')
    nextUserSnippetChoice(summation)
    expect(summation.state.doc.toString()).toBe('\\sum_{n=1}^{\\infty} ')
    expect(
      summation.state.sliceDoc(
        summation.state.selection.main.from,
        summation.state.selection.main.to
      )
    ).toBe('n=1')
    nextUserSnippetField(summation)
    expect(
      summation.state.sliceDoc(
        summation.state.selection.main.from,
        summation.state.selection.main.to
      )
    ).toBe('\\infty')
    expect(nextUserSnippetField(summation)).toBe(true)
    expect(summation.state.selection.main.head).toBe(summation.state.doc.length)
    expect(nextUserSnippetChoice(summation)).toBe(false)
  })

  it('uses stored visual text, while an empty fallback remains editable', () => {
    const wrap = snippet(
      'wrap',
      [
        { type: 'text', text: '\\textbf{' },
        {
          type: 'selected',
          index: 1,
          whenSelected: 'text',
          whenEmpty: 'insert'
        },
        { type: 'text', text: '}' },
        { type: 'insert', index: 0 }
      ],
      { auto: false }
    )
    const selected = mount('abc wrap', [wrap])
    selected.dispatch({ selection: EditorSelection.single(0, 3) })
    expect(storeUserSnippetSelection(selected)).toBe(true)
    selected.dispatch({
      selection: EditorSelection.cursor(selected.state.doc.length)
    })
    expandUserSnippet(selected)
    expect(selected.state.doc.toString()).toBe('abc \\textbf{abc}')
    expect(selected.state.selection.main.head).toBe(selected.state.doc.length)

    const empty = mount('wrap', [wrap])
    expandUserSnippet(empty)
    expect(empty.state.doc.toString()).toBe('\\textbf{}')
    expect(empty.state.selection.main.empty).toBe(true)
    expect(empty.state.selection.main.head).toBe('\\textbf{'.length)
  })

  it('renders deterministic Lua date nodes', () => {
    const dated = snippet('date', [{ type: 'date', format: '%Y-%m-%d %H:%M:%S (%D)' }], {
      auto: false
    })
    const view = mount('date', [dated])
    expandUserSnippet(view)
    expect(view.state.doc.toString()).toBe('2025-01-02 03:04:05 (01/02/25)')
  })
})

describe('nested snippet sessions', () => {
  const outerBody: UserSnippetNode[] = [
    { type: 'text', text: '[' },
    { type: 'insert', index: 1 },
    { type: 'text', text: ']' },
    { type: 'insert', index: 0 }
  ]

  it('finishes a child session and resumes its enclosing field', () => {
    const outer = snippet('out', outerBody, { auto: false })
    const child = snippet('ii', [
      { type: 'text', text: '<' },
      { type: 'insert', index: 1, default: 'x' },
      { type: 'text', text: '>' },
      { type: 'insert', index: 0 }
    ])
    const view = mount('out', [outer, child])
    expandUserSnippet(view)
    typeText(view, 'i')
    typeText(view, 'i')

    expect(view.state.doc.toString()).toBe('[<x>]')
    expect(userSnippetSessionDepth(view.state)).toBe(2)
    replaceSelections(view, 'y')
    nextUserSnippetField(view)
    nextUserSnippetField(view)
    expect(userSnippetSessionDepth(view.state)).toBe(1)
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    nextUserSnippetField(view)
    expect(userSnippetSessionDepth(view.state)).toBe(0)
  })

  it('maps an outer field through a no-field child expansion', () => {
    const outer = snippet('out', outerBody, { auto: false })
    const child = snippet('oo', [{ type: 'text', text: '∞' }])
    const view = mount('out', [outer, child])
    expandUserSnippet(view)
    typeText(view, 'o')
    typeText(view, 'o')

    expect(view.state.doc.toString()).toBe('[∞]')
    expect(userSnippetSessionDepth(view.state)).toBe(2)
    expect(nextUserSnippetField(view)).toBe(true)
    expect(userSnippetSessionDepth(view.state)).toBe(1)
    expect(view.state.selection.main.head).toBe(view.state.doc.length)
    expect(nextUserSnippetField(view)).toBe(false)
    expect(userSnippetSessionDepth(view.state)).toBe(0)
  })
})
