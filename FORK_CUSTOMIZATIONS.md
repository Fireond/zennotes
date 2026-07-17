# ZenNotes Fork Customizations

This file is the durable handoff for changes maintained by this fork. Git
history and regression tests remain the source of truth; update this summary
after adding a fork-only feature or merging a new upstream release.

Last reviewed: 2026-07-17

Upstream baseline: ZenNotes v2.13.5, merged by `96e8ed5`

## Maintained fork features

| Area | Commit | Fork behavior |
| --- | --- | --- |
| Vim normal-mode shortcuts | `a4a7af3` | Restores app shortcuts such as note-history navigation and Vim half-page scrolling without leaking insert-mode formatting bindings into Normal mode. |
| Settings responsiveness | `6661541` | Removes the interaction delay that affected clicks and hover states in Settings. |
| Unbound configurable actions | `56dc71d` | Allows a Settings keymap to be explicitly unbound instead of always requiring a replacement key. |
| Global editor view mode | `b0db7b2` | Makes Edit/Split/Preview a global preference instead of a per-file setting. |
| Programmable Vim configuration | `5ad424c` | Loads desktop `init.mjs` mappings and user commands, including buffer selection/read/write APIs for scripts. See `docs/reference/programmable-vim-config.md`. |
| LuaSnip Markdown migration | `feat(editor): import LuaSnip Markdown snippets` (this document's commit) | Statically imports LuaSnip `markdown`, inherited groups such as `tex_shared`, and `all` into the main editor, with autosnippets, fields, choices, mirrors, captures, selected text, contexts, and Vim-style control keys. |
| Live math edit preview | `feat(editor): preview active math while editing` (this document's commit) | Keeps the active `$…$` or `$$…$$` source editable while rendering a real-time KaTeX copy directly below it. |
| Flash-style Vim motions | `aab45c7` | Adds case-insensitive incremental `s` jumps, labels, enhanced repeatable `f`/`F`, and matching/jumping within rendered math. |
| TikZ diagrams | `feat(desktop): render TikZ diagrams` (this document's commit) | Renders fenced `tikz` blocks in Preview, Split, export, and Edit live preview. |

## LuaSnip compatibility import

The desktop `init.mjs` API exposes a safe static importer:

```js
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
```

`apps/desktop/src/main/user-luasnip-importer.ts` parses the supported LuaSnip
AST subset without executing Lua. The user-config worker returns declarative
snippet data and watched dependencies; the host preserves the previous working
generation on a failed reload. `snippetRevision` changes only after successful
loads, so a parse failure cannot tear down live editor sessions.

`packages/app-core/src/lib/cm-user-snippets.ts` owns native CodeMirror
expansion and sessions. `packages/app-core/src/lib/user-snippet-integration.ts`
wires the engine to Vim mappings and local commands. Each main `EditorPane`
subscribes separately, so split panes receive live updates. Explicit
`zen.keymap` declarations take precedence over importer-provided keys.
Omitted `i(0)` nodes are synthesized at the rendered snippet end, and
autosnippet expansion is isolated from trigger typing in undo history.

The effective local Markdown corpus has been validated as 415 definitions: 407
automatic and 8 manual snippets, loaded from `markdown`, `tex_shared`, and
`all`. Duplicate manual triggers remain reachable as choice alternatives.
Keep the real snippet files outside this repository; the tracked code
contains the compatibility layer and tests, not a copied snapshot of a user's
dotfiles.

## TikZ implementation

TikZ compilation is desktop-only and runs locally through `node-tikzjax`; it
does not require a system LaTeX installation or a network request.

The Electron main process owns a dedicated utility worker so a slow or broken
diagram cannot block the main process. The host enforces source/output/cache
limits, a compilation timeout, and worker crash recovery. The renderer accepts
only sanitized SVG and bundles the Computer Modern fonts used by generated
figures.

Important desktop files:

- `apps/desktop/src/main/tikz.ts` — worker lifecycle, queueing, limits, and cache
- `apps/desktop/src/main/tikz-compiler.ts` — source normalization and compilation
- `apps/desktop/src/main/tikz-worker.ts` — isolated compiler process entry point
- `apps/desktop/src/main/tikz-protocol.ts` — worker message contract
- `apps/desktop/src/main/index.ts` and `apps/desktop/src/preload/index.ts` — IPC bridge
- `apps/desktop/electron.vite.config.ts` — worker build entry

Important shared UI files:

- `packages/app-core/src/lib/diagram-renderers.ts` — Preview/Split rendering, SVG sanitization, and theme tinting
- `packages/app-core/src/lib/cm-tikz-render.ts` — Edit-mode CodeMirror block widget
- `packages/app-core/src/lib/cm-rendered-block-ranges.ts` — shared math/TikZ navigation ranges
- `packages/app-core/src/lib/cm-math-nav.ts` — Arrow-key entry into rendered blocks
- `packages/app-core/src/lib/cm-vim-display-line.ts` — Vim `j`/`k` entry into rendered blocks
- `packages/app-core/src/components/EditorPane.tsx` — live-preview integration
- `docs/how-to/use-tikz-diagrams.md` — user-facing syntax and supported packages

Edit-mode behavior:

- A complete non-empty `tikz` fence renders while the cursor is outside it.
- Clicking the SVG, moving into it with Arrow keys, or using Vim `j`/`k`
  reveals the exact Markdown source.
- Moving away renders it again. Unchanged diagrams use the host cache and do
  not remount when an edit merely shifts their document position.
- Backtick and tilde fences are supported case-insensitively, including fences
  nested in blockquotes or list items.
- Theme changes retint an already-rendered SVG without recompiling it.
- Bridge, compiler, sanitizer, timeout, and stale-result failures stay
  contained in the diagram surface.

## Validation commands

Run the programmable-snippet checks with:

```sh
ZENNOTES_LUASNIP_TEST_ROOT="$HOME/.config/nvim/LuaSnip" \
  env NODE_ENV=test npm run test:run --workspace @zennotes/desktop -- \
  src/main/user-luasnip-importer.test.ts \
  src/main/user-config-runtime.test.ts \
  src/main/user-config-host.test.ts

env NODE_ENV=test npm run test:run --workspace @zennotes/app-core -- \
  src/lib/cm-user-snippets.test.ts \
  src/lib/user-snippet-integration.test.ts \
  src/lib/user-command-execution.test.ts \
  src/lib/user-vim-keymaps.test.ts \
  src/lib/user-vim-keymaps.integration.test.ts \
  src/lib/cm-markdown-snippets.test.ts
```

Run focused TikZ and editor integration checks with:

```sh
env NODE_ENV=test npm run test:run --workspace @zennotes/app-core -- \
  src/lib/cm-tikz-render.test.ts \
  src/lib/cm-rendered-block-ranges.test.ts \
  src/lib/cm-math-nav.test.ts \
  src/lib/cm-vim-display-line.test.ts \
  src/lib/cm-wysiwyg-blocks.test.ts \
  src/lib/cm-wysiwyg-compose.test.ts

env NODE_ENV=test npm run test:run --workspace @zennotes/desktop -- \
  src/main/tikz.test.ts \
  src/main/tikz-compiler.test.ts \
  src/main/packaging.test.ts

npm run typecheck --workspace @zennotes/app-core
npm run typecheck --workspace @zennotes/desktop
npm run build --workspace @zennotes/desktop
```

The full app-core suite is:

```sh
env NODE_ENV=test npm run test:run --workspace @zennotes/app-core
```

`search-codeblock.test.ts` has occasionally missed its asynchronous highlight
when the full suite runs under heavy parallel load; it passes when rerun alone.
Do not attribute that timing-only failure to TikZ without reproducing it in
isolation.

## Upstream synchronization

The remotes are expected to remain:

- `origin` — `Fireond/zennotes`
- `upstream` — `ZenNotes/zennotes`

Before merging upstream, compare both history and final tree state:

```sh
git fetch upstream
git log --oneline upstream/main..main
git diff --stat upstream/main...main
```

Prefer an upstream implementation when it fully replaces a fork feature.
Remove the duplicated fork code and its entry above, retain tests that still
protect desired behavior, and update the upstream baseline in this file.

## Starting a new coding session

Give the new agent a concrete task and this startup instruction:

```text
This is my ZenNotes fork. Before modifying anything, read
FORK_CUSTOMIZATIONS.md, inspect git status and the latest 15 commits, then
inspect the implementation and tests related to my request. Preserve existing
fork customizations and unrelated changes. Implement the requested behavior,
add regression tests, and run focused tests plus relevant type checks/builds.
Do not commit until I explicitly ask.

New task: <describe current behavior, desired behavior, and reproduction>
```

For parallel sessions, use separate branches/worktrees. Sequential sessions
may reuse this worktree after the previous feature has been committed.
