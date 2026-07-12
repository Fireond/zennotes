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

## Run ZenNotes commands from Vim

A mapping can invoke an existing ZenNotes action by its Settings keymap ID or stable command-palette ID:

```js
export default function setup(zen) {
  // Make Ctrl+W close the active ZenNotes tab instead of starting Vim's
  // window-command prefix. This is the same action ID used by Settings.
  zen.keymap.set('n', '<C-w>', zen.command('global.closeActiveTab'))
}
```

Settings keymap IDs with direct command equivalents are accepted, including `global.commandPalette`, `global.openSettings`, `global.newQuickNote`, `global.modeEdit`, `global.modeSplit`, `global.modePreview`, `global.historyBack`, `global.historyForward`, the `global.focusPane*` actions, the `vim.pane*` actions, and the `vim.fold*` actions. Stable command-palette IDs such as `app.settings`, `note.new.quick`, `tab.close`, and `view.mode.edit` also work. Command execution uses the editor and pane that received the Vim mapping.

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

Imported helper modules are evaluated in the fresh process on reload, but only changes to `init.mjs` itself are watched in this first version. Touch or save `init.mjs` after editing a helper module.
