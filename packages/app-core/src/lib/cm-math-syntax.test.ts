import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'
import { mathMarkdownSyntax } from './cm-math-syntax'

const parser = markdown({
  base: markdownLanguage,
  extensions: mathMarkdownSyntax,
  addKeymap: false
}).language.parser

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
    const doc = ['Use `$H^*(X)$` literally.', '', '```md', '$$', 'H^*(Y)', '$$', '```'].join(
      '\n'
    )

    expect(nodeText(doc, 'InlineMath')).toEqual([])
    expect(nodeText(doc, 'BlockMath')).toEqual([])
    expect(nodeText(doc, 'InlineCode')).toEqual(['`$H^*(X)$`'])
    expect(nodeText(doc, 'FencedCode')).toHaveLength(1)
  })

  it('leaves escaped and unclosed inline dollar delimiters as Markdown text', () => {
    const doc = String.raw`Escaped \$H^*(X)$.

Unclosed $H^*(Y)`

    expect(nodeText(doc, 'InlineMath')).toEqual([])
  })

  it('contains an unclosed display formula through the end of the document', () => {
    const doc = 'before\n\n$$\nH^*(X)\nstill math'

    expect(parser.parse(doc).toString()).toBe('Document(Paragraph,BlockMath)')
    expect(nodeText(doc, 'BlockMath')).toEqual(['$$\nH^*(X)\nstill math'])
    expect(nodeText(doc, 'Emphasis')).toEqual([])
  })

  it('leaves four-space-indented math fences inside an indented code block', () => {
    const doc = '    $$\n    H^*(X)\n    $$'

    expect(nodeText(doc, 'BlockMath')).toEqual([])
    expect(nodeText(doc, 'CodeBlock')).toHaveLength(1)
  })
})
