import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  type StreamParser
} from '@codemirror/language'
import { stexMath } from '@codemirror/legacy-modes/mode/stex'
import { parseMixed, type Input, type SyntaxNodeRef } from '@lezer/common'
import { tags as t } from '@lezer/highlight'
import type { MarkdownConfig } from '@lezer/markdown'

type FenceLine = {
  text: string
  pos: number
}

type SourceRange = {
  from: number
  to: number
}

const MATH_OPERATOR_RE = /^[+\-<>|=,\/@!*:;'"`~#?]+$/u

/**
 * Keep the legacy sTeX tokenizer deliberately syntax-only.
 *
 * `stexMath` already handles the useful LaTeX categories, but its original
 * token names are geared toward complete TeX documents. Normalize them to the
 * app's shared CodeMirror palette, keep display math in math mode across blank
 * lines, and leave unknown/Unicode symbols as ordinary math source instead of
 * presenting them as invalid LaTeX.
 */
const latexMathStream: StreamParser<unknown> = {
  ...stexMath,
  blankLine() {
    // A blank line is still inside the surrounding Markdown BlockMath node.
  },
  token(stream, state) {
    const style = stexMath.token(stream, state)
    const token = stream.current()

    if (style === 'tag') {
      if (/^[\^_&]+$/u.test(token)) return 'operator'
      if (token.startsWith('\\')) return 'keyword'
    }
    // Plain identifiers inherit the scoped math-source color below rather than
    // the ordinary code-variable color.
    if (style === 'variableName.special') return null
    if (style === null && MATH_OPERATOR_RE.test(token)) return 'operator'

    // The legacy mode reports otherwise valid Unicode math characters and
    // incomplete input as errors. Highlighting should not pretend to lint.
    return style === 'error' ? null : style
  }
}

const latexMathLanguage = StreamLanguage.define(latexMathStream)
const latexMathParser = latexMathLanguage.parser

const latexMathHighlightStyle = HighlightStyle.define(
  [
    { tag: t.keyword, class: 'tok-math-command' },
    { tag: t.operator, class: 'tok-math-operator' },
    { tag: t.number, class: 'tok-math-number' },
    { tag: t.bracket, class: 'tok-math-bracket' },
    { tag: t.comment, class: 'tok-math-comment' }
  ],
  {
    scope: latexMathLanguage,
    all: 'tok-math-source'
  }
)

/** Theme-aware highlighting shared by every editor that installs the math grammar. */
export const mathSyntaxHighlighters = [latexMathHighlightStyle] as const

export const mathSyntaxHighlight = syntaxHighlighting(latexMathHighlightStyle)

/** Whether the next non-whitespace text is an own-line `$$` fence. */
function isOwnMathFence(line: FenceLine): boolean {
  return (
    line.text.slice(0, line.pos).trim() === '' && line.text.slice(line.pos).trim() === '$$'
  )
}

function inlineMathContent(node: SyntaxNodeRef): SourceRange | null {
  const from = node.from + 1
  const to = node.to - 1
  return from < to ? { from, to } : null
}

/** Return only the source between the opening and optional closing fence lines. */
function blockMathContent(node: SyntaxNodeRef, input: Input): SourceRange | null {
  const source = input.read(node.from, node.to)
  const openingLineEnd = source.indexOf('\n')
  if (openingLineEnd < 0) return null

  const from = node.from + openingLineEnd + 1
  const finalLineStart = source.lastIndexOf('\n') + 1
  const finalLine = source.slice(finalLineStart)
  const to = finalLine.trim() === '$$' ? node.from + finalLineStart : node.to

  return from < to ? { from, to } : null
}

const nestedLatexMath = parseMixed((node, input) => {
  const content =
    node.name === 'InlineMath'
      ? inlineMathContent(node)
      : node.name === 'BlockMath'
        ? blockMathContent(node, input)
        : null

  return content
    ? {
        parser: latexMathParser,
        overlay: [content],
        bracketed: true
      }
    : null
})

/**
 * Teach Lezer Markdown that math source is opaque Markdown content.
 *
 * The renderer recognizes math independently, but the base Markdown parser
 * must know these boundaries too. Otherwise an asterisk in one formula can
 * pair with an asterisk in a later formula and incorrectly create an Emphasis
 * node spanning the prose between them.
 */
export const mathMarkdownSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath' },
    { name: 'BlockMath', block: true }
  ],
  wrap: nestedLatexMath,
  parseBlock: [
    {
      name: 'BlockMath',
      // Leave indented code ahead of math while recognizing math before the
      // ordinary fenced-code parser.
      before: 'FencedCode',
      parse(cx, line) {
        if (!isOwnMathFence(line)) return false

        const from = cx.lineStart + line.pos
        while (cx.nextLine()) {
          if (!isOwnMathFence(line)) continue

          const to = cx.lineStart + line.text.length
          cx.nextLine()
          cx.addElement(cx.elt('BlockMath', from, to))
          return true
        }

        // Like an unclosed fenced code block, an unclosed display formula owns
        // the rest of the document. This also stops half-written LaTeX from
        // leaking Markdown emphasis into following text while it is edited.
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd()))
        return true
      },
      // A display formula can start immediately after prose without a blank
      // line, so its opening fence must terminate the current leaf paragraph.
      endLeaf(_cx, line) {
        return isOwnMathFence(line)
      }
    }
  ],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'Emphasis',
      parse(cx, next, pos) {
        // Match cm-math-render's `$...$` boundaries. Escape and InlineCode run
        // earlier, and these explicit checks also keep adjacent/escaped dollar
        // signs from becoming a math opener.
        if (
          next !== 36 ||
          cx.char(pos - 1) === 92 ||
          cx.char(pos - 1) === 36 ||
          cx.char(pos + 1) === 36 ||
          /\s/u.test(cx.slice(pos + 1, pos + 2))
        ) {
          return -1
        }

        for (let at = pos + 1; at < cx.end; at++) {
          const ch = cx.char(at)
          if (ch === 10 || ch === 13) return -1
          if (ch === 92) {
            // LaTeX escapes make the following character part of the formula,
            // including an escaped dollar sign.
            at++
            continue
          }
          if (ch === 36) {
            // The first unescaped dollar must be a valid close. Continuing past
            // an invalid one would disagree with the renderer's regular
            // expression, whose body cannot cross an unescaped dollar sign.
            if (cx.char(at + 1) === 36 || /\s/u.test(cx.slice(at - 1, at))) return -1
            return cx.addElement(cx.elt('InlineMath', pos, at + 1))
          }
        }

        return -1
      }
    }
  ]
}
