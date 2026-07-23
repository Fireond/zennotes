import type { EditorState } from '@codemirror/state'
import { embedBlockLineRanges } from './cm-embed-render'
import { mathBlockLineRanges } from './cm-math-render'
import { tikzBlockLineRanges } from './cm-tikz-render'

/** A document-line span managed by one live-preview block widget. */
export interface RenderedBlockLineRange {
  fromLine: number
  toLine: number
}

/**
 * Every source range managed by a block replacement widget. The active block
 * may currently be revealed, but retaining its range lets navigation detect
 * that the cursor is already inside it and use ordinary visual-line motion.
 *
 * Each renderer owns its own StateField and returns an empty list when that
 * field is not installed, so this helper is safe in editors that enable only a
 * subset of the rich-markdown extensions.
 */
export function renderedBlockLineRanges(
  state: EditorState
): readonly RenderedBlockLineRange[] {
  return [
    ...mathBlockLineRanges(state),
    ...tikzBlockLineRanges(state),
    ...embedBlockLineRanges(state)
  ].sort(
    (a, b) => a.fromLine - b.fromLine || a.toLine - b.toLine
  )
}
