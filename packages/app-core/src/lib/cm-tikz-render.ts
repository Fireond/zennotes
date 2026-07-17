/**
 * TikZ block rendering for the editor's live-preview mode.
 *
 * A complete fenced `tikz` block is replaced with its compiled SVG while the
 * cursor is elsewhere. Moving the cursor/selection into the block removes the
 * replacement and reveals the exact Markdown source, matching block KaTeX.
 * Compilation is asynchronous, so every widget guards its DOM lifecycle and
 * asks CodeMirror to remeasure after loading changes its height.
 *
 * WYSIWYG-only: registered through `wysiwygExtensions()` in EditorPane.
 */
import { syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { sanitizeTikzSvg, tintTikzSvg } from './diagram-renderers'

const OPEN_FENCE_RE = /^\s*(`{3,}|~{3,})\s*([^\s`~]*)/
const widgetTokens = new WeakMap<HTMLElement, object>()
const widgetThemeObservers = new WeakMap<HTMLElement, MutationObserver>()

export interface TikzBlockLineRange {
  fromLine: number
  toLine: number
}

interface ParsedTikzBlock {
  from: number
  to: number
  sourceFrom: number
  source: string
  fromLine: number
  toLine: number
}

interface TikzRenderValue {
  decorations: DecorationSet
  blocks: readonly ParsedTikzBlock[]
  /** Every complete non-empty TikZ fence, rendered or currently revealed. */
  blockLines: readonly TikzBlockLineRange[]
}

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some(
    (range) => Math.max(range.from, from) <= Math.min(range.to, to)
  )
}

function parseTikzBlock(state: EditorState, node: SyntaxNode): ParsedTikzBlock | null {
  const doc = state.doc
  const openingLine = doc.lineAt(node.from)
  // `FencedCode.from` starts at the marker, after any blockquote/list prefix.
  // Match from that structural offset rather than the physical line start so
  // valid nested fences (`> ```tikz`, `- ```tikz`) work too.
  const opening = doc.sliceString(node.from, openingLine.to).match(OPEN_FENCE_RE)
  if (!opening || opening[2].toLowerCase() !== 'tikz') return null

  const openingMark = node.firstChild
  const closingMark = node.lastChild
  if (openingMark?.name !== 'CodeMark' || closingMark?.name !== 'CodeMark') return null
  const openingMarker = doc.sliceString(openingMark.from, openingMark.to)
  const closingMarker = doc.sliceString(closingMark.from, closingMark.to)

  const closingLine = doc.lineAt(Math.max(node.from, node.to - 1))
  if (closingLine.number <= openingLine.number) return null
  // Markdown fences must close with the same marker and at least as many
  // characters as the opener. Checking again here keeps incomplete fences raw
  // even if the incremental syntax tree temporarily spans to EOF.
  if (
    closingMarker[0] !== openingMarker[0] ||
    closingMarker.length < openingMarker.length
  ) {
    return null
  }

  // CodeText nodes contain the exact logical code content, including line
  // breaks, but exclude Markdown container prefixes such as `> ` and list
  // indentation. Concatenating the direct children therefore mirrors what the
  // preview Markdown parser passes to the TikZ renderer.
  const sourceParts: string[] = []
  let sourceFrom: number | null = null
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name !== 'CodeText') continue
    sourceFrom ??= child.from
    sourceParts.push(doc.sliceString(child.from, child.to))
  }
  const source = sourceParts.join('')
  if (!source.trim()) return null

  return {
    from: openingLine.from,
    to: closingLine.to,
    sourceFrom: sourceFrom ?? doc.line(openingLine.number + 1).from,
    source,
    fromLine: openingLine.number,
    toLine: closingLine.number
  }
}

function setWidgetError(root: HTMLElement, message: string): void {
  const error = document.createElement('pre')
  error.className = 'zen-diagram-error'
  error.textContent = `TikZ error: ${message}`
  root.replaceChildren(error)
}

class TikzBlockWidget extends WidgetType {
  constructor(readonly source: string) {
    super()
  }

  eq(other: TikzBlockWidget): boolean {
    // Position changes above an otherwise-identical block must not remount its
    // async DOM, flash the loading state, or issue another bridge request.
    return other.source === this.source
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div')
    root.className = 'cm-tikz-block'
    root.dataset.tikzSource = this.source
    root.setAttribute('contenteditable', 'false')
    root.setAttribute('aria-label', 'Rendered TikZ diagram; click to edit source')
    root.title = 'Click to edit TikZ source'

    const loading = document.createElement('div')
    loading.className = 'zen-tikz-loading text-[11px] opacity-60'
    loading.textContent = 'Rendering TikZ…'
    root.append(loading)

    const revealSource = (event: MouseEvent): void => {
      if (event.button !== 0) return
      event.preventDefault()
      event.stopPropagation()
      if (!root.isConnected) return
      let anchor = view.posAtDOM(root)
      const widgetLine = view.state.doc.lineAt(anchor).number
      const currentBlock = parseTikzBlocks(view.state).find(
        (block) => widgetLine >= block.fromLine && widgetLine <= block.toLine
      )
      if (currentBlock) anchor = currentBlock.sourceFrom
      view.dispatch({
        selection: { anchor: Math.min(anchor, view.state.doc.length) },
        scrollIntoView: true,
        userEvent: 'select.pointer'
      })
      view.focus()
    }
    root.addEventListener('mousedown', revealSource)

    const token = {}
    widgetTokens.set(root, token)
    const isCurrent = (): boolean => widgetTokens.get(root) === token && root.isConnected
    const remeasure = (): void => {
      if (isCurrent()) view.requestMeasure()
    }

    const render = window.zen?.renderTikz
    if (typeof render !== 'function') {
      setWidgetError(root, 'TikZ rendering is unavailable in this build')
      return root
    }

    void Promise.resolve()
      .then(() => (isCurrent() ? render(this.source) : null))
      .then((result) => {
        if (!result || !isCurrent()) return
        if (!result.ok || !result.svg) {
          setWidgetError(root, result.error ?? 'Unknown error')
          remeasure()
          return
        }
        const svg = sanitizeTikzSvg(result.svg)
        if (!svg) {
          setWidgetError(root, 'Renderer returned invalid SVG')
          remeasure()
          return
        }
        const applyTheme = (): void => {
          if (!isCurrent()) return
          root.innerHTML = svg
          tintTikzSvg(root)
          remeasure()
        }
        applyTheme()

        // Tinting maps TikZ's named colors into the active ZenNotes palette.
        // Rebuild from the pristine sanitized SVG when the palette changes so
        // colors do not remain stuck on the theme active at compile time.
        const observer = new MutationObserver(applyTheme)
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme', 'data-theme-mode']
        })
        widgetThemeObservers.set(root, observer)
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return
        setWidgetError(root, error instanceof Error ? error.message : 'Unknown error')
        remeasure()
      })

    return root
  }

  destroy(dom: HTMLElement): void {
    widgetTokens.delete(dom)
    widgetThemeObservers.get(dom)?.disconnect()
    widgetThemeObservers.delete(dom)
  }

  ignoreEvent(): boolean {
    return false
  }
}

function parseTikzBlocks(state: EditorState): ParsedTikzBlock[] {
  const blocks: ParsedTikzBlock[] = []
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return
      const block = parseTikzBlock(state, node.node)
      if (block) blocks.push(block)
      return false
    }
  })
  return blocks
}

function buildTikzRender(
  state: EditorState,
  blocks: readonly ParsedTikzBlock[] = parseTikzBlocks(state)
): TikzRenderValue {
  const pending: Array<{ from: number; to: number; decoration: Decoration }> = []
  const blockLines = blocks.map(({ fromLine, toLine }) => ({ fromLine, toLine }))

  for (const block of blocks) {
    if (!selectionTouches(state, block.from, block.to)) {
      pending.push({
        from: block.from,
        to: block.to,
        decoration: Decoration.replace({
          block: true,
          widget: new TikzBlockWidget(block.source)
        })
      })
    }
  }

  pending.sort((a, b) => a.from - b.from || a.to - b.to)
  const builder = new RangeSetBuilder<Decoration>()
  for (const item of pending) builder.add(item.from, item.to, item.decoration)
  return { decorations: builder.finish(), blocks, blockLines }
}

const tikzRenderField = StateField.define<TikzRenderValue>({
  create: (state) => buildTikzRender(state),
  update(value, transaction) {
    if (
      transaction.docChanged ||
      syntaxTree(transaction.startState) !== syntaxTree(transaction.state)
    ) {
      return buildTikzRender(transaction.state)
    }
    // Cursor-only moves are common and cannot change the parsed block list.
    // Reuse it so notes without TikZ pay O(1), and notes with TikZ pay only for
    // their handful of replacement decorations rather than a full tree walk.
    if (transaction.selection) return buildTikzRender(transaction.state, value.blocks)
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
})

/** Complete TikZ fence line ranges, even while one is revealed for editing. */
export function tikzBlockLineRanges(state: EditorState): readonly TikzBlockLineRange[] {
  return state.field(tikzRenderField, false)?.blockLines ?? []
}

export const tikzRenderExtension: Extension = [tikzRenderField]
