import type { EditorView } from '@codemirror/view'
import { CodeMirror, Vim, getCM } from '@replit/codemirror-vim'
import type { CodeMirrorV, MotionArgs, Pos } from '@replit/codemirror-vim'

/**
 * A key that is never emitted by a browser keyboard event. Flash resolves its
 * target outside codemirror-vim, then feeds this key back through Vim so the
 * pending mode/operator/count state is applied by Vim's normal dispatcher.
 */
const RESOLVED_TARGET_KEY = '<C-A-F12>'
const RESOLVED_TARGET_MOTION = 'zenFlashResolvedTarget'
const RESOLVED_TARGET_MAPPING_MARK = Symbol.for(
  'zennotes.cm-vim-flash.resolved-target-mapping'
)

export type VimFlashTargetOptions = {
  /** Include the target character when this motion completes an operator. */
  inclusive?: boolean
  /** Explicit direction, normally inferred from the cursor and target. */
  forward?: boolean
  /** Record the move in codemirror-vim's jump list. */
  toJumplist?: boolean
}

type PendingTarget = VimFlashTargetOptions & { pos: Pos }

// CodeMirror-Vim adapters are stable for the lifetime of an EditorView. Keeping
// this per adapter also makes resolving targets in two panes independently safe.
const pendingTargets = new WeakMap<object, PendingTarget>()

let registered = false

function positionIsAfter(left: Pos, right: Pos): boolean {
  return (
    left.line > right.line || (left.line === right.line && left.ch > right.ch)
  )
}

function resolvedTargetMotion(
  cm: CodeMirrorV,
  head: Pos,
  motionArgs: MotionArgs
): Pos {
  const pending = pendingTargets.get(cm)
  pendingTargets.delete(cm)
  if (!pending) return head

  // These flags are interpreted by codemirror-vim after the motion returns,
  // notably when an operator such as d/c/y is waiting for its motion.
  motionArgs.forward = pending.forward ?? positionIsAfter(pending.pos, head)
  motionArgs.inclusive = pending.inclusive ?? false
  motionArgs.toJumplist = pending.toJumplist ?? false

  return new CodeMirror.Pos(pending.pos.line, pending.pos.ch)
}

/**
 * Register the private motion used by {@link invokeVimFlashTarget}. This is
 * idempotent within a renderer and safe to call during editor setup or lazily.
 *
 * The mapping intentionally has no context. codemirror-vim changes command
 * matching to `operatorPending` while d/c/y/etc. waits for a motion, so one
 * context-free mapping preserves normal, visual, and operator-pending behavior.
 */
export function registerVimFlashTargetMotion(): void {
  if (registered) return
  registered = true

  Vim.defineMotion(
    RESOLVED_TARGET_MOTION,
    resolvedTargetMotion as unknown as Parameters<typeof Vim.defineMotion>[1]
  )
  const vimRegistry = Vim as unknown as Record<symbol, boolean | undefined>
  if (vimRegistry[RESOLVED_TARGET_MAPPING_MARK]) return
  Vim.mapCommand(RESOLVED_TARGET_KEY, 'motion', RESOLVED_TARGET_MOTION, {}, {})
  vimRegistry[RESOLVED_TARGET_MAPPING_MARK] = true
}

function offsetToPos(view: EditorView, offset: number): Pos {
  const clipped = Math.max(0, Math.min(offset, view.state.doc.length))
  const line = view.state.doc.lineAt(clipped)
  return { line: line.number - 1, ch: clipped - line.from }
}

/**
 * Complete an interactive Flash session at an already-resolved document
 * offset. Returns false when the view has no Vim adapter or is in insert mode.
 *
 * Do not dispatch the selection directly: routing this private motion through
 * `Vim.handleKey` is what makes visual selection extension and pending Vim
 * operators work. A typed count also stays in Vim's input state until this
 * call, then is consumed normally with the motion.
 */
export function invokeVimFlashTarget(
  view: EditorView,
  offset: number,
  options: VimFlashTargetOptions = {}
): boolean {
  registerVimFlashTargetMotion()

  const adapter = getCM(view) as CodeMirrorV | null
  if (!adapter?.state?.vim || adapter.state.vim.insertMode) return false

  pendingTargets.set(adapter, { pos: offsetToPos(view, offset), ...options })
  try {
    return Vim.handleKey(adapter, RESOLVED_TARGET_KEY, 'user') === true
  } finally {
    // The motion normally consumes this entry. Also clear it if a user mapping
    // unexpectedly shadows the synthetic key or Vim rejects the command.
    pendingTargets.delete(adapter)
  }
}
