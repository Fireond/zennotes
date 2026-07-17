import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { highlightTree } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'
import { mathMarkdownSyntax, mathSyntaxHighlighters } from './cm-math-syntax'

const parser = markdown({
  base: markdownLanguage,
  extensions: mathMarkdownSyntax,
  addKeymap: false
}).language.parser

interface HighlightedRange {
  from: number
  to: number
  classes: string[]
}

function latexHighlights(doc: string): HighlightedRange[] {
  const result: HighlightedRange[] = []
  highlightTree(parser.parse(doc), mathSyntaxHighlighters, (from, to, classes) => {
    result.push({ from, to, classes: classes.split(/\s+/).filter(Boolean) })
  })
  return result
}

function highlightClassesAt(
  ranges: readonly HighlightedRange[],
  position: number
): string[] {
  return ranges
    .filter(({ from, to }) => from <= position && position < to)
    .flatMap(({ classes }) => classes)
}

function expectClassAt(
  doc: string,
  ranges: readonly HighlightedRange[],
  needle: string,
  className: string,
  offset = 0
): void {
  const position = doc.indexOf(needle)
  expect(
    position,
    `expected ${JSON.stringify(needle)} in test document`
  ).toBeGreaterThanOrEqual(0)
  expect(highlightClassesAt(ranges, position + offset)).toContain(className)
}

function nodeText(doc: string, nodeName: string): string[] {
  const result: string[] = []
  parser.parse(doc).iterate({
    enter(node) {
      if (node.name === nodeName) result.push(doc.slice(node.from, node.to))
    }
  })
  return result
}

describe('mathMarkdownSyntax', () => {
  it('syntax-highlights inline LaTeX without parsing its dollar delimiters as LaTeX', () => {
    const doc = String.raw`Before $\sum_{i=1}^{n} i + \alpha + π$ after.`
    const tree = parser.parse(doc)
    const ranges = latexHighlights(doc)
    const opening = doc.indexOf('$')
    const closing = doc.lastIndexOf('$')

    expectClassAt(doc, ranges, String.raw`\sum`, 'tok-math-command')
    expectClassAt(doc, ranges, String.raw`\sum`, 'tok-math-source')
    expectClassAt(doc, ranges, '{i', 'tok-math-bracket')
    expectClassAt(doc, ranges, 'i=1', 'tok-math-source')
    expectClassAt(doc, ranges, 'i=1', 'tok-math-operator', 1)
    expectClassAt(doc, ranges, '1', 'tok-math-number')
    expectClassAt(doc, ranges, String.raw`\alpha`, 'tok-math-command')
    expectClassAt(doc, ranges, 'π', 'tok-math-source')
    expectClassAt(doc, ranges, ' i +', 'tok-math-source')
    expect(highlightClassesAt(ranges, opening)).toEqual([])
    expect(highlightClassesAt(ranges, closing)).toEqual([])
    expect(tree.resolveInner(opening, 1).name).toBe('InlineMath')
    expect(tree.resolveInner(closing, 1).name).toBe('InlineMath')
  })

  it('keeps structural dollars unstyled while treating an escaped dollar as LaTeX', () => {
    const doc = String.raw`Value $\$ + x$ after`
    const ranges = latexHighlights(doc)
    const opening = doc.indexOf('$')
    const escaped = doc.indexOf('$', opening + 1)
    const closing = doc.lastIndexOf('$')

    expect(highlightClassesAt(ranges, opening)).toEqual([])
    expect(highlightClassesAt(ranges, escaped)).toContain('tok-math-command')
    expect(highlightClassesAt(ranges, closing)).toEqual([])
  })

  it('syntax-highlights multiline block LaTeX and excludes both fence lines', () => {
    const doc = String.raw`before
$$
\int_0^1 x\,dx
\frac{x}{2}
$$
after`
    const tree = parser.parse(doc)
    const ranges = latexHighlights(doc)
    const opening = doc.indexOf('$$')
    const closing = doc.lastIndexOf('$$')

    expectClassAt(doc, ranges, String.raw`\int`, 'tok-math-command')
    expectClassAt(doc, ranges, '0', 'tok-math-number')
    expectClassAt(doc, ranges, String.raw`\frac`, 'tok-math-command')
    expectClassAt(doc, ranges, '{x', 'tok-math-bracket')
    for (const position of [opening, opening + 1, closing, closing + 1]) {
      expect(highlightClassesAt(ranges, position)).toEqual([])
      expect(tree.resolveInner(position, 1).name).toBe('BlockMath')
    }
  })

  it('stays in math highlighting mode across blank lines and a spaced closing fence', () => {
    const doc = ['  $$   ', 'x_1', '', String.raw`y_2 + \beta`, '  $$   '].join(
      '\n'
    )
    const tree = parser.parse(doc)
    const ranges = latexHighlights(doc)
    const closing = doc.lastIndexOf('$$')

    expect(nodeText(doc, 'BlockMath')).toEqual([doc.slice(doc.indexOf('$$'))])
    expectClassAt(doc, ranges, 'x_1', 'tok-math-source')
    // `stexMath` normally resets to document mode on a blank line. A math
    // overlay must retain math mode so identifiers after it stay variables.
    expectClassAt(doc, ranges, 'y_2', 'tok-math-source')
    expectClassAt(doc, ranges, String.raw`\beta`, 'tok-math-command')
    expect(highlightClassesAt(ranges, closing)).toEqual([])
    expect(highlightClassesAt(ranges, closing + 1)).toEqual([])
    expect(tree.resolveInner(closing, 1).name).toBe('BlockMath')
  })

  it('keeps asterisks in separate block formulas from italicizing the prose between them', () => {
    const doc = String.raw`$$
H^*(X,\\{x\_0\\};R) \\otimes\_R H^*(Y,\{y_0\};R) \xrightarrow{\times} H^*(X\times Y,\{x_0\}\times Y \cup X \times\{y_0\};R),
$$
so we get an isomorphism
$$
\tilde{H}^*(X ;R) \\otimes\_R \\tilde{H}^*(Y ;R) \xrightarrow{\times}\tilde{H}^*(X \land Y ;R)
$$`

    const tree = parser.parse(doc)
    expect(tree.toString()).toBe('Document(BlockMath,Paragraph,BlockMath)')
    expect(nodeText(doc, 'Emphasis')).toEqual([])
    expect(nodeText(doc, 'Paragraph')).toEqual(['so we get an isomorphism'])
  })

  it('treats inline math as opaque while retaining ordinary Markdown emphasis', () => {
    const doc = 'Before $H^*(X)$ and *ordinary emphasis*.'

    expect(nodeText(doc, 'InlineMath')).toEqual(['$H^*(X)$'])
    expect(nodeText(doc, 'Emphasis')).toEqual(['*ordinary emphasis*'])
  })

  it('does not recognize math inside inline or fenced code', () => {
    const doc = [
      'Use `$H^*(X)$` literally.',
      '',
      '```md',
      '$$',
      'H^*(Y)',
      '$$',
      '```'
    ].join('\n')

    expect(nodeText(doc, 'InlineMath')).toEqual([])
    expect(nodeText(doc, 'BlockMath')).toEqual([])
    expect(nodeText(doc, 'InlineCode')).toEqual(['`$H^*(X)$`'])
    expect(nodeText(doc, 'FencedCode')).toHaveLength(1)
    expect(latexHighlights(doc)).toEqual([])
  })

  it('leaves escaped and unclosed inline dollar delimiters as Markdown text', () => {
    const doc = String.raw`Escaped \$H^*(X)$.

Unclosed $H^*(Y)`

    expect(nodeText(doc, 'InlineMath')).toEqual([])
  })

  it('contains an unclosed display formula through the end of the document', () => {
    const doc = String.raw`before

$$
H^*(X)
still math + z_9`
    const ranges = latexHighlights(doc)

    expect(parser.parse(doc).toString()).toBe('Document(Paragraph,BlockMath)')
    expect(nodeText(doc, 'BlockMath')).toEqual([
      String.raw`$$
H^*(X)
still math + z_9`
    ])
    expect(nodeText(doc, 'Emphasis')).toEqual([])
    expectClassAt(doc, ranges, 'still', 'tok-math-source')
    expectClassAt(doc, ranges, 'z_9', 'tok-math-source')
    expectClassAt(doc, ranges, '9', 'tok-math-number')
    expect(highlightClassesAt(ranges, doc.indexOf('$$'))).toEqual([])
  })

  it('leaves four-space-indented math fences inside an indented code block', () => {
    const doc = '    $$\n    H^*(X)\n    $$'

    expect(nodeText(doc, 'BlockMath')).toEqual([])
    expect(nodeText(doc, 'CodeBlock')).toHaveLength(1)
    expect(latexHighlights(doc)).toEqual([])
  })
})
