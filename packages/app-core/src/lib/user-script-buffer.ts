import { EditorSelection, Transaction, type ChangeSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { USER_COMMAND_RESULT_LIMITS } from '@bridge-contract/user-config'

/** Vim modes exposed to user commands. Keep these independent of CodeMirror-Vim internals. */
export type UserScriptVimMode =
  | 'normal'
  | 'visual'
  | 'insert'
  | 'replace'
  | 'operatorPending'

export interface UserScriptSelectionSnapshot {
  readonly anchor: number
  readonly head: number
  readonly from: number
  readonly to: number
}

export interface UserScriptCursorSnapshot {
  readonly offset: number
  /** One-based document line, matching CodeMirror's line numbers. */
  readonly line: number
  /** Zero-based UTF-16 column. */
  readonly column: number
}

export interface UserScriptVimSnapshot {
  readonly mode: UserScriptVimMode
  readonly count: number | null
  readonly register: string | null
}

/** Immutable input sent to a user command. */
export interface UserScriptBufferSnapshot {
  readonly path: string
  readonly text: string
  readonly version: number
  readonly selections: readonly UserScriptSelectionSnapshot[]
  readonly cursor: UserScriptCursorSnapshot
  readonly vim: UserScriptVimSnapshot
}

export interface CreateUserScriptBufferSnapshotOptions {
  path: string
  version: number
  vim: UserScriptVimSnapshot
}

export interface UserScriptEdit {
  from: number
  to: number
  insert: string
}

export interface UserScriptResultSelection {
  anchor: number
  head?: number
}

/**
 * Declarative output accepted from a user command. Selection offsets refer to
 * the document after all edits have been applied. Omitting `selection`, or
 * returning `"preserve"`, maps the current editor selection through the edits.
 */
export interface UserScriptResult {
  edits?: readonly UserScriptEdit[]
  selection?: UserScriptResultSelection | 'preserve'
  message?: string
}

export interface ValidatedUserScriptResult {
  readonly edits: readonly UserScriptEdit[]
  readonly selection: Readonly<Required<UserScriptResultSelection>> | 'preserve'
  readonly message?: string
  readonly resultingDocumentLength: number
}

export interface UserScriptResultLimits {
  maxEdits: number
  maxInsertedTextLength: number
  maxMessageLength: number
}

export const DEFAULT_USER_SCRIPT_RESULT_LIMITS: Readonly<UserScriptResultLimits> = Object.freeze({
  ...USER_COMMAND_RESULT_LIMITS
})

export type UserScriptBufferErrorCode =
  | 'stale-buffer'
  | 'invalid-result'
  | 'too-many-edits'
  | 'edit-out-of-bounds'
  | 'overlapping-edits'
  | 'output-too-large'
  | 'invalid-selection'
  | 'message-too-large'

export interface UserScriptBufferError {
  readonly code: UserScriptBufferErrorCode
  readonly message: string
}

export type ValidateUserScriptResultOutcome =
  | { readonly ok: true; readonly value: ValidatedUserScriptResult }
  | { readonly ok: false; readonly error: UserScriptBufferError }

export type ApplyUserScriptResultOutcome =
  | { readonly ok: true; readonly applied: boolean; readonly message?: string }
  | { readonly ok: false; readonly error: UserScriptBufferError }

function failure(
  code: UserScriptBufferErrorCode,
  message: string
): { readonly ok: false; readonly error: UserScriptBufferError } {
  return { ok: false, error: { code, message } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isDocumentOffset(value: unknown, documentLength: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= documentLength
}

/** Capture the active CodeMirror buffer without exposing a live EditorView to user code. */
export function createUserScriptBufferSnapshot(
  view: EditorView,
  options: CreateUserScriptBufferSnapshotOptions
): UserScriptBufferSnapshot {
  if (!Number.isSafeInteger(options.version) || options.version < 0) {
    throw new RangeError('User script buffer version must be a non-negative safe integer')
  }

  const text = view.state.doc.toString()
  const selections = Object.freeze(
    view.state.selection.ranges.map((range) =>
      Object.freeze({
        anchor: range.anchor,
        head: range.head,
        from: range.from,
        to: range.to
      })
    )
  )
  const offset = view.state.selection.main.head
  const line = view.state.doc.lineAt(offset)

  return Object.freeze({
    path: options.path,
    text,
    version: options.version,
    selections,
    cursor: Object.freeze({ offset, line: line.number, column: offset - line.from }),
    vim: Object.freeze({ ...options.vim })
  })
}

/**
 * Validate untrusted command output and normalize edits into document order.
 * `null` and `undefined` are accepted as a command that made no buffer change.
 */
export function validateUserScriptResult(
  snapshot: UserScriptBufferSnapshot,
  currentVersion: number,
  result: unknown,
  limits: Readonly<UserScriptResultLimits> = DEFAULT_USER_SCRIPT_RESULT_LIMITS
): ValidateUserScriptResultOutcome {
  if (currentVersion !== snapshot.version) {
    return failure(
      'stale-buffer',
      `The buffer changed while the user command was running (expected version ${snapshot.version}, got ${currentVersion})`
    )
  }
  if (result == null) {
    return {
      ok: true,
      value: Object.freeze({
        edits: Object.freeze([]),
        selection: 'preserve' as const,
        resultingDocumentLength: snapshot.text.length
      })
    }
  }
  if (!isRecord(result)) {
    return failure('invalid-result', 'A user command must return an object, null, or undefined')
  }

  const rawEdits = result.edits ?? []
  if (!Array.isArray(rawEdits)) {
    return failure('invalid-result', 'User command `edits` must be an array')
  }
  if (rawEdits.length > limits.maxEdits) {
    return failure(
      'too-many-edits',
      `User command returned ${rawEdits.length} edits; the limit is ${limits.maxEdits}`
    )
  }

  const edits: UserScriptEdit[] = []
  let insertedTextLength = 0
  let removedTextLength = 0
  for (let index = 0; index < rawEdits.length; index++) {
    const rawEdit: unknown = rawEdits[index]
    if (!isRecord(rawEdit)) {
      return failure('invalid-result', `User command edit ${index + 1} must be an object`)
    }
    if (
      !isDocumentOffset(rawEdit.from, snapshot.text.length) ||
      !isDocumentOffset(rawEdit.to, snapshot.text.length) ||
      rawEdit.from > rawEdit.to
    ) {
      return failure(
        'edit-out-of-bounds',
        `User command edit ${index + 1} must satisfy 0 <= from <= to <= ${snapshot.text.length}`
      )
    }
    if (typeof rawEdit.insert !== 'string') {
      return failure('invalid-result', `User command edit ${index + 1} must contain string \`insert\``)
    }
    insertedTextLength += rawEdit.insert.length
    removedTextLength += rawEdit.to - rawEdit.from
    if (insertedTextLength > limits.maxInsertedTextLength) {
      return failure(
        'output-too-large',
        `User command inserted text exceeds the ${limits.maxInsertedTextLength} character limit`
      )
    }
    edits.push({ from: rawEdit.from, to: rawEdit.to, insert: rawEdit.insert })
  }

  edits.sort((left, right) => left.from - right.from || left.to - right.to)
  for (let index = 1; index < edits.length; index++) {
    const previous = edits[index - 1]
    const current = edits[index]
    // Same-start edits (including duplicate insertions) are ambiguous. Adjacent
    // ranges and insertions at the end of a replaced range are well-defined.
    if (current.from < previous.to || current.from === previous.from) {
      return failure(
        'overlapping-edits',
        `User command edits overlap or share a start offset at ${current.from}`
      )
    }
  }

  const resultingDocumentLength = snapshot.text.length - removedTextLength + insertedTextLength
  let selection: ValidatedUserScriptResult['selection'] = 'preserve'
  if (result.selection !== undefined && result.selection !== 'preserve') {
    if (!isRecord(result.selection)) {
      return failure('invalid-selection', 'User command `selection` must be "preserve" or an object')
    }
    const anchor = result.selection.anchor
    const head = result.selection.head ?? anchor
    if (
      !isDocumentOffset(anchor, resultingDocumentLength) ||
      !isDocumentOffset(head, resultingDocumentLength)
    ) {
      return failure(
        'invalid-selection',
        `User command selection must be within the resulting document (0..${resultingDocumentLength})`
      )
    }
    selection = Object.freeze({ anchor, head })
  }

  let message: string | undefined
  if (result.message !== undefined) {
    if (typeof result.message !== 'string') {
      return failure('invalid-result', 'User command `message` must be a string')
    }
    if (result.message.length > limits.maxMessageLength) {
      return failure(
        'message-too-large',
        `User command message exceeds the ${limits.maxMessageLength} character limit`
      )
    }
    message = result.message
  }

  return {
    ok: true,
    value: Object.freeze({
      edits: Object.freeze(edits.map((edit) => Object.freeze(edit))),
      selection,
      ...(message === undefined ? {} : { message }),
      resultingDocumentLength
    })
  }
}

/**
 * Validate and apply a command result as one CodeMirror transaction. Normal
 * CodeMirror update listeners, dirty tracking, and history therefore see one
 * ordinary editor operation.
 */
export function applyUserScriptResult(
  view: EditorView,
  snapshot: UserScriptBufferSnapshot,
  currentVersion: number,
  result: unknown,
  limits: Readonly<UserScriptResultLimits> = DEFAULT_USER_SCRIPT_RESULT_LIMITS
): ApplyUserScriptResultOutcome {
  if (view.state.doc.toString() !== snapshot.text) {
    return failure('stale-buffer', 'The buffer text changed while the user command was running')
  }

  const validated = validateUserScriptResult(snapshot, currentVersion, result, limits)
  if (!validated.ok) return validated

  const { edits, selection, message } = validated.value
  const hasExplicitSelection = selection !== 'preserve'
  if (edits.length === 0 && !hasExplicitSelection) {
    return { ok: true, applied: false, ...(message === undefined ? {} : { message }) }
  }

  view.dispatch({
    changes: edits as readonly ChangeSpec[],
    ...(selection === 'preserve'
      ? {}
      : { selection: EditorSelection.single(selection.anchor, selection.head) }),
    annotations: [
      Transaction.userEvent.of('input.user-script'),
      Transaction.addToHistory.of(true)
    ]
  })

  return { ok: true, applied: true, ...(message === undefined ? {} : { message }) }
}
