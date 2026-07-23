// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'
import { mathRenderExtension } from './cm-math-render'
import { mathMarkdownSyntax } from './cm-math-syntax'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'
import { useStore } from '../store'

vi.mock('../store', () => {
  const state = {
    activeNote: null,
    assetFiles: [],
    noteRefs: {},
    pdfEmbedInEditMode: 'compact',
    pinnedRefKind: 'note',
    pinnedRefPath: null,
    vault: null
  }
  const useStore = Object.assign(() => null, {
    getState: () => state,
    subscribe: () => () => {}
  })
  return { useStore }
})

const emphasisTestHighlight = HighlightStyle.define([
  { tag: t.emphasis, class: 'tok-emphasis' }
])

function mountEditor(doc: string, anchor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), livePreviewPlugin]
    })
  })
}

function mountMathEditor(doc: string, anchor: number): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ base: markdownLanguage, extensions: mathMarkdownSyntax }),
        syntaxHighlighting(emphasisTestHighlight),
        livePreviewPlugin,
        wysiwygBlocksPlugin,
        mathRenderExtension('katex')
      ]
    })
  })
  forceParsing(view, doc.length, 5000)
  // Rebuild both decoration providers after the syntax tree is complete.
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

function editorLineTexts(view: EditorView): string[] {
  return Array.from(
    view.dom.querySelectorAll<HTMLElement>('.cm-line'),
    (line) => line.textContent ?? ''
  )
}

describe('livePreviewPlugin', () => {
  it('reveals link markdown only when the selection is inside the link', () => {
    const doc = 'Paragraph start with a [visible link](https://example.com) and trailing text.'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('visible link')
    expect(view.dom.textContent).not.toContain('https://example.com')

    view.dispatch({
      selection: { anchor: doc.indexOf('visible link') + 2 }
    })

    expect(view.dom.textContent).toContain('[visible link](https://example.com)')

    view.destroy()
  })

  it('keeps the colon visible in a reference-link definition (#188)', () => {
    // The `:` parses as a LinkMark; live preview must not hide it, or the
    // definition reads as a broken `[label] url`.
    const doc = 'intro\n\n[Markdown Lang]: https://www.markdownlang.com'
    const view = mountEditor(doc, 0) // cursor on "intro" → definition line inactive

    expect(view.dom.textContent).toContain('[Markdown Lang]: https://www.markdownlang.com')

    view.destroy()
  })

  it('reveals heading markers with the cursor anywhere in the heading', () => {
    // Consistent with list/quote/task markers: the active line reads as source.
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, doc.indexOf('blocks'))

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('reveals heading markers when the selection is on the marker', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, 0)

    expect(view.dom.textContent).toContain('# Code blocks')

    view.destroy()
  })

  it('keeps every asterisk visible in revealed multiline math source', () => {
    const doc = [
      '*ordinary italic*',
      '**ordinary bold**',
      '',
      '$$',
      '* x',
      'x^{*} + y^{*}',
      'z^{*} + w^{*}',
      '$$'
    ].join('\n')
    // Entering the opening fence reveals the whole block, including formula
    // lines that are not themselves the active Markdown line.
    const view = mountMathEditor(doc, doc.indexOf('$$') + 1)
    const lines = editorLineTexts(view)

    expect(view.dom.querySelector('.cm-math-block')).toBeNull()
    expect(view.dom.querySelector('.cm-math-edit-preview-block')).not.toBeNull()
    expect(lines).toContain('* x')
    expect(lines).toContain('x^{*} + y^{*}')
    expect(lines).toContain('z^{*} + w^{*}')
    // Normal Markdown outside math must keep its existing concealment.
    expect(lines).toContain('ordinary italic')
    expect(lines).not.toContain('*ordinary italic*')
    expect(lines).toContain('ordinary bold')
    expect(lines).not.toContain('**ordinary bold**')
    // Formula contents are opaque to the Markdown parser, so LaTeX stars never
    // receive emphasis highlighting in the first place.
    expect(
      view.dom.querySelector(
        '.cm-math-source.tok-emphasis, .cm-math-source .tok-emphasis, .tok-emphasis .cm-math-source'
      )
    ).toBeNull()
    const ordinaryEmphasis = Array.from(
      view.dom.querySelectorAll<HTMLElement>('.tok-emphasis')
    ).find((element) => element.textContent?.includes('ordinary italic'))
    expect(ordinaryEmphasis).toBeDefined()
    expect(ordinaryEmphasis?.closest('.cm-math-source')).toBeNull()
    view.destroy()
  })

  it('does not let emphasis leak from one block formula into prose before the next', () => {
    const doc = String.raw`$$
H^*(X,\{x\_0\};R) \otimes\_R H^*(Y,\{y_0\};R) \xrightarrow{\times} H^*(X\times Y,\{x_0\}\times Y \cup X \times\{y_0\};R),
$$
so we get an isomorphism
$$
\tilde{H}^*(X ;R) \otimes\_R \tilde{H}^*(Y ;R) \xrightarrow{\times}\tilde{H}^*(X \land Y ;R)
$$

*ordinary emphasis*`
    const view = mountMathEditor(doc, doc.indexOf('H^*') + 2)
    const proseLine = Array.from(view.dom.querySelectorAll<HTMLElement>('.cm-line')).find(
      (line) => line.textContent === 'so we get an isomorphism'
    )
    const ordinaryEmphasis = Array.from(
      view.dom.querySelectorAll<HTMLElement>('.tok-emphasis')
    ).find((element) => element.textContent?.includes('ordinary emphasis'))

    expect(proseLine).toBeDefined()
    expect(proseLine?.matches('.tok-emphasis')).toBe(false)
    expect(proseLine?.querySelector('.tok-emphasis')).toBeNull()
    expect(proseLine?.closest('.tok-emphasis')).toBeNull()
    expect(ordinaryEmphasis).toBeDefined()
    view.destroy()
  })

  it('keeps asterisks visible in active inline math source', () => {
    const doc = '**ordinary bold**\n\nInline $x^{*} + y^{*}$ here'
    const view = mountMathEditor(doc, doc.indexOf('x^{*}'))
    const lines = editorLineTexts(view)

    expect(view.dom.querySelector('.cm-math-inline')).toBeNull()
    expect(view.dom.querySelector('.cm-math-edit-preview-inline')).not.toBeNull()
    expect(lines).toContain('Inline $x^{*} + y^{*}$ here')
    expect(lines).toContain('ordinary bold')
    view.destroy()
  })

  it('hides heading markers when the cursor is on another line', () => {
    const doc = '# Code blocks\n\nBody'
    const view = mountEditor(doc, doc.indexOf('Body'))

    expect(view.dom.textContent).toContain('Code blocks')
    expect(view.dom.textContent).not.toContain('# Code blocks')

    view.destroy()
  })

  it('replaces an unchecked task marker with a checkbox widget', () => {
    // Cursor on the intro line — the task line is inactive, so it renders.
    const doc = 'intro\n\n- [ ] Buy milk'
    const view = mountEditor(doc, 0)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.checked).toBe(false)
    // The raw `[ ]` is replaced by the widget, so it's no longer in the
    // rendered text. The task body remains.
    expect(view.dom.textContent).not.toContain('[ ]')
    expect(view.dom.textContent).toContain('Buy milk')

    view.destroy()
  })

  it('replaces a checked task marker with a checked checkbox', () => {
    const doc = 'intro\n\n- [x] Done\n- [X] Also done'
    const view = mountEditor(doc, 0)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(2)
    expect(inputs[0]?.checked).toBe(true)
    expect(inputs[1]?.checked).toBe(true)
    expect(view.dom.textContent).not.toContain('[x]')
    expect(view.dom.textContent).not.toContain('[X]')

    view.destroy()
  })

  it('reveals the raw marker when the cursor lands inside it', () => {
    const doc = '- [ ] Edit me'
    // Position 3 sits between `[` and `]` — i.e. on the state character.
    const view = mountEditor(doc, 3)

    expect(view.dom.querySelectorAll('input.cm-task-checkbox-input')).toHaveLength(0)
    expect(view.dom.textContent).toContain('[ ]')

    view.destroy()
  })

  it('toggles the underlying marker when the checkbox is clicked', () => {
    const doc = 'intro\n\n- [ ] Buy milk'
    const view = mountEditor(doc, 0)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('intro\n\n- [x] Buy milk')

    view.destroy()
  })

  it('toggles back to unchecked from a `[x]` marker', () => {
    const doc = 'intro\n\n- [x] Already done'
    const view = mountEditor(doc, 0)

    const input = view.dom.querySelector<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(input).toBeTruthy()
    input!.click()

    expect(view.state.doc.toString()).toBe('intro\n\n- [ ] Already done')

    view.destroy()
  })

  it('collapses the host-line strut on a hidden-source image, restores it when editing (#261)', () => {
    // The image widget is an inline (side:1) decoration, so its host line would
    // otherwise reserve a full text line-box above/below the block figure. The
    // plugin stamps `cm-image-embed-line` only while the source is hidden.
    const store = useStore.getState() as unknown as {
      vault: unknown
      activeNote: unknown
      assetFiles: Array<{ path: string }>
    }
    const original = { vault: store.vault, activeNote: store.activeNote, assetFiles: store.assetFiles }
    ;(window as unknown as { zen: unknown }).zen = {
      resolveVaultAssetUrl: () => 'asset://pic.png',
      resolveLocalAssetUrl: () => 'asset://pic.png'
    }
    store.vault = { root: '/vault' }
    store.activeNote = { path: 'inbox/Image Note.md' }
    store.assetFiles = [{ path: 'inbox/pic.png' }]
    try {
      const doc = 'Above\n\n![sample](pic.png)\n\nBelow'
      const view = mountEditor(doc, 0) // cursor on "Above" → image line inactive

      const figure = view.dom.querySelector('.cm-local-image-embed')
      expect(figure).toBeTruthy()
      const hostLine = figure!.closest('.cm-line')
      expect(hostLine?.classList.contains('cm-image-embed-line')).toBe(true)
      // Raw markdown stays hidden while the line is inactive.
      expect(view.dom.textContent).not.toContain('![sample](pic.png)')

      // Move the caret onto the image line: source revealed, strut class gone.
      view.dispatch({ selection: { anchor: doc.indexOf('![sample]') + 2 } })
      expect(view.dom.textContent).toContain('![sample](pic.png)')
      const revealed = [...view.dom.querySelectorAll('.cm-line')].find((l) =>
        (l.textContent || '').includes('![sample](pic.png)')
      )
      expect(revealed).toBeTruthy()
      expect(revealed!.classList.contains('cm-image-embed-line')).toBe(false)

      view.destroy()
    } finally {
      store.vault = original.vault
      store.activeNote = original.activeNote
      store.assetFiles = original.assetFiles
      delete (window as unknown as { zen?: unknown }).zen
    }
  })

  it('renders checkboxes for ordered, nested, and quoted tasks', () => {
    // Task variants the TASK_LINE_RE in shared/tasklists supports. Cursor on
    // the intro line so every task line is inactive (and thus rendered).
    const doc = ['intro', '1. [ ] Ordered', '   - [x] Nested', '> - [ ] Quoted'].join('\n')
    const view = mountEditor(doc, 0)

    const inputs = view.dom.querySelectorAll<HTMLInputElement>('input.cm-task-checkbox-input')
    expect(inputs).toHaveLength(3)
    expect(inputs[0]?.checked).toBe(false)
    expect(inputs[1]?.checked).toBe(true)
    expect(inputs[2]?.checked).toBe(false)

    view.destroy()
  })

  it('marks a completed task’s text with cm-task-done and leaves incomplete tasks alone', () => {
    // Cursor on the intro line so both task lines are inactive (rendered). The
    // CSS (gated by the completedTaskStyle setting) then strikes/grays the mark.
    const doc = ['intro', '- [x] finished item', '- [ ] pending item'].join('\n')
    const view = mountEditor(doc, 0)

    const marked = Array.from(view.dom.querySelectorAll('.cm-task-done'))
      .map((el) => el.textContent)
      .join(' ')
    expect(marked).toContain('finished item')
    expect(marked).not.toContain('pending item')

    view.destroy()
  })
})
