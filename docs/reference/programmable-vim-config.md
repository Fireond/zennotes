# Programmable Vim Configuration

The desktop app loads trusted local JavaScript from:

```text
~/.config/zennotes/init.mjs
```

`$ZENNOTES_CONFIG_DIR` or `$XDG_CONFIG_HOME` changes the parent directory in the same way as `config.toml`. ZenNotes creates a commented starter file on first launch and reloads it when it changes. A failed reload reports an error and keeps the last working mappings and command handlers active.

This feature is desktop-only and applies to the main note editor. Secondary CodeMirror surfaces, such as the template editor and pinned reference editor, keep their normal Vim mappings. `init.mjs` runs as ordinary local Node.js code in a separate utility process, so it may import modules, read files, start processes, or perform any other action your account can perform. Only run configuration you trust.

## Map Vim keys

The default export receives the `zen` configuration API:

```js
export default function setup(zen) {
  zen.keymap.set('n', 'H', '^')
  zen.keymap.set('n', 'L', '$')
  zen.keymap.set('i', 'jk', '<Esc>')
}
```

Modes may use compact or long names:

| Mode | Long name | Meaning |
| --- | --- | --- |
| `n` | `normal` | Normal mode |
| `v` | `visual` | Visual and visual-line mode |
| `i` | `insert` | Insert mode |
| `o` | `operatorPending` | Waiting for an operator motion |

Mappings are non-recursive by default, like Neovim's `noremap`. Set `{ recursive: true }` when the right-hand side should expand through other mappings:

```js
zen.keymap.set('n', 'J', '5j', { recursive: true })
```

Vim key notation such as `<C-w>`, `<Esc>`, and `<leader>` is supported. `<leader>` follows the leader configured in Settings. Neovim's `<D-x>` notation for Command/Meta keys is accepted and translated to codemirror-vim's equivalent `<M-x>` form.

Later declarations of the same mode and left-hand side replace earlier declarations. To disable a Vim binding, map it to a no-op with either form:

```js
zen.keymap.disable('n', 'Q')
zen.keymap.set('n', 'Q', null)
```

`keymap.del(mode, lhs)` only deletes a declaration made earlier in the same `setup` call, so any underlying built-in behavior remains. Use `disable` when that underlying behavior should be replaced by a no-op.

## Import LuaSnip snippets

The desktop editor can statically import a trusted LuaSnip directory without
starting Neovim or executing Lua. Make the setup function asynchronous and
name the Markdown filetype plus any groups that your Neovim configuration adds
with `luasnip.filetype_extend()`:

```js
export default async function setup(zen) {
  await zen.snippets.importLuaSnip({
    root: '~/.config/nvim/LuaSnip',
    filetype: 'markdown',
    extend: ['tex_shared'],
    keys: {
      expandOrJump: 'fj',
      jumpBackward: 'fk',
      nextChoice: '<C-h>',
      previousChoice: '<C-p>',
      storeSelection: '`'
    }
  })
}
```

The importer reads the requested filetype, each `extend` group, and `all.lua`.
It watches the imported Lua files and reloads them together with `init.mjs`.
Automatic snippets expand as their trigger is typed; manual snippets expand
with `expandOrJump`. While a snippet is active, Tab and Shift+Tab also move
forward and backward through fields. Choice keys cycle alternatives, and the
same choice keys select among manual definitions that share one trigger (such
as `iso`, `homeo`, and `homo` in this configuration). The
visual-mode selection key cuts and stores text for LuaSnip's
`TM_SELECTED_TEXT`-style dynamic wrappers, leaving the cursor in Insert mode at
the cut position just as LuaSnip's `store_selection_keys` does.

As in LuaSnip, a definition that omits `i(0)` receives an implicit final exit
position after all rendered text. Automatic expansion also has its own undo
boundary: undoing `alp` → `\alpha` restores the literal `alp` trigger first.

This is a compatibility importer, not an embedded Lua runtime. It supports the
LuaSnip forms used by the bundled-style Markdown/TeX configs: `s`, `autosnippet`,
`t`, `i`, `c`, `f`, `d`, `fmt`/`fmta`, literal and Lua-pattern triggers,
captures and mirrors, `os.date`, and the common math/text, line-begin, and
`tikzcd` conditions. Unsupported executable Lua is skipped with a diagnostic;
the previous working snippet set remains active if a reload fails. Explicit
`zen.keymap` declarations made after the import take precedence over imported
snippet keys.

Imported snippets currently apply to the main note editor only, like the rest
of `init.mjs`. Template, Quick Capture, external-file, floating-note, and pinned
reference editors do not load them.

## Use Flash-style motions

With Vim enabled in the main note editor, the `vim.flashJump` Settings action defaults to `s`. It is available in normal, visual, and operator-pending modes:

1. Press `s` to open the jump prompt.
2. Type one or more literal query characters. Matching is Unicode-aware and case-insensitive, so `abc` also finds `ABC`.
3. When the intended match displays a label, type that label to jump to it.

Matches closest to the cursor receive home-row labels first. A character that could still extend the current query is not assigned as a label, so you can type any number of query characters before choosing a target. `Backspace` removes the last query character, `Enter` selects the closest labeled match, and `Esc` or `Ctrl+[` cancels the prompt.

The jump searches CodeMirror's current visible viewport ranges, not the entire note. Mounted inline and block math formulas are searchable by either their visible rendered text or their raw inner LaTeX. Every matching occurrence inside a formula receives its own label. ZenNotes places those labels approximately over nearby rendered glyphs without changing KaTeX's layout; resolving a raw-LaTeX match lands on that exact source occurrence and reveals the formula for editing. Rendered-only matches use the nearest approximate source token. If the viewport changes while the prompt is open, ZenNotes recomputes matches and labels for the newly visible ranges.

You can change the default from `Settings -> Keymap` by searching for `Flash jump`. The equivalent portable `config.toml` override is:

```toml
[keymaps]
"vim.flashJump" = "S"
```

Set the value to an empty string to unbind it:

```toml
[keymaps]
"vim.flashJump" = ""
```

Unbinding this Settings action restores CodeMirror-Vim's original `s` substitute command. An explicit `init.mjs` mapping on the same key takes precedence over the Settings binding.

The stable command ID is `editor.flash.jump`, so `init.mjs` can add the jump to a normal- or visual-mode Vim sequence:

```js
export default function setup(zen) {
  zen.keymap.set('n', '<leader>j', zen.command('editor.flash.jump'))
}
```

This adds another way to start Flash. Unbind `vim.flashJump` in Settings or `config.toml` as shown above if you want to move the command instead of keeping the default `s` binding.

The Settings binding also works after an operator (`ds`, for example). Command-style `init.mjs` mappings are not dispatched by CodeMirror-Vim while an operator is pending, so map `editor.flash.jump` in normal or visual mode rather than `o` mode. Query and label keystrokes are handled by the Flash UI and are not currently replayable with Vim macros or dot-repeat.

The ordinary same-line `f{character}` and `F{character}` motions are enhanced separately. After a successful motion, ZenNotes highlights every occurrence of that character on the current line. Press lowercase `f` to continue in the original search direction, or uppercase `F` to move to the preceding match and undo a jump. For example, after an initial backward `F{x}`, `f` continues backward and `F` reverses forward.

Character-motion highlights clear after another cursor or selection movement, a document edit, a note or buffer switch, focus leaving the editor, or `Esc`/`Ctrl+[`. Unlike the labeled `s` jump, enhanced `f/F` remains scoped to the current line.

## Run ZenNotes commands from Vim

A mapping can invoke an existing ZenNotes action by its Settings keymap ID or stable command-palette ID:

```js
export default function setup(zen) {
  // Make Ctrl+W close the active ZenNotes tab instead of starting Vim's
  // window-command prefix. This is the same action ID used by Settings.
  zen.keymap.set('n', '<C-w>', zen.command('global.closeActiveTab'))
}
```

Settings keymap IDs with direct command equivalents are accepted, including `global.commandPalette`, `global.openSettings`, `global.newQuickNote`, `global.modeEdit`, `global.modeSplit`, `global.modePreview`, `global.historyBack`, `global.historyForward`, `vim.flashJump`, the `global.focusPane*` actions, the `vim.pane*` actions, and the `vim.fold*` actions. Stable command-palette IDs such as `app.settings`, `editor.flash.jump`, `note.new.quick`, `tab.close`, and `view.mode.edit` also work. Command execution uses the editor and pane that received the Vim mapping.

The generated `config.toml` lists every Settings action ID in its `[keymaps]` section. Some entries are prefixes or context-only navigation keys rather than invokable actions; using one of those as a command target produces an `Unknown command` error.

## Register buffer commands

The convenience API below runs once for every non-empty selection and returns its replacement text:

```js
export default function setup(zen) {
  zen.commands.registerTransform({
    id: 'user.uppercase-selection',
    title: 'Uppercase selection',
    run(text) {
      return text.toUpperCase()
    }
  })

  zen.keymap.set('v', '<leader>u', zen.command('user.uppercase-selection'))
}
```

For full control, register a command that receives an immutable snapshot of the current buffer:

```js
export default function setup(zen) {
  zen.commands.register({
    id: 'user.wrap-selection',
    title: 'Wrap selection in brackets',
    run(context) {
      const selection = context.selections[0]
      if (!selection || selection.from === selection.to) return

      const selected = context.text.slice(selection.from, selection.to)
      return {
        edits: [{
          from: selection.from,
          to: selection.to,
          insert: `[${selected}]`
        }],
        selection: 'preserve',
        message: 'Wrapped selection'
      }
    }
  })
}
```

The context contains:

- `path` and the full buffer `text`
- a monotonically increasing buffer `version`
- every selection as half-open UTF-16 offsets `{ from, to }`
- `cursor` as `{ offset, line, column }`, where lines are one-based and columns are zero-based
- `vim` as `{ mode, count, register }`

Command results are declarative. `edits` must be in the original snapshot's coordinate space and may not overlap. An explicit `{ anchor, head }` selection refers to the post-edit document; `"preserve"` maps the existing selection through the edits. All edits are applied in one undoable CodeMirror transaction.

If the note changes while an asynchronous command is running, ZenNotes rejects the stale result instead of overwriting newer text. Command execution is limited to ten seconds, 1,000 edits, and 8,388,608 UTF-16 code units of inserted text per invocation.

Imported helper modules are evaluated in the fresh process on reload. Lua files
registered through `zen.snippets.importLuaSnip()` are watched directly; for
other helper modules, touch or save `init.mjs` after editing them.
