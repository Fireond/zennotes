// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState, type EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { mathRenderExtension } from './cm-math-render'
import { mathMarkdownSyntax, mathSyntaxHighlight } from './cm-math-syntax'

function mount(
  doc: string,
  selection?: EditorSelection | { anchor: number },
  renderMath = true
): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: selection ?? { anchor: 0 },
      extensions: [
        markdown({ base: markdownLanguage, extensions: mathMarkdownSyntax }),
        mathSyntaxHighlight,
        renderMath ? mathRenderExtension('katex') : []
      ]
    })
  })
  forceParsing(view, doc.length, 5000)
  // Nudge a rebuild so decorations reflect the fully parsed tree.
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

describe('mathRenderExtension', () => {
  it('highlights complete math source without styling structural dollars in raw mode', () => {
    const view = mount('plain $x + π$ and `$code$`', undefined, false)
    const source = Array.from(view.dom.querySelectorAll<HTMLElement>('.tok-math-source'))
      .map((span) => span.textContent)
      .join('')

    expect(source).toBe('x + π')
    expect(view.dom.querySelector('.tok-math-delimiter')).toBeNull()
    expect(view.dom.querySelector('.cm-math-inline')).toBeNull()
    view.destroy()
  })

  it('renders inline $…$ formulas', () => {
    const view = mount('start\n\nInline $a^2+b^2=c^2$ and $x_1$ here.\n\nend')
    const formulas = view.dom.querySelectorAll<HTMLElement>('.cm-math-inline')
    expect(formulas).toHaveLength(2)
    expect(formulas[0].dataset.mathSource).toBe('a^2+b^2=c^2')
    expect(formulas[0].dataset.mathSourceOffset).toBe('1')
    expect(formulas[1].dataset.mathSource).toBe('x_1')
    expect(formulas[1].dataset.mathSourceOffset).toBe('1')
    view.destroy()
  })

  it('renders block $$…$$ formulas whose fences own their lines', () => {
    const view = mount('start\n\n$$\n\\int_0^1 x\\,dx\n$$\n\nend')
    const formula = view.dom.querySelector<HTMLElement>('.cm-math-block')
    expect(formula).not.toBeNull()
    expect(formula?.dataset.mathSource).toBe('\n\\int_0^1 x\\,dx\n')
    expect(formula?.dataset.mathSourceOffset).toBe('2')
    view.destroy()
  })

  it('reports the inner-source offset relative to an indented block replacement', () => {
    const view = mount('start\n\n   $$\n\\sum_{i=1}^{n} i\n   $$   \n\nend')
    const formula = view.dom.querySelector<HTMLElement>('.cm-math-block')
    expect(formula).not.toBeNull()
    expect(formula?.dataset.mathSource).toBe('\n\\sum_{i=1}^{n} i\n   ')
    // The replacement starts at the beginning of the opening fence line, so
    // its inner source starts after three spaces and the two-dollar fence.
    expect(formula?.dataset.mathSourceOffset).toBe('5')
    view.destroy()
  })

  it('leaves currency literal (space before the closing $)', () => {
    const view = mount('I paid $5 and got $10 back.\n\nend')
    expect(view.dom.querySelectorAll('.cm-math-inline').length).toBe(0)
    view.destroy()
  })

  it('leaves math inside inline code literal', () => {
    const view = mount('Use `$x^2$` verbatim.\n\nend')
    expect(view.dom.querySelectorAll('.cm-math-inline').length).toBe(0)
    view.destroy()
  })

  it('keeps relaxed display delimiters raw in the editor', () => {
    const view = mount('before $$\nx+1\n$$ after')
    expect(view.dom.querySelector('.cm-math-block')).toBeNull()
    expect(view.dom.textContent).toContain('$$')
    view.destroy()
  })

  it('reveals the raw source and previews the formula under the cursor', () => {
    // Cursor at offset 4 sits inside `$a+b$` (positions 2..7).
    const view = mount('x $a+b$ y', { anchor: 4 })
    expect(view.dom.querySelectorAll('.cm-math-inline').length).toBe(0)
    const preview = view.dom.querySelector<HTMLElement>('.cm-math-edit-preview')
    expect(preview?.dataset.mathSource).toBe('a+b')
    expect(preview?.dataset.mathDisplay).toBe('inline')
    expect(preview?.getAttribute('contenteditable')).toBe('false')
    expect(preview?.getAttribute('aria-hidden')).toBe('true')
    expect(preview?.querySelector('.katex')).not.toBeNull()
    expect(preview?.querySelector('.katex-display')).toBeNull()
    view.destroy()
  })

  it('updates the active preview in real time and removes it when the cursor leaves', () => {
    const view = mount('x $a+b$ y', { anchor: 4 })
    const b = view.state.doc.toString().indexOf('b')
    view.dispatch({ changes: { from: b, to: b + 1, insert: 'c^2' } })

    const preview = view.dom.querySelector<HTMLElement>('.cm-math-edit-preview')
    expect(preview?.dataset.mathSource).toBe('a+c^2')
    expect(preview?.textContent).toContain('c')

    view.dispatch({ selection: { anchor: 0 } })
    expect(view.dom.querySelector('.cm-math-edit-preview')).toBeNull()
    expect(view.dom.querySelectorAll('.cm-math-inline')).toHaveLength(1)
    view.destroy()
  })

  it('shows one display preview below active block math', () => {
    const doc = 'before\n$$\n\\int_0^1 x\\,dx\n$$\nafter'
    const view = mount(doc, { anchor: doc.indexOf('x\\,dx') })

    expect(view.dom.querySelector('.cm-math-block')).toBeNull()
    const preview = view.dom.querySelector<HTMLElement>('.cm-math-edit-preview')
    expect(preview?.dataset.mathSource).toBe('\n\\int_0^1 x\\,dx\n')
    expect(preview?.dataset.mathDisplay).toBe('block')
    expect(preview?.querySelector('.katex-display')).not.toBeNull()
    view.destroy()
  })

  it('previews only the formula containing the primary cursor', () => {
    const doc = '$a$ and $b$'
    const view = mount(doc, { anchor: doc.indexOf('b') })

    const previews = view.dom.querySelectorAll<HTMLElement>(
      '.cm-math-edit-preview'
    )
    expect(previews).toHaveLength(1)
    expect(previews[0].dataset.mathSource).toBe('b')
    // The other formula remains rendered normally.
    expect(view.dom.querySelectorAll('.cm-math-inline')).toHaveLength(1)
    view.destroy()
  })

  it('highlights only revealed LaTeX source while cursor transitions keep other formulas rendered', () => {
    const doc = String.raw`first $\sum_{i=1}^{n} i$ and second $\alpha + x_2$`
    const view = mount(doc, { anchor: doc.indexOf(String.raw`\sum`) })

    const activeCommand = view.dom.querySelector<HTMLElement>('.tok-math-command')
    expect(activeCommand?.textContent).toContain(String.raw`\sum`)
    expect(activeCommand?.closest('.cm-math-source')).not.toBeNull()
    expect(view.dom.querySelector('.tok-math-source')).not.toBeNull()
    expect(view.dom.querySelector('.tok-math-number')).not.toBeNull()
    expect(view.dom.querySelector('.tok-math-delimiter')).toBeNull()
    expect(
      view.dom.querySelectorAll<HTMLElement>('.cm-math-inline')
    ).toHaveLength(1)
    expect(
      view.dom.querySelector<HTMLElement>('.cm-math-inline')?.dataset.mathSource
    ).toBe(String.raw`\alpha + x_2`)

    view.dispatch({ selection: { anchor: doc.indexOf(String.raw`\alpha`) } })

    const transitionedCommand = view.dom.querySelector<HTMLElement>('.tok-math-command')
    expect(transitionedCommand?.textContent).toContain(String.raw`\alpha`)
    expect(transitionedCommand?.closest('.cm-math-source')).not.toBeNull()
    expect(
      view.dom.querySelectorAll<HTMLElement>('.cm-math-inline')
    ).toHaveLength(1)
    expect(
      view.dom.querySelector<HTMLElement>('.cm-math-inline')?.dataset.mathSource
    ).toBe(String.raw`\sum_{i=1}^{n} i`)
    expect(view.dom.querySelector('.tok-math-delimiter')).toBeNull()

    view.dispatch({ selection: { anchor: 0 } })
    expect(view.dom.querySelector('.tok-math-command')).toBeNull()
    expect(view.dom.querySelector('.tok-math-source')).toBeNull()
    expect(view.dom.querySelector('.tok-math-delimiter')).toBeNull()
    expect(view.dom.querySelectorAll('.cm-math-inline')).toHaveLength(2)
    expect(view.dom.querySelector('.cm-math-edit-preview')).toBeNull()
    view.destroy()
  })
})
