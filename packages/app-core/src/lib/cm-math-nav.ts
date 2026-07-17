/**
 * Arrow-key navigation into rendered live-preview blocks.
 *
 * A rendered math or TikZ block is a block-replace widget with no cursor
 * coordinates inside it, so CodeMirror's pixel-based vertical motion
 * (`cursorLineUp`/`cursorLineDown`) skips clean over it — only a mouse click
 * could reveal the source. When the next logical line sits inside a rendered
 * block, step the cursor there directly; its renderer reveals the source in the
 * same transaction. Covers insert-mode and non-Vim editing; Vim's `j`/`k` get
 * the equivalent treatment in cm-vim-display-line.ts.
 */
import { completionStatus } from '@codemirror/autocomplete'
import type { EditorView, KeyBinding } from '@codemirror/view'
import { renderedBlockLineRanges } from './cm-rendered-block-ranges'

function moveIntoRenderedBlock(view: EditorView, dir: 1 | -1): boolean {
  const state = view.state
  // Never steal arrows from an open autocomplete popup.
  if (completionStatus(state) === 'active') return false
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const targetNumber = line.number + dir
  if (targetNumber < 1 || targetNumber > state.doc.lines) return false
  const block = renderedBlockLineRanges(state).find(
    (r) => targetNumber >= r.fromLine && targetNumber <= r.toLine
  )
  if (!block) return false
  // Inside the same (already revealed) block the default motion works; only
  // step in when the block is rendered, i.e. the cursor is outside its range.
  if (line.number >= block.fromLine && line.number <= block.toLine) return false
  const targetLine = state.doc.line(targetNumber)
  const column = Math.min(sel.head - line.from, targetLine.length)
  view.dispatch({
    selection: { anchor: targetLine.from + column },
    scrollIntoView: true,
    userEvent: 'select'
  })
  return true
}

export const renderedBlockArrowKeymap: readonly KeyBinding[] = [
  { key: 'ArrowDown', run: (view) => moveIntoRenderedBlock(view, 1) },
  { key: 'ArrowUp', run: (view) => moveIntoRenderedBlock(view, -1) }
]

// Kept for callers that imported the original math-only name.
export const mathBlockArrowKeymap = renderedBlockArrowKeymap
