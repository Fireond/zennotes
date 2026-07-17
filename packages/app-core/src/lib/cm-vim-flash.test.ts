// @vitest-environment jsdom
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it } from 'vitest'
import {
  handleVimFlashKey,
  isVimFlashActive,
  startVimFlashJump,
  vimFlashExtension
} from './cm-vim-flash'
import { mathRenderExtension } from './cm-math-render'
import { mathMarkdownSyntax } from './cm-math-syntax'

type RenderedTarget = { label: string; position: number }

const flashTestHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'tok-heading1' },
  { tag: t.strong, class: 'tok-strong' }
])

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value: () => []
  })
}

describe('Vim Flash integration', () => {
  const views: EditorView[] = []

  afterEach(() => {
    views.splice(0).forEach((view) => view.destroy())
    document.body.replaceChildren()
  })

  function mount(doc: string, anchor = 0, extraExtensions: readonly Extension[] = []): EditorView {
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        selection: { anchor },
        extensions: [vim(), vimFlashExtension, ...extraExtensions]
      })
    })
    views.push(view)
    view.focus()
    return view
  }

  function mountMath(doc: string, anchor = 0): EditorView {
    const view = mount(doc, anchor, [
      markdown({ base: markdownLanguage, extensions: mathMarkdownSyntax }),
      mathRenderExtension
    ])
    forceParsing(view, doc.length, 5000)
    // Rebuild math decorations after the Markdown parser has completed.
    view.dispatch({ changes: { from: doc.length, insert: ' ' } })
    view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })
    return view
  }

  function pressVim(view: EditorView, key: string): void {
    const adapter = getCM(view)
    if (!adapter) throw new Error('missing Vim adapter')
    Vim.handleKey(adapter, key, 'user')
  }

  function dispatchVimKey(view: EditorView, key: string): void {
    view.contentDOM.dispatchEvent(keyboardEvent(key))
  }

  function keyboardEvent(key: string): KeyboardEvent {
    return new KeyboardEvent('keydown', {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true
    })
  }

  /** Mirrors VimNav routing: an active Flash session gets first refusal. */
  function routeKey(view: EditorView, key: string): boolean {
    const consumed = handleVimFlashKey(view, keyboardEvent(key))
    if (!consumed) pressVim(view, key === 'Escape' ? '<Esc>' : key)
    return consumed
  }

  function typeJumpQuery(view: EditorView, query: string): void {
    for (const character of Array.from(query)) {
      expect(routeKey(view, character)).toBe(true)
    }
  }

  function renderedTargets(view: EditorView): RenderedTarget[] {
    return Array.from(
      view.dom.querySelectorAll<HTMLElement>('.cm-flash-label, .cm-flash-math-label')
    ).map((element) => ({
      label: element.dataset.flashLabel ?? '',
      position:
        element.dataset.flashPosition != null
          ? Number.parseInt(element.dataset.flashPosition, 10)
          : view.posAtDOM(element, 0)
    }))
  }

  function labelAt(view: EditorView, position: number): string {
    const target = renderedTargets(view).find((candidate) => candidate.position === position)
    if (!target) {
      throw new Error(
        `missing rendered Flash label at ${position}: ${JSON.stringify(renderedTargets(view))}`
      )
    }
    return target.label
  }

  async function settleCharacterSearch(): Promise<void> {
    // cm-vim-flash defers decoration setup until codemirror-vim has completed
    // the literal f/F motion and published its last-character search state.
    await Promise.resolve()
    await Promise.resolve()
  }

  function settleViewMeasure(view: EditorView): Promise<void> {
    return new Promise((resolve) => {
      view.requestMeasure({
        read: () => null,
        write: () => resolve()
      })
    })
  }

  describe('incremental labeled jump', () => {
    it('renders labels for a query and jumps to the selected label', () => {
      const view = mount('zero cat middle cat end')

      expect(startVimFlashJump(view)).toBe(true)
      expect(isVimFlashActive(view)).toBe(true)
      typeJumpQuery(view, 'cat')

      expect(view.dom.querySelector('.cm-flash-prompt')?.textContent).toBe('Jump: cat')
      expect(renderedTargets(view)).toHaveLength(2)

      expect(routeKey(view, labelAt(view, 16))).toBe(true)
      expect(view.state.selection.main.head).toBe(16)
      expect(isVimFlashActive(view)).toBe(false)
      expect(view.dom.querySelectorAll('.cm-flash-label')).toHaveLength(0)
    })

    it('accepts arbitrary multi-character refinement before a label', () => {
      const view = mount('cart carbon carmine carburetor')

      expect(startVimFlashJump(view)).toBe(true)
      for (const [query, matchCount] of [
        ['c', 4],
        ['ca', 4],
        ['car', 4],
        ['carb', 2],
        ['carbu', 1],
        ['carbur', 1]
      ] as const) {
        expect(routeKey(view, query.at(-1)!)).toBe(true)
        expect(view.dom.querySelector('.cm-flash-prompt')?.textContent).toBe(`Jump: ${query}`)
        // A one-character query is completely occupied by its replacement
        // label, so there may be no remaining `.cm-flash-match` text span.
        expect(renderedTargets(view)).toHaveLength(matchCount)
      }

      expect(routeKey(view, labelAt(view, 20))).toBe(true)
      expect(view.state.selection.main.head).toBe(20)
    })

    it('replaces the source glyph with a baseline-sized label widget', () => {
      const view = mount('abcd abcd')

      expect(startVimFlashJump(view)).toBe(true)
      typeJumpQuery(view, 'ab')

      const label = view.dom.querySelector<HTMLElement>('.cm-flash-label')
      const source = label?.querySelector<HTMLElement>('.cm-flash-label-source')
      const hint = label?.querySelector<HTMLElement>('.cm-flash-label-hint')

      expect(label?.getAttribute('contenteditable')).toBe('false')
      // The original glyph only remains as an invisible sizing element; it is
      // no longer a highlighted Markdown text node that can bleed through.
      expect(source?.textContent).toBe('a')
      expect(hint?.textContent).toBe(label?.dataset.flashLabel)
      expect(label?.childNodes).toHaveLength(2)
    })

    it('keeps replacement labels inside heading and strong text styling', () => {
      const doc = '# **ABCD**'
      const view = mount(doc, 0, [
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(flashTestHighlight)
      ])
      forceParsing(view, doc.length, 5000)

      startVimFlashJump(view)
      typeJumpQuery(view, 'ab')

      const label = view.dom.querySelector<HTMLElement>('.cm-flash-label')
      expect(label?.classList.contains('tok-heading1')).toBe(true)
      expect(label?.classList.contains('tok-strong')).toBe(true)
      expect(label?.querySelector('.cm-flash-label-source')?.textContent).toBe('A')
    })

    it('matches inline math case-insensitively, reserves refinements, and reveals the source', async () => {
      const doc = 'start $ABCD$ end'
      const formulaFrom = doc.indexOf('$')
      const view = mountMath(doc)
      const formula = view.dom.querySelector<HTMLElement>('.cm-math-inline')

      expect(formula?.dataset.mathSource).toBe('ABCD')
      expect(startVimFlashJump(view)).toBe(true)
      typeJumpQuery(view, 'ab')
      await settleViewMeasure(view)

      const initialLabel = labelAt(view, formulaFrom + 1)
      expect(initialLabel).not.toBe('c')
      expect(formula?.classList.contains('cm-flash-math-match')).toBe(true)
      expect(
        formula?.querySelector('.cm-flash-math-overlay-layer > .cm-flash-math-label')
      ).not.toBeNull()

      // `c` continues ABCD instead of prematurely selecting the formula.
      expect(routeKey(view, 'c')).toBe(true)
      await settleViewMeasure(view)
      expect(view.dom.querySelector('.cm-flash-prompt')?.textContent).toBe('Jump: abc')

      expect(routeKey(view, labelAt(view, formulaFrom + 1))).toBe(true)
      expect(view.state.selection.main.head).toBe(formulaFrom + 1)
      expect(isVimFlashActive(view)).toBe(false)
      expect(formula?.classList.contains('cm-flash-math-match')).toBe(false)
      // The matching source character is now selected, so live preview reveals
      // the formula without making the jump settle at its opening delimiter.
      expect(view.dom.querySelector('.cm-math-inline')).toBeNull()
    })

    it('creates separate labels for repeated matches inside one formula and jumps exactly', async () => {
      const doc = 'start $\\sum_{i=1}^{n} i + \\sum_{j=1}^{m} j$ end'
      const firstMatch = doc.indexOf('sum')
      const secondMatch = doc.lastIndexOf('sum')
      const view = mountMath(doc)
      const formula = view.dom.querySelector<HTMLElement>('.cm-math-inline')
      const renderedBefore = formula?.querySelector('.katex-html')?.innerHTML

      startVimFlashJump(view)
      typeJumpQuery(view, 'su')
      await settleViewMeasure(view)

      const targets = renderedTargets(view).filter(
        (target) => target.position === firstMatch || target.position === secondMatch
      )
      expect(targets).toHaveLength(2)
      expect(new Set(targets.map((target) => target.label)).size).toBe(2)
      const labels = Array.from(
        formula?.querySelectorAll<HTMLElement>('.cm-flash-math-label') ?? []
      )
      expect(labels).toHaveLength(2)
      expect(new Set(labels.map((label) => `${label.style.left}:${label.style.top}`)).size).toBe(2)
      expect(labels.map((label) => label.dataset.flashLabel)).not.toContain('m')
      // Overlay nodes live beside KaTeX's output and never rewrite it.
      expect(formula?.querySelector('.katex-html')?.innerHTML).toBe(renderedBefore)

      // `m` still refines `su` to `sum`; it is never mistaken for a label.
      expect(routeKey(view, 'm')).toBe(true)
      await settleViewMeasure(view)
      expect(view.dom.querySelector('.cm-flash-prompt')?.textContent).toBe('Jump: sum')

      expect(routeKey(view, labelAt(view, secondMatch))).toBe(true)
      expect(view.state.selection.main.head).toBe(secondMatch)
      expect(view.dom.querySelector('.cm-math-inline')).toBeNull()
    })

    it('keeps repeated rendered-only matches distinct', async () => {
      const doc = 'start $\\pi+\\pi$ end'
      const firstSource = doc.indexOf('\\pi')
      const secondSource = doc.lastIndexOf('\\pi')
      const view = mountMath(doc)

      startVimFlashJump(view)
      typeJumpQuery(view, 'π')
      await settleViewMeasure(view)

      expect(
        renderedTargets(view)
          .map((target) => target.position)
          .sort((a, b) => a - b)
      ).toEqual([firstSource, secondSource])
    })

    it('combines literal raw and command-rendered occurrences in one formula', async () => {
      const doc = 'start $π + \\pi$ end'
      const literalSource = doc.indexOf('π')
      const commandSource = doc.indexOf('\\pi')
      const view = mountMath(doc)

      startVimFlashJump(view)
      typeJumpQuery(view, 'π')
      await settleViewMeasure(view)

      expect(
        renderedTargets(view)
          .map((target) => target.position)
          .sort((a, b) => a - b)
      ).toEqual([literalSource, commandSource])
    })

    it('searches both raw LaTeX and rendered KaTeX text and cleans up on Escape', async () => {
      const doc = 'start $\\pi + z$ end'
      const formulaFrom = doc.indexOf('$')
      const view = mountMath(doc)
      const formula = view.dom.querySelector<HTMLElement>('.cm-math-inline')

      expect(formula?.querySelector('.katex-html')?.textContent).toContain('π')

      startVimFlashJump(view)
      typeJumpQuery(view, 'pi')
      await settleViewMeasure(view)
      expect(labelAt(view, formulaFrom + 2)).toBeTruthy()
      expect(formula?.classList.contains('cm-flash-math-match')).toBe(true)

      expect(routeKey(view, 'Escape')).toBe(false)
      expect(formula?.classList.contains('cm-flash-math-match')).toBe(false)
      expect(formula?.querySelector('.cm-flash-math-label')).toBeNull()

      startVimFlashJump(view)
      typeJumpQuery(view, 'π')
      await settleViewMeasure(view)
      expect(renderedTargets(view)).toHaveLength(1)
    })

    it('matches and labels an occurrence inside rendered block math', async () => {
      const doc = 'top\n\n$$\nABC + \\pi\n$$\n\nbottom'
      const formulaFrom = doc.indexOf('$$')
      const view = mountMath(doc)
      const formula = view.dom.querySelector<HTMLElement>('.cm-math-block')

      expect(formula?.dataset.mathSource).toBe('\nABC + \\pi\n')
      startVimFlashJump(view)
      typeJumpQuery(view, 'abc')
      await settleViewMeasure(view)

      expect(labelAt(view, formulaFrom + 3)).toBeTruthy()
      expect(formula?.classList.contains('cm-flash-math-match')).toBe(true)
      expect(
        formula?.querySelector('.cm-flash-math-overlay-layer > .cm-flash-math-label')
      ).not.toBeNull()
      expect(formula?.querySelector('.katex-display > .cm-flash-math-overlay-layer')).not.toBeNull()
    })

    it('jumps to exact occurrences inside indented block math', async () => {
      const doc = 'top\n\n   $$\nalpha + alpha\n   $$   \n\nbottom'
      const firstMatch = doc.indexOf('alpha')
      const secondMatch = doc.lastIndexOf('alpha')
      const view = mountMath(doc)

      startVimFlashJump(view)
      typeJumpQuery(view, 'alpha')
      await settleViewMeasure(view)

      expect(
        renderedTargets(view)
          .map((target) => target.position)
          .sort((a, b) => a - b)
      ).toEqual([firstMatch, secondMatch])

      expect(routeKey(view, labelAt(view, secondMatch))).toBe(true)
      expect(view.state.selection.main.head).toBe(secondMatch)
      expect(view.dom.querySelector('.cm-math-block')).toBeNull()
    })

    it('reapplies formula targets after the math widget DOM is remounted', async () => {
      const doc = 'start $ABCD$ end'
      const math = new Compartment()
      const view = mount(doc, 0, [
        markdown({ base: markdownLanguage, extensions: mathMarkdownSyntax }),
        math.of(mathRenderExtension)
      ])
      forceParsing(view, doc.length, 5000)
      view.dispatch({ changes: { from: doc.length, insert: ' ' } })
      view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })

      startVimFlashJump(view)
      typeJumpQuery(view, 'abc')
      await settleViewMeasure(view)
      const original = view.dom.querySelector<HTMLElement>('.cm-math-inline')
      expect(original?.classList.contains('cm-flash-math-match')).toBe(true)

      view.dispatch({ effects: math.reconfigure([]) })
      expect(view.dom.querySelector('.cm-math-inline')).toBeNull()
      view.dispatch({ effects: math.reconfigure(mathRenderExtension) })
      await settleViewMeasure(view)

      const remounted = view.dom.querySelector<HTMLElement>('.cm-math-inline')
      expect(remounted).not.toBe(original)
      expect(remounted?.classList.contains('cm-flash-math-match')).toBe(true)
      expect(remounted?.querySelector('.cm-flash-math-label')).not.toBeNull()
      expect(labelAt(view, doc.indexOf('$') + 1)).toBeTruthy()
    })

    it('clears the prompt and highlights on Escape', () => {
      const view = mount('cat dog cat')
      startVimFlashJump(view)
      typeJumpQuery(view, 'cat')

      expect(view.dom.classList.contains('cm-flash-jump-active')).toBe(true)

      // Escape clears Flash but deliberately falls through to Vim as well.
      expect(routeKey(view, 'Escape')).toBe(false)
      expect(isVimFlashActive(view)).toBe(false)
      expect(view.dom.classList.contains('cm-flash-jump-active')).toBe(false)
      expect(view.dom.querySelectorAll('.cm-flash-match')).toHaveLength(0)
      expect(view.dom.querySelectorAll('.cm-flash-label')).toHaveLength(0)
      expect((view.dom.querySelector('.cm-flash-prompt') as HTMLElement | null)?.hidden).toBe(true)
    })
  })

  describe('enhanced f/F repeats', () => {
    it('repeats a stock forward f{char} with f and reverses it with F', async () => {
      const view = mount('a x x x')

      // Use the real DOM route here: codemirror-vim publishes `vim-keypress`
      // after its view plugin handles the key, which is how Flash observes the
      // otherwise stock f{char} motion.
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(view.state.selection.main.head).toBe(2)
      expect(isVimFlashActive(view)).toBe(true)
      expect(view.dom.querySelectorAll('.cm-flash-char-match')).toHaveLength(3)

      expect(routeKey(view, 'f')).toBe(true)
      expect(view.state.selection.main.head).toBe(4)
      expect(routeKey(view, 'F')).toBe(true)
      expect(view.state.selection.main.head).toBe(2)
    })

    it('keeps native Vim character matching case-sensitive', async () => {
      const view = mount('a x X x')

      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(view.state.selection.main.head).toBe(2)
      expect(view.dom.querySelectorAll('.cm-flash-char-match')).toHaveLength(2)

      expect(routeKey(view, 'f')).toBe(true)
      expect(view.state.selection.main.head).toBe(6)
      expect(routeKey(view, 'F')).toBe(true)
      expect(view.state.selection.main.head).toBe(2)
    })

    it('keeps the initial backward direction for F{char}', async () => {
      const view = mount('a x x x', 6)

      dispatchVimKey(view, 'F')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(view.state.selection.main.head).toBe(4)
      expect(routeKey(view, 'f')).toBe(true)
      expect(view.state.selection.main.head).toBe(2)
      expect(routeKey(view, 'F')).toBe(true)
      expect(view.state.selection.main.head).toBe(4)
    })

    it('applies a pending count to the enhanced repeat', async () => {
      const view = mount('a x x x x')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(routeKey(view, '2')).toBe(false)
      expect(routeKey(view, 'f')).toBe(true)

      expect(view.state.selection.main.head).toBe(6)
    })

    it('consumes a failed repeat count before the next Vim motion', async () => {
      const view = mount('a x abc')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(routeKey(view, '5')).toBe(false)
      expect(routeKey(view, 'f')).toBe(true)
      expect(view.state.selection.main.head).toBe(2)

      expect(routeKey(view, 'l')).toBe(false)
      expect(view.state.selection.main.head).toBe(3)
    })

    it('cancels a failed pending operator without editing', async () => {
      const view = mount('a x abc')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(routeKey(view, 'd')).toBe(false)
      expect(routeKey(view, 'f')).toBe(true)

      expect(view.state.doc.toString()).toBe('a x abc')
      expect(getCM(view)?.state.vim?.inputState.operator).toBeFalsy()
      expect(isVimFlashActive(view)).toBe(false)
    })

    it('does not enter insert mode when a pending change has no repeat target', async () => {
      const view = mount('a x abc')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(routeKey(view, 'c')).toBe(false)
      expect(routeKey(view, 'f')).toBe(true)

      expect(view.state.doc.toString()).toBe('a x abc')
      expect(getCM(view)?.state.vim?.insertMode).toBe(false)
      expect(getCM(view)?.state.vim?.inputState.operator).toBeFalsy()
    })

    it('does not steal f/F used as another Vim command literal', async () => {
      const view = mount('a x x')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(routeKey(view, 'r')).toBe(false)
      expect(routeKey(view, 'f')).toBe(false)

      expect(view.state.doc.toString()).toBe('a f x')
      expect(isVimFlashActive(view)).toBe(false)
    })

    it('does not arm when a failed f/F leaves the cursor on the same character', async () => {
      const view = mount('x abc')

      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(view.state.selection.main.head).toBe(0)
      expect(isVimFlashActive(view)).toBe(false)
    })

    it('clears character highlights after an unrelated Vim motion', async () => {
      const view = mount('a x x x')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(routeKey(view, 'l')).toBe(false)
      expect(view.state.selection.main.head).toBe(3)
      expect(isVimFlashActive(view)).toBe(false)
      expect(view.dom.querySelectorAll('.cm-flash-char-match')).toHaveLength(0)
    })

    it('clears character highlights when the document changes', async () => {
      const view = mount('a x x x')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      view.dispatch({ changes: { from: view.state.doc.length, insert: '!' } })

      expect(isVimFlashActive(view)).toBe(false)
      expect(view.dom.querySelectorAll('.cm-flash-char-match')).toHaveLength(0)
    })

    it('treats Ctrl+C as Escape for an active session', async () => {
      const view = mount('a x x')
      dispatchVimKey(view, 'f')
      dispatchVimKey(view, 'x')
      await settleCharacterSearch()

      expect(
        handleVimFlashKey(
          view,
          new KeyboardEvent('keydown', {
            key: 'c',
            code: 'KeyC',
            ctrlKey: true,
            bubbles: true,
            cancelable: true
          })
        )
      ).toBe(false)
      expect(isVimFlashActive(view)).toBe(false)
    })
  })

  describe('Vim mode and operator preservation', () => {
    it('extends a visual selection through the resolved jump target', () => {
      const view = mount('zero cat middle cat end')
      pressVim(view, 'v')
      startVimFlashJump(view)
      typeJumpQuery(view, 'cat')

      routeKey(view, labelAt(view, 16))

      expect(view.state.selection.main).toMatchObject({ from: 0, to: 17 })
    })

    it('completes a pending operator through the resolved jump target', () => {
      const view = mount('zero cat middle cat end')
      pressVim(view, 'd')
      expect(startVimFlashJump(view)).toBe(true)
      typeJumpQuery(view, 'cat')

      routeKey(view, labelAt(view, 5))

      expect(view.state.doc.toString()).toBe('at middle cat end')
      expect(view.state.selection.main.head).toBe(0)
      expect(isVimFlashActive(view)).toBe(false)
    })
  })
})
