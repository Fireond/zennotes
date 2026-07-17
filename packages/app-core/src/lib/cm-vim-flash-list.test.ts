// @vitest-environment jsdom

import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { forceParsing } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { Vim, getCM, vim } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { livePreviewPlugin } from './cm-live-preview'
import { markdownListIndentPlugin } from './cm-markdown-list-indent'
import {
  handleVimFlashKey,
  startVimFlashJump,
  vimFlashExtension
} from './cm-vim-flash'
import { wysiwygBlocksPlugin } from './cm-wysiwyg-blocks'

vi.mock('../store', () => {
  const state = {
    activeNote: null,
    assetFiles: [],
    noteRefs: {},
    pdfEmbedInEditMode: 'compact',
    pinnedRefKind: 'note',
    pinnedRefPath: null,
    vault: null
  }
  const useStore = Object.assign(() => null, {
    getState: () => state,
    subscribe: () => () => {}
  })
  return { useStore }
})

describe('Vim Flash labels in rendered Markdown lists', () => {
  let view: EditorView | null = null

  afterEach(() => {
    view?.destroy()
    view = null
    document.body.replaceChildren()
  })

  function routeKey(key: string): boolean {
    if (!view) throw new Error('missing editor')
    const event = new KeyboardEvent('keydown', {
      key,
      code: `Key${key.toUpperCase()}`,
      bubbles: true,
      cancelable: true
    })
    const consumed = handleVimFlashKey(view, event)
    if (!consumed) {
      const adapter = getCM(view)
      if (!adapter) throw new Error('missing Vim adapter')
      Vim.handleKey(adapter, key, 'user')
    }
    return consumed
  }

  function styleRules(): CSSStyleRule[] {
    return Array.from(document.styleSheets).flatMap((sheet) =>
      Array.from(sheet.cssRules).filter(
        (rule): rule is CSSStyleRule => 'selectorText' in rule && 'style' in rule
      )
    )
  }

  it('places the replacement label over the first matched list-item character', () => {
    const doc = '- abc\n\noutside'
    // jsdom does not evaluate the production rule's custom-property `calc`,
    // so use its resolved browser value to model the inherited hanging indent.
    const listStyles = document.createElement('style')
    listStyles.textContent =
      '.cm-editor .cm-line.cm-markdown-list-line { text-indent: -2ch; }'
    document.body.append(listStyles)
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        // Keep the list line inactive so its marker is rendered as a bullet,
        // matching the normal WYSIWYG appearance during a remote jump.
        selection: { anchor: doc.indexOf('outside') },
        extensions: [
          vim(),
          // Match EditorPane's ordering: Flash is installed before the
          // Markdown and live-preview compartments.
          vimFlashExtension,
          markdown({ base: markdownLanguage }),
          markdownListIndentPlugin,
          livePreviewPlugin,
          wysiwygBlocksPlugin
        ]
      })
    })
    view.focus()
    forceParsing(view, doc.length, 5000)
    view.dispatch({ changes: { from: doc.length, insert: ' ' } })
    view.dispatch({ changes: { from: doc.length, to: doc.length + 1 } })

    expect(view.dom.querySelector('.cm-wq-bullet')?.textContent).toBe('•')
    expect(startVimFlashJump(view)).toBe(true)
    expect(routeKey('a')).toBe(true)
    expect(routeKey('b')).toBe(true)

    const line = view.dom.querySelectorAll<HTMLElement>('.cm-line')[0]
    const label = line.querySelector<HTMLElement>('.cm-flash-label')
    const flashLabelRule = styleRules().find(
      (rule) =>
        rule.selectorText.includes('.cm-flash-label') &&
        !rule.selectorText.includes('.cm-flash-label-source') &&
        !rule.selectorText.includes('.cm-flash-label-hint')
    )

    expect(getComputedStyle(line).textIndent).toBe('-2ch')
    expect(label?.querySelector('.cm-flash-label-source')?.textContent).toBe('a')
    expect(label?.querySelector('.cm-flash-label-hint')?.textContent).toBe(
      label?.dataset.flashLabel
    )
    expect(line.querySelector('.cm-flash-match')?.textContent).toBe('b')
    expect(line.querySelectorAll('.cm-flash-label')).toHaveLength(1)
    expect(view.posAtDOM(label!, 0)).toBe(doc.indexOf('abc'))
    // A list line's negative hanging indent is inherited in browsers. The
    // replacement widget must explicitly reset it so its own first inline
    // line (the hidden source plus overlaid hint) remains on the source glyph.
    expect(['0', '0px']).toContain(flashLabelRule?.style.textIndent)
  })
})
