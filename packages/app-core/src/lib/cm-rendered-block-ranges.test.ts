import { EditorState } from '@codemirror/state'
import { describe, expect, it, vi } from 'vitest'

const ranges = vi.hoisted(() => ({
  math: [] as Array<{ fromLine: number; toLine: number }>,
  tikz: [] as Array<{ fromLine: number; toLine: number }>
}))

vi.mock('./cm-math-render', () => ({
  mathBlockLineRanges: () => ranges.math
}))

vi.mock('./cm-tikz-render', () => ({
  tikzBlockLineRanges: () => ranges.tikz
}))

import { renderedBlockLineRanges } from './cm-rendered-block-ranges'

describe('renderedBlockLineRanges', () => {
  it('combines math and TikZ ranges in document order', () => {
    ranges.math = [{ fromLine: 8, toLine: 10 }]
    ranges.tikz = [
      { fromLine: 14, toLine: 20 },
      { fromLine: 2, toLine: 5 }
    ]

    expect(renderedBlockLineRanges(EditorState.create())).toEqual([
      { fromLine: 2, toLine: 5 },
      { fromLine: 8, toLine: 10 },
      { fromLine: 14, toLine: 20 }
    ])
  })

  it('is empty when neither renderer owns a block', () => {
    ranges.math = []
    ranges.tikz = []

    expect(renderedBlockLineRanges(EditorState.create())).toEqual([])
  })
})
