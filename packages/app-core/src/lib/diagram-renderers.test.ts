// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderDiagrams, sanitizeTikzSvg } from './diagram-renderers'

const SAFE_AND_UNSAFE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" onload="alert(1)" srcdoc="unsafe">',
  '<defs><path id="glyph" d="M0 0h2v2z" /></defs>',
  '<script>alert(1)</script>',
  '<style>@import url(https://tracker.invalid/style.css)</style>',
  '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">unsafe</div></foreignObject>',
  '<a href="javascript:alert(1)"><text font-family="cmr10">Safe text</text></a>',
  '<image href="https://tracker.invalid/pixel.png" width="1" height="1" />',
  '<image src="https://tracker.invalid/second-pixel.png" width="1" height="1" />',
  '<rect id="unsafe-paint" fill="url(https://tracker.invalid/paint.svg)" style="filter:url(https://tracker.invalid/filter.svg)" />',
  '<rect id="safe-paint" fill="url(#glyph)" />',
  '<use href="#glyph" />',
  '</svg>',
  '<svg xmlns="http://www.w3.org/2000/svg" id="second-root"><text>discard me</text></svg>'
].join('')

describe('TikZ diagram rendering', () => {
  beforeEach(() => {
    document.body.replaceChildren()
  })

  it('sanitizes compiled SVG while retaining TikZ text, paths, and local references', () => {
    const svg = sanitizeTikzSvg(SAFE_AND_UNSAFE_SVG)
    const host = document.createElement('div')
    host.innerHTML = svg

    expect(host.children).toHaveLength(1)
    expect(host.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 20 10')
    expect(host.querySelector('#second-root')).toBeNull()
    expect(host.querySelector('text')?.textContent).toBe('Safe text')
    expect(host.querySelector('text')?.getAttribute('font-family')).toBe('cmr10')
    expect(host.querySelector('use')?.getAttribute('href')).toBe('#glyph')
    for (const image of host.querySelectorAll('image')) {
      expect(image.hasAttribute('href')).toBe(false)
      expect(image.hasAttribute('src')).toBe(false)
    }
    expect(host.querySelector('#unsafe-paint')?.hasAttribute('fill')).toBe(false)
    expect(host.querySelector('#unsafe-paint')?.hasAttribute('style')).toBe(false)
    expect(host.querySelector('#safe-paint')?.getAttribute('fill')).toBe('url(#glyph)')
    expect(host.querySelector('script')).toBeNull()
    expect(host.querySelector('style')).toBeNull()
    expect(host.querySelector('foreignObject')).toBeNull()
    expect(host.querySelector('[onload]')).toBeNull()
    expect(host.querySelector('[srcdoc]')).toBeNull()
    expect(svg).not.toContain('javascript:')
    expect(svg).not.toContain('tracker.invalid')
  })

  it('sanitizes bridge output before inserting a rendered TikZ diagram', async () => {
    const renderTikz = vi.fn().mockResolvedValue({ ok: true, svg: SAFE_AND_UNSAFE_SVG })
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { renderTikz }
    })

    const root = document.createElement('div')
    root.innerHTML = '<div class="zen-tikz" data-tikz-source="\\begin{tikzpicture}"></div>'
    document.body.append(root)

    await renderDiagrams(root, { themeKey: 'light' })

    expect(renderTikz).toHaveBeenCalledWith('\\begin{tikzpicture}')
    expect(root.querySelector('.zen-tikz svg')).not.toBeNull()
    expect(root.querySelector('.zen-tikz script')).toBeNull()
    expect(root.querySelector('.zen-tikz foreignObject')).toBeNull()
    expect(root.querySelector('.zen-tikz [onload]')).toBeNull()
    expect(root.innerHTML).not.toContain('javascript:')
  })

  it('does not paint a render result after the element source has changed', async () => {
    let finishRender: ((value: { ok: true; svg: string }) => void) | undefined
    const renderTikz = vi.fn().mockImplementation(
      () =>
        new Promise<{ ok: true; svg: string }>((resolve) => {
          finishRender = resolve
        })
    )
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: { renderTikz }
    })

    const root = document.createElement('div')
    root.innerHTML = '<div class="zen-tikz" data-tikz-source="first"></div>'
    document.body.append(root)
    const placeholder = root.querySelector<HTMLElement>('.zen-tikz')!

    const pending = renderDiagrams(root, { themeKey: 'light' })
    expect(renderTikz).toHaveBeenCalledWith('first')
    placeholder.setAttribute('data-tikz-source', 'second')
    finishRender?.({
      ok: true,
      svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>stale result</text></svg>'
    })
    await pending

    expect(placeholder.querySelector('svg')).toBeNull()
    expect(placeholder.textContent).not.toContain('stale result')
  })
})
