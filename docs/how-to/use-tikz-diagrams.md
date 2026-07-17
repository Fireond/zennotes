# Render TikZ Diagrams

The ZenNotes desktop app renders TikZ diagrams from fenced Markdown blocks. Compilation happens locally through a WebAssembly TeX engine, so it does not require a LaTeX installation or a network connection.

With live preview enabled, Edit mode renders a completed TikZ fence whenever
the cursor is outside it. Click the diagram—or move into it with Arrow keys or
Vim `j`/`k`—to reveal and edit the exact source. Split and Preview mode also
render the SVG.

## Use a complete LaTeX document

Put the preamble and document body inside a `tikz` fence. ZenNotes supplies the document class, so `\documentclass` is optional and is removed when present.

````markdown
```tikz
\usepackage{tikz-cd,amssymb}
\begin{document}
  \begin{tikzcd}
    A \arrow[r, "f"] \arrow[d, "g"] & B \arrow[d, "h"] \\
    C \arrow[r, "k"]                  & D
  \end{tikzcd}
\end{document}
```
````

This form is useful when pasting an existing TikZ example that declares packages or libraries in its preamble.

## Use a bare TikZ fragment

For smaller figures, the document wrapper can be omitted:

````markdown
```tikz
\begin{tikzpicture}
  \draw[->] (0,0) -- (3,0) node[right] {$x$};
  \draw[->] (0,0) -- (0,2) node[above] {$y$};
  \draw[blue, thick] (0,0) parabola (2,2);
\end{tikzpicture}
```
````

ZenNotes wraps bare fragments in `\begin{document}` and `\end{document}` automatically. Preamble commands such as `\usepackage{...}` and `\usetikzlibrary{...}` can appear above the fragment.

## Supported packages and libraries

The bundled engine supports commonly used TikZ packages and libraries, including `tikz-cd`, `amssymb`, `amsmath`, `circuitikz`, and `pgfplots`. Frequently used TikZ libraries such as `arrows.meta`, `calc`, `positioning`, `shapes`, `intersections`, and `patterns` are enabled by default; additional libraries can be requested with `\usetikzlibrary{...}`.

Compilation errors appear in the diagram surface with the relevant TeX diagnostic. Complex diagrams may take a moment on their first render; repeated renders of unchanged source are cached.

ZenNotes does not recompile a fence while the cursor is inside it. The source
is rendered after the cursor leaves the block, keeping normal typing and Vim
editing responsive.

TikZ compilation is currently available in the desktop app, not the web build.
