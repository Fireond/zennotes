// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tikzBlockLineRanges, tikzRenderExtension } from './cm-tikz-render'

const SOURCE = [
  '\\usepackage{tikz-cd,amssymb}',
  '\\begin{document}',
  '  \\begin{tikzcd}',
  '    A \\arrow[r, "f"] & B',
  '  \\end{tikzcd}',
  '\\end{document}'
].join('\n')
const DOC = ['before', '', '```tikz', SOURCE, '```', '', 'after'].join('\n')
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M0 0L20 10" /><text font-family="cmr10">A</text></svg>'

type RenderResult = { ok: true; svg: string } | { ok: false; error: string }

const views: EditorView[] = []
let renderTikz: ReturnType<typeof vi.fn>

function installRenderer(implementation?: (source: string) => Promise<RenderResult>): void {
  renderTikz = vi.fn(implementation ?? (async () => ({ ok: true as const, svg: SVG })))
  Object.defineProperty(window, 'zen', {
    configurable: true,
    value: { renderTikz }
  })
}

function mount(doc = DOC, anchor = 0): EditorView {
  const parent = document.createElement('div')
  document.body.append(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), tikzRenderExtension]
    })
  })
  views.push(view)
  forceParsing(view, doc.length, 5000)
  // Rebuild after the incremental Markdown parser has completed.
  view.dispatch({ changes: { from: doc.length, insert: ' ' } })
  view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
  return view
}

beforeEach(() => {
  document.body.replaceChildren()
  installRenderer()
})

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy())
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-theme-mode')
  document.documentElement.style.removeProperty('--z-blue')
})

describe('tikzRenderExtension', () => {
  it('renders a complete inactive fence and passes its exact inner source', async () => {
    const view = mount()

    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tikz-block svg')).toBeTruthy())
    expect(renderTikz).toHaveBeenCalledTimes(1)
    expect(renderTikz).toHaveBeenCalledWith(SOURCE)
    expect(view.dom.textContent).not.toContain('```tikz')
    expect(view.dom.querySelector('.cm-tikz-block')?.getAttribute('aria-label')).toContain(
      'click to edit'
    )
  })

  it('reveals source under the cursor, then renders after the cursor leaves', async () => {
    const sourcePosition = DOC.indexOf('tikzcd')
    const view = mount(DOC, sourcePosition)

    expect(view.dom.querySelector('.cm-tikz-block')).toBeNull()
    expect(view.dom.textContent).toContain('```tikz')
    expect(renderTikz).not.toHaveBeenCalled()

    view.dispatch({ selection: { anchor: 0 } })
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tikz-block svg')).toBeTruthy())
    expect(renderTikz).toHaveBeenCalledWith(SOURCE)
  })

  it('reveals the source when the rendered diagram is clicked', async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tikz-block svg')).toBeTruthy())
    const widget = view.dom.querySelector<HTMLElement>('.cm-tikz-block')!

    widget.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    )

    expect(view.state.selection.main.head).toBe(DOC.indexOf(SOURCE))
    expect(view.dom.querySelector('.cm-tikz-block')).toBeNull()
    expect(view.dom.textContent).toContain('```tikz')
  })

  it('keeps a settled widget mounted when an edit above it shifts its position', async () => {
    const view = mount()
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tikz-block svg')).toBeTruthy())
    const originalWidget = view.dom.querySelector('.cm-tikz-block')

    view.dispatch({ changes: { from: 0, insert: 'new heading\n' } })

    expect(view.dom.querySelector('.cm-tikz-block')).toBe(originalWidget)
    expect(renderTikz).toHaveBeenCalledTimes(1)

    originalWidget?.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    )
    expect(view.state.selection.main.head).toBe(view.state.doc.toString().indexOf(SOURCE))
  })

  it('renders nested blockquote fences from their logical code content', async () => {
    const nestedSource = ['\\begin{tikzpicture}', '  \\draw (0,0) -- (1,1);', '\\end{tikzpicture}'].join(
      '\n'
    )
    const nested = [
      'before',
      '',
      '> ```TiKZ',
      ...nestedSource.split('\n').map((line) => `> ${line}`),
      '> ```',
      '',
      'after'
    ].join('\n')
    const view = mount(nested)

    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tikz-block svg')).toBeTruthy())
    expect(renderTikz).toHaveBeenCalledWith(nestedSource)

    view.dom.querySelector('.cm-tikz-block')?.dispatchEvent(
      new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })
    )
    expect(view.state.selection.main.head).toBe(nested.indexOf('\\begin{tikzpicture}'))
    expect(view.dom.textContent).toContain('> ```TiKZ')
  })

  it('supports case-insensitive tilde fences and ignores incomplete fences', async () => {
    const complete = ['before', '~~~~TiKZ', '\\begin{tikzpicture}', '\\end{tikzpicture}', '~~~~'].join(
      '\n'
    )
    const view = mount(complete)
    await vi.waitFor(() => expect(view.dom.querySelector('.cm-tikz-block svg')).toBeTruthy())
    expect(renderTikz).toHaveBeenCalledWith(
      ['\\begin{tikzpicture}', '\\end{tikzpicture}'].join('\n')
    )

    installRenderer()
    const incomplete = mount('before\n```tikz\n\\begin{tikzpicture}\n')
    expect(incomplete.dom.querySelector('.cm-tikz-block')).toBeNull()
    expect(renderTikz).not.toHaveBeenCalled()
  })

  it('shows bridge errors and rejects non-SVG output safely', async () => {
    installRenderer(async () => ({ ok: false, error: '<bad TeX>' }))
    const errorView = mount()
    await vi.waitFor(() =>
      expect(errorView.dom.querySelector('.zen-diagram-error')?.textContent).toContain('<bad TeX>')
    )
    expect(errorView.dom.querySelector('.zen-diagram-error')?.innerHTML).toContain('&lt;bad TeX&gt;')

    installRenderer(async () => ({ ok: true, svg: '<div>not svg</div>' }))
    const invalidView = mount()
    await vi.waitFor(() =>
      expect(invalidView.dom.querySelector('.zen-diagram-error')?.textContent).toContain(
        'invalid SVG'
      )
    )
    expect(invalidView.dom.querySelector('div div')).toBeTruthy()
    expect(invalidView.dom.querySelector('svg')).toBeNull()
  })

  it('contains synchronous bridge failures inside the diagram widget', async () => {
    installRenderer(() => {
      throw new Error('<bridge unavailable>')
    })
    const view = mount()

    await vi.waitFor(() =>
      expect(view.dom.querySelector('.zen-diagram-error')?.textContent).toContain(
        '<bridge unavailable>'
      )
    )
    expect(view.dom.querySelector('.zen-diagram-error')?.innerHTML).toContain(
      '&lt;bridge unavailable&gt;'
    )
  })

  it('retints a settled SVG when the application theme changes', async () => {
    document.documentElement.style.setProperty('--z-blue', '1 2 3')
    installRenderer(async () => ({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><path stroke="blue" d="M0 0L1 1" /></svg>'
    }))
    const view = mount()
    await vi.waitFor(() =>
      expect(view.dom.querySelector('.cm-tikz-block path')?.getAttribute('stroke')).toBe('#010203')
    )

    document.documentElement.style.setProperty('--z-blue', '4 5 6')
    document.documentElement.dataset.theme = 'changed-theme'

    await vi.waitFor(() =>
      expect(view.dom.querySelector('.cm-tikz-block path')?.getAttribute('stroke')).toBe('#040506')
    )
    expect(renderTikz).toHaveBeenCalledTimes(1)
  })

  it('ignores a late result after the block is revealed', async () => {
    let resolveRender: ((result: RenderResult) => void) | undefined
    installRenderer(
      () =>
        new Promise<RenderResult>((resolve) => {
          resolveRender = resolve
        })
    )
    const view = mount()
    const requestMeasure = vi.spyOn(view, 'requestMeasure')
    await vi.waitFor(() => expect(renderTikz).toHaveBeenCalledTimes(1))

    view.dispatch({ selection: { anchor: DOC.indexOf(SOURCE) } })
    // CodeMirror itself schedules a measure when the replacement disappears;
    // only a *new* call after the stale promise resolves would be a bug.
    requestMeasure.mockClear()
    resolveRender?.({ ok: true, svg: SVG.replace('A', 'stale') })
    await Promise.resolve()

    expect(view.dom.querySelector('.cm-tikz-block')).toBeNull()
    expect(view.dom.textContent).not.toContain('stale')
    expect(requestMeasure).not.toHaveBeenCalled()
  })

  it('reports block ranges for keyboard and Vim navigation', () => {
    const view = mount()
    const openingLine = view.state.doc.lineAt(DOC.indexOf('```tikz')).number
    const closingLine = view.state.doc.lineAt(DOC.lastIndexOf('```')).number
    expect(tikzBlockLineRanges(view.state)).toEqual([
      { fromLine: openingLine, toLine: closingLine }
    ])

    view.dispatch({ selection: { anchor: DOC.indexOf(SOURCE) } })
    expect(tikzBlockLineRanges(view.state)).toEqual([
      { fromLine: openingLine, toLine: closingLine }
    ])
  })
})
