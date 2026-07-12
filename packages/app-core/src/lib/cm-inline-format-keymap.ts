import { completionStatus } from '@codemirror/autocomplete'
import { Prec, type Extension } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'
import { toggleWrap, wrapLink } from './cm-format'

/**
 * Whether an inline-format shortcut belongs to the editor's text-entry mode.
 *
 * With Vim disabled there is no Vim state, so the shortcuts behave like normal
 * application editing shortcuts. With Vim enabled they must yield in normal
 * and visual mode, where Ctrl-based chords belong to Vim, and run only while
 * the live Vim state is in insert mode.
 */
export function canRunInlineFormatShortcut(view: EditorView): boolean {
  if (completionStatus(view.state) === 'active') return false
  const vimState = getCM(view)?.state?.vim
  return !vimState || vimState.insertMode === true
}

function whileEditing(run: (view: EditorView) => boolean): (view: EditorView) => boolean {
  return (view) => (canRunInlineFormatShortcut(view) ? run(view) : false)
}

/**
 * Shared Markdown inline-format shortcuts.
 *
 * Highest precedence keeps formatting ahead of native editor defaults while
 * typing. Returning false outside text-entry mode lets CodeMirror-Vim receive
 * the same Ctrl chord in normal/visual mode.
 */
export const inlineFormatKeymap: Extension = Prec.highest(
  keymap.of([
    { key: 'Mod-b', run: whileEditing((view) => toggleWrap(view, '**')) },
    { key: 'Mod-i', run: whileEditing((view) => toggleWrap(view, '*')) },
    { key: 'Mod-e', run: whileEditing((view) => toggleWrap(view, '`')) },
    { key: 'Shift-Mod-s', run: whileEditing((view) => toggleWrap(view, '~~')) },
    { key: 'Shift-Mod-h', run: whileEditing((view) => toggleWrap(view, '==')) },
    { key: 'Shift-Mod-m', run: whileEditing((view) => toggleWrap(view, '$')) },
    { key: 'Mod-k', run: whileEditing(wrapLink) }
  ])
)
