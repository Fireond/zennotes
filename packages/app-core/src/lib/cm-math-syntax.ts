import type { MarkdownConfig } from '@lezer/markdown'

type FenceLine = {
  text: string
  pos: number
}

/** Whether the next non-whitespace text is an own-line `$$` fence. */
function isOwnMathFence(line: FenceLine): boolean {
  return (
    line.text.slice(0, line.pos).trim() === '' && line.text.slice(line.pos).trim() === '$$'
  )
}

/**
 * Teach Lezer Markdown that math source is opaque Markdown content.
 *
 * The renderer recognizes math independently, but the base Markdown parser
 * must know these boundaries too. Otherwise an asterisk in one formula can
 * pair with an asterisk in a later formula and incorrectly create an Emphasis
 * node spanning the prose between them.
 */
export const mathMarkdownSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'BlockMath', block: true }],
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
