import { describe, expect, it } from 'vitest'
import { compileTikz, wrapTikzSource } from './tikz-compiler'

describe('wrapTikzSource', () => {
  it('keeps a complete document while removing its document class', () => {
    expect(
      wrapTikzSource(String.raw`\documentclass{article}
\usepackage{tikz-cd}
\begin{document}
\begin{tikzcd} A \arrow[r] & B \end{tikzcd}
\end{document}`)
    ).toBe(String.raw`\usepackage{tikz-cd}
\begin{document}
\begin{tikzcd} A \arrow[r] & B \end{tikzcd}
\end{document}`)
  })

  it('keeps preamble commands outside the generated document body', () => {
    expect(
      wrapTikzSource(String.raw`\usepackage{tikz-cd,amssymb}
\begin{tikzcd} A \arrow[r] & B \end{tikzcd}`)
    ).toBe(String.raw`\usepackage{tikz-cd,amssymb}
\begin{document}
\begin{tikzcd} A \arrow[r] & B \end{tikzcd}
\end{document}`)
  })

  it('wraps a bare TikZ picture in a document', () => {
    expect(wrapTikzSource(String.raw`\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}`))
      .toBe(String.raw`\begin{document}
\begin{tikzpicture}\draw (0,0)--(1,1);\end{tikzpicture}
\end{document}`)
  })
})

describe('compileTikz', () => {
  it('renders a full tikz-cd document with an explicit package preamble', async () => {
    const result = await compileTikz(String.raw`\usepackage{tikz-cd,amssymb}
\begin{document}
  \begin{tikzcd}
  \cdots \arrow[r, ""] & h^{n-1}(X) \arrow[r, ""] \arrow[d, ""] & h^{n-1}(A) \arrow[r, ""] \arrow[d, ""] & h^{n}(X,A) \arrow[r, ""] \arrow[d, ""] & h^{n}(X) \arrow[r, ""]\arrow[d, ""] & h^{n}(A) \arrow[r, ""] \arrow[d, ""] & \cdots \\
\cdots \arrow[r, ""] & k ^{n-1}(X) \arrow[r, ""] & k ^{n-1}(A) \arrow[r, ""] & k ^{n} (X,A) \arrow[r, ""] & k ^{n} (X) \arrow[r, ""] & k ^{n}(A) \arrow[r, ""] & \cdots
  \end{tikzcd}
\end{document}`)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.error)
    expect(result.svg).toMatch(/^<svg\b/)
    expect(result.svg).toMatch(/\bviewBox="[^"]+"/)
    expect(result.svg).toContain('<path')
    expect(result.svg).toContain('<text')
  }, 30_000)
})
