// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  assignMathMatchAnchors,
  collectKatexGlyphs,
  placeMathMatches,
  tokenizeLatex,
  type MathVisualAnchor,
  type MathVisualRect
} from './cm-vim-flash-math'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({})
  } as DOMRect
}

function setRect(element: Element, left: number, top: number, width: number, height: number): void {
  element.getBoundingClientRect = () => rect(left, top, width, height)
}

function anchor(index: number, left = index * 10): MathVisualAnchor {
  const element = document.createElement('span')
  const visualRect: MathVisualRect = {
    left,
    top: 5,
    right: left + 8,
    bottom: 17,
    width: 8,
    height: 12
  }
  return {
    element,
    rect: visualRect,
    text: String(index),
    index,
    synthetic: false
  }
}

describe('Vim Flash math placement', () => {
  it('tokenizes control words generically and keeps UTF-16 source offsets', () => {
    expect(tokenizeLatex('\\sum x\\% α 😀')).toEqual([
      { from: 0, to: 4, text: '\\sum', kind: 'control-word' },
      { from: 4, to: 5, text: ' ', kind: 'whitespace' },
      { from: 5, to: 6, text: 'x', kind: 'character' },
      { from: 6, to: 8, text: '\\%', kind: 'control-symbol' },
      { from: 8, to: 9, text: ' ', kind: 'whitespace' },
      { from: 9, to: 10, text: 'α', kind: 'character' },
      { from: 10, to: 11, text: ' ', kind: 'whitespace' },
      { from: 11, to: 13, text: '😀', kind: 'character' }
    ])
  })

  it('collects visible glyph boxes and excludes KaTeX sizing artifacts', () => {
    const root = document.createElement('span')
    root.innerHTML = `
      <span class="katex-html">
        <span id="first">f</span>
        <span id="pair">ab</span>
        <span id="sizing" class="strut">X</span>
        <span id="zero">Z</span>
        <span id="invisible">&#x200B;</span>
        <span id="hidden" style="display: none">H</span>
      </span>
    `
    setRect(root.querySelector('#first')!, 10, 20, 8, 12)
    setRect(root.querySelector('#pair')!, 20, 20, 20, 12)
    setRect(root.querySelector('#sizing')!, 40, 20, 10, 12)
    setRect(root.querySelector('#zero')!, 50, 20, 0, 12)
    setRect(root.querySelector('#invisible')!, 60, 20, 10, 12)
    setRect(root.querySelector('#hidden')!, 70, 20, 10, 12)

    const glyphs = collectKatexGlyphs(root)

    expect(glyphs.map((glyph) => glyph.text)).toEqual(['f', 'a', 'b'])
    expect(glyphs.map((glyph) => glyph.rect.left)).toEqual([10, 20, 30])
    expect(glyphs.map((glyph) => glyph.rect.width)).toEqual([8, 10, 10])
    expect(glyphs.every((glyph) => !glyph.synthetic)).toBe(true)
  })

  it('does not collect an existing Flash overlay when KaTeX has no HTML output', () => {
    const root = document.createElement('span')
    root.innerHTML = `
      <span id="error" class="katex-error">bad formula</span>
      <span class="cm-flash-math-overlay-layer">
        <span id="hint" class="cm-flash-math-label">h</span>
      </span>
    `
    setRect(root.querySelector('#error')!, 10, 20, 88, 12)
    setRect(root.querySelector('#hint')!, 10, 20, 8, 12)

    expect(
      collectKatexGlyphs(root)
        .map((glyph) => glyph.text)
        .join('')
    ).toBe('badformula')
  })

  it('places repeated raw commands at distinct visual anchors in source order', () => {
    const placements = assignMathMatchAnchors(
      '\\sum+\\sum',
      [
        { from: 1, to: 3 },
        { from: 6, to: 8 }
      ],
      [anchor(0), anchor(1), anchor(2)]
    )

    expect(placements.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: 1, to: 3 },
      { from: 6, to: 8 }
    ])
    expect(placements.map((placement) => placement.anchorIndex)).toEqual([0, 2])
    expect(placements.map((placement) => placement.sourceTokenIndex)).toEqual([0, 2])
    expect(placements.every((placement) => placement.collisionCount === 1)).toBe(true)
  })

  it('keeps repeated sum commands near their rendered operator regions', () => {
    const source = 'f(n)=\\sum_{i=1}^{n} i + \\sum_{j=1}^{m} j'
    const first = source.indexOf('su')
    const second = source.lastIndexOf('su')
    // KaTeX's DOM emits display-operator limits before the operator glyph.
    // Structural LaTeX tokens (`{`, `}`, `_`, `^`) have no glyph of their own,
    // so generic token order still keeps each hint inside its own sum region.
    const glyphs = [
      'f',
      '(',
      'n',
      ')',
      '=',
      'i',
      '=',
      '1',
      '∑',
      'n',
      'i',
      '+',
      'j',
      '=',
      '1',
      '∑',
      'm',
      'j'
    ].map((text, index) => ({ ...anchor(index), text }))

    const placements = assignMathMatchAnchors(
      source,
      [
        { from: first, to: first + 2 },
        { from: second, to: second + 2 }
      ],
      glyphs
    )

    expect(placements.map((placement) => placement.anchor.text)).toEqual(['i', 'j'])
    expect(placements.map((placement) => placement.anchorIndex)).toEqual([5, 12])
  })

  it('uses unique neighboring anchors for multiple matches in one source token', () => {
    const placements = assignMathMatchAnchors(
      '\\foobar',
      [
        { from: 1, to: 3 },
        { from: 3, to: 5 }
      ],
      [anchor(0), anchor(1), anchor(2)]
    )

    expect(new Set(placements.map((placement) => placement.anchorIndex)).size).toBe(2)
    expect(placements[0].anchorIndex).toBeLessThan(placements[1].anchorIndex)
  })

  it('adds stable offsets when there are more matches than glyph anchors', () => {
    const placements = assignMathMatchAnchors(
      'aaa',
      [
        { from: 0, to: 1 },
        { from: 1, to: 2 },
        { from: 2, to: 3 }
      ],
      [anchor(0)]
    )

    expect(placements.map((placement) => placement.collisionIndex)).toEqual([0, 1, 2])
    expect(placements.every((placement) => placement.collisionCount === 3)).toBe(true)
    expect(placements.map((placement) => placement.offsetX)).toEqual([0, 8, -8])
    expect(placements[0].offsetY).toBe(0)
  })

  it('falls back to proportional formula-box anchors without mutating the DOM', () => {
    const root = document.createElement('span')
    root.className = 'cm-math-inline'
    setRect(root, 10, 20, 100, 18)
    const before = root.outerHTML

    const placements = placeMathMatches(root, 'abc xyz', [
      { from: 0, to: 1 },
      { from: 6, to: 7 }
    ])

    expect(placements).toHaveLength(2)
    expect(placements.every((placement) => placement.anchor.synthetic)).toBe(true)
    expect(placements[0].anchor.rect.left).toBeLessThan(placements[1].anchor.rect.left)
    expect(placements[0].from).toBe(0)
    expect(placements[1].from).toBe(6)
    expect(root.outerHTML).toBe(before)
  })
})
