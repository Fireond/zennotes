import { syntaxTree } from '@codemirror/language'
import { isolateHistory } from '@codemirror/commands'
import {
  EditorSelection,
  EditorState,
  Facet,
  MapMode,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSet,
  type Extension,
  type SelectionRange
} from '@codemirror/state'
import { EditorView, keymap, type Command, type KeyBinding } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'
import type { UserSnippet, UserSnippetContext, UserSnippetNode } from '@bridge-contract/user-config'

interface UserSnippetRuntimeConfig {
  snippets: readonly UserSnippet[]
  now: () => Date
  shouldHandle: (view: EditorView) => boolean
}

export interface UserSnippetExtensionOptions {
  now?: () => Date
  /** Live mode gate, used when Vim can be toggled without recreating the view. */
  shouldHandle?: (view: EditorView) => boolean
}

interface SnippetMatch {
  snippet: UserSnippet
  from: number
  to: number
  captures: readonly string[]
}

interface SnippetFieldRange {
  index: number
  from: number
  to: number
}

interface SnippetChoiceRange {
  index: number
  from: number
  to: number
  choices: readonly (readonly UserSnippetNode[])[]
  current: number
  editable: boolean
}

interface SnippetSession {
  fields: SnippetFieldRange[]
  choices: SnippetChoiceRange[]
  activeField: number
  captures: readonly string[]
  selectedText: string | null
}

interface SnippetRuntimeState {
  sessions: SnippetSession[]
  storedSelection: string | null
}

type SnippetRuntimeAction =
  | {
      type: 'push'
      session: SnippetSession
      nested: boolean
      clearStored: boolean
    }
  | { type: 'replace-top'; session: SnippetSession }
  | { type: 'set-sessions'; sessions: SnippetSession[] }
  | { type: 'store-selection'; text: string | null }
  | { type: 'expanded-without-fields'; clearStored: boolean }

interface RelativeRenderResult {
  text: string
  fields: SnippetFieldRange[]
  choices: SnippetChoiceRange[]
}

interface RenderContext {
  captures: readonly string[]
  selectedText: string | null
  now: Date
  values: Map<number, string>
  suppressField: number | null
}

const DEFAULT_CONFIG: UserSnippetRuntimeConfig = Object.freeze({
  snippets: [],
  now: () => new Date(),
  shouldHandle: vimAllowsAutomaticExpansion
})

const userSnippetConfig = Facet.define<UserSnippetRuntimeConfig, UserSnippetRuntimeConfig>({
  combine(values) {
    return values.length ? values[values.length - 1] : DEFAULT_CONFIG
  }
})

const snippetRuntimeEffect = StateEffect.define<SnippetRuntimeAction>()

function mapField(range: SnippetFieldRange, changes: ChangeSet): SnippetFieldRange | null {
  const from = changes.mapPos(range.from, -1, MapMode.TrackDel)
  const to = changes.mapPos(range.to, 1, MapMode.TrackDel)
  return from == null || to == null ? null : { ...range, from, to }
}

function mapChoice(range: SnippetChoiceRange, changes: ChangeSet): SnippetChoiceRange | null {
  const from = changes.mapPos(range.from, -1, MapMode.TrackDel)
  const to = changes.mapPos(range.to, 1, MapMode.TrackDel)
  return from == null || to == null ? null : { ...range, from, to }
}

function mapSession(session: SnippetSession, changes: ChangeSet): SnippetSession | null {
  const fields = session.fields
    .map((range) => mapField(range, changes))
    .filter((range): range is SnippetFieldRange => range !== null)
  if (!fields.some((field) => field.index === session.activeField)) return null
  return {
    ...session,
    fields,
    choices: session.choices
      .map((choice) => mapChoice(choice, changes))
      .filter((choice): choice is SnippetChoiceRange => choice !== null)
  }
}

function selectionInsideActiveField(
  session: SnippetSession,
  ranges: readonly SelectionRange[]
): boolean {
  const active = session.fields.filter((field) => field.index === session.activeField)
  return (
    active.length > 0 &&
    ranges.every((range) =>
      active.some((field) => field.from <= range.from && field.to >= range.to)
    )
  )
}

function activeChoiceEndsOnTyping(session: SnippetSession): boolean {
  return session.choices.some(
    (choice) => !choice.editable && choice.index === session.activeField
  )
}

const snippetRuntimeField = StateField.define<SnippetRuntimeState>({
  create: () => ({ sessions: [], storedSelection: null }),
  update(previous, transaction) {
    let sessions = previous.sessions
    let storedSelection = previous.storedSelection

    if (transaction.docChanged && sessions.length > 0) {
      const top = sessions[sessions.length - 1]
      const acceptedCompletionChoice =
        !transaction.isUserEvent('input.user-snippet.choice') &&
        activeChoiceEndsOnTyping(top)
      if (top.activeField === 0 || acceptedCompletionChoice) {
        // Position zero is a true exit: the first edit made there continues
        // after the snippet and unlinks it. Synthesized duplicate-trigger
        // choices similarly remain cyclable only until ordinary typing accepts
        // one. Preserve an enclosing parent session when this snippet is nested.
        sessions = sessions.slice(0, -1)
      }
    }

    if (transaction.docChanged) {
      const mapped: SnippetSession[] = []
      for (const session of sessions) {
        const next = mapSession(session, transaction.changes)
        if (next) mapped.push(next)
      }
      sessions = mapped
    }

    for (const effect of transaction.effects) {
      if (!effect.is(snippetRuntimeEffect)) continue
      const action = effect.value
      switch (action.type) {
        case 'push':
          sessions = action.nested ? [...sessions, action.session] : [action.session]
          if (action.clearStored) storedSelection = null
          break
        case 'replace-top':
          sessions = sessions.length ? [...sessions.slice(0, -1), action.session] : [action.session]
          break
        case 'set-sessions':
          sessions = action.sessions
          break
        case 'store-selection':
          storedSelection = action.text
          break
        case 'expanded-without-fields':
          if (action.clearStored) storedSelection = null
          break
      }
    }

    if (transaction.selection && sessions.length) {
      let containing = -1
      for (let index = sessions.length - 1; index >= 0; index--) {
        if (selectionInsideActiveField(sessions[index], transaction.state.selection.ranges)) {
          containing = index
          break
        }
      }
      sessions = containing < 0 ? [] : sessions.slice(0, containing + 1)
    }

    return { sessions, storedSelection }
  }
})

function runtimeState(state: EditorState): SnippetRuntimeState {
  return state.field(snippetRuntimeField)
}

function escapeRegExpChar(char: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(char) ? `\\${char}` : char
}

const LUA_CLASS_OUTSIDE: Readonly<Record<string, string>> = Object.freeze({
  a: '[A-Za-z]',
  A: '[^A-Za-z]',
  c: '[\\x00-\\x1f\\x7f]',
  C: '[^\\x00-\\x1f\\x7f]',
  d: '[0-9]',
  D: '[^0-9]',
  l: '[a-z]',
  L: '[^a-z]',
  p: '[!-/:-@\\[-`{-~]',
  P: '[^!-/:-@\\[-`{-~]',
  s: '[\\t-\\r ]',
  S: '[^\\t-\\r ]',
  u: '[A-Z]',
  U: '[^A-Z]',
  w: '[A-Za-z0-9]',
  W: '[^A-Za-z0-9]',
  x: '[A-Fa-f0-9]',
  X: '[^A-Fa-f0-9]',
  z: '\\x00'
})

const LUA_CLASS_INSIDE: Readonly<Record<string, string>> = Object.freeze({
  a: 'A-Za-z',
  c: '\\x00-\\x1f\\x7f',
  d: '0-9',
  l: 'a-z',
  p: '!-/:-@\\[-`{-~',
  s: '\\t-\\r ',
  u: 'A-Z',
  w: 'A-Za-z0-9',
  x: 'A-Fa-f0-9',
  z: '\\x00'
})

function translateLuaClass(pattern: string, start: number): { source: string; next: number } {
  let index = start + 1
  let source = '['
  if (pattern[index] === '^') {
    source += '^'
    index++
  }
  if (pattern[index] === ']') {
    source += '\\]'
    index++
  }
  for (; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === ']') return { source: `${source}]`, next: index + 1 }
    if (char === '%') {
      const escaped = pattern[++index]
      if (escaped == null) throw new Error('unfinished % escape in Lua pattern')
      const klass = LUA_CLASS_INSIDE[escaped]
      if (klass) {
        source += klass
      } else if (/[A-Z]/.test(escaped) && LUA_CLASS_OUTSIDE[escaped]) {
        throw new Error(`Lua complement class %${escaped} is not supported inside []`)
      } else {
        source += escaped === '-' || escaped === ']' || escaped === '\\' ? `\\${escaped}` : escaped
      }
      continue
    }
    if (char === '\\' || char === ']') source += '\\'
    source += char
  }
  throw new Error('unfinished character class in Lua pattern')
}

/** Translate the Lua-pattern subset emitted by the static LuaSnip importer. */
export function luaPatternToRegExpSource(pattern: string): string {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]
    if (char === '%') {
      const escaped = pattern[++index]
      if (escaped == null) throw new Error('unfinished % escape in Lua pattern')
      if (escaped === 'b' || escaped === 'f') {
        throw new Error(`Lua pattern %${escaped} is not supported`)
      }
      if (/^[1-9]$/.test(escaped)) {
        source += `\\${escaped}`
      } else {
        source += LUA_CLASS_OUTSIDE[escaped] ?? escapeRegExpChar(escaped)
      }
      continue
    }
    if (char === '[') {
      const translated = translateLuaClass(pattern, index)
      source += translated.source
      index = translated.next - 1
      continue
    }
    if (char === '-') {
      source += '*?'
      continue
    }
    if ('^$().+*?'.includes(char)) {
      source += char
      continue
    }
    source += escapeRegExpChar(char)
  }
  return source
}

const luaPatternCache = new Map<string, RegExp | null>()

function compileLuaPattern(pattern: string): RegExp | null {
  const cached = luaPatternCache.get(pattern)
  if (cached !== undefined || luaPatternCache.has(pattern)) return cached ?? null
  try {
    const compiled = new RegExp(`(?:${luaPatternToRegExpSource(pattern)})$`, 'u')
    luaPatternCache.set(pattern, compiled)
    return compiled
  } catch {
    luaPatternCache.set(pattern, null)
    return null
  }
}

function isInsideCode(state: EditorState, pos: number): boolean {
  let node = syntaxTree(state).resolveInner(pos, 1)
  for (;;) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock' || node.name === 'InlineCode') {
      return true
    }
    if (!node.parent) return false
    node = node.parent
  }
}

const INLINE_MATH_RE = /(?<![\\$])\$(?!\s)(?!\$)((?:\\.|[^$\\])+?)(?<!\s)\$(?!\$)/g
const BLOCK_MATH_RE = /\$\$(?!\$)([\s\S]+?)\$\$/g

interface MathSourceRange {
  from: number
  to: number
}

function markdownMathSourceAt(state: EditorState, pos: number): MathSourceRange | null {
  const text = state.doc.toString()
  BLOCK_MATH_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BLOCK_MATH_RE.exec(text)) !== null) {
    const from = match.index + 2
    const to = match.index + match[0].length - 2
    if (from <= pos && pos <= to && !isInsideCode(state, from)) return { from, to }
  }

  const line = state.doc.lineAt(pos)
  INLINE_MATH_RE.lastIndex = 0
  while ((match = INLINE_MATH_RE.exec(line.text)) !== null) {
    const from = line.from + match.index + 1
    const to = line.from + match.index + match[0].length - 1
    if (from <= pos && pos <= to && !isInsideCode(state, from)) return { from, to }
  }
  return null
}

const LATEX_TEXT_COMMAND_RE = /^\\(?:text|textrm|textnormal|textsf|texttt|textbf|textit|emph)\s*\{/

function isInsideLatexTextCommand(
  state: EditorState,
  range: MathSourceRange,
  pos: number
): boolean {
  const source = state.doc.sliceString(range.from, Math.min(pos, range.to))
  const textStack: boolean[] = []
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '\\') {
      const command = LATEX_TEXT_COMMAND_RE.exec(source.slice(index))
      if (command) {
        const braceOffset = command[0].lastIndexOf('{')
        textStack.push(true)
        index += braceOffset
        continue
      }
      // An escaped brace is data, not structure.
      if (source[index + 1] === '{' || source[index + 1] === '}') index++
      continue
    }
    if (char === '{') {
      textStack.push(textStack[textStack.length - 1] ?? false)
    } else if (char === '}') {
      textStack.pop()
    }
  }
  return textStack[textStack.length - 1] === true
}

function isMarkdownMathAt(state: EditorState, pos: number): boolean {
  const range = markdownMathSourceAt(state, pos)
  return range !== null && !isInsideLatexTextCommand(state, range, pos)
}

function isTikzcdAt(state: EditorState, pos: number): boolean {
  const source = state.doc.sliceString(0, pos)
  const token = /\\(begin|end)\s*\{tikzcd\}/g
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = token.exec(source)) !== null) {
    depth = match[1] === 'begin' ? depth + 1 : Math.max(0, depth - 1)
  }
  return depth > 0
}

function contextMatches(
  context: UserSnippetContext,
  state: EditorState,
  from: number,
  to: number
): boolean {
  const markdownMath = (): boolean => isMarkdownMathAt(state, to)
  const tikzcd = (): boolean => isTikzcdAt(state, to)
  switch (context.type) {
    case 'always':
      return true
    case 'math':
      return markdownMath() || tikzcd()
    case 'text':
      return !markdownMath() && !tikzcd()
    case 'markdown-math':
      return markdownMath()
    case 'markdown-text':
      return !markdownMath()
    case 'tikzcd':
      return tikzcd()
    case 'line-begin': {
      const line = state.doc.lineAt(from)
      return /^\s*$/.test(state.doc.sliceString(line.from, from))
    }
    case 'and':
      return context.all.every((part) => contextMatches(part, state, from, to))
  }
}

function matchTrigger(
  snippet: UserSnippet,
  linePrefix: string
): {
  index: number
  text: string
  captures: readonly string[]
} | null {
  if (snippet.trigger.kind === 'literal') {
    if (!snippet.trigger.value || !linePrefix.endsWith(snippet.trigger.value)) return null
    const index = linePrefix.length - snippet.trigger.value.length
    return { index, text: snippet.trigger.value, captures: [] }
  }
  const pattern = compileLuaPattern(snippet.trigger.value)
  const match = pattern?.exec(linePrefix)
  if (!match || !match[0]) return null
  return { index: match.index, text: match[0], captures: match.slice(1) }
}

function sameSnippetContext(left: UserSnippetContext, right: UserSnippetContext): boolean {
  if (left.type !== right.type) return false
  if (left.type !== 'and' || right.type !== 'and') return true
  return (
    left.all.length === right.all.length &&
    left.all.every((part, index) => sameSnippetContext(part, right.all[index]))
  )
}

function largestSnippetFieldIndex(nodes: readonly UserSnippetNode[]): number {
  let largest = 0
  for (const node of nodes) {
    if (
      node.type === 'insert' ||
      node.type === 'choice' ||
      node.type === 'mirror' ||
      node.type === 'selected'
    ) {
      largest = Math.max(largest, node.index)
    }
    if (node.type === 'choice') {
      for (const choice of node.choices) {
        largest = Math.max(largest, largestSnippetFieldIndex(choice))
      }
    }
  }
  return largest
}

/**
 * LuaSnip permits several manual snippets to share a trigger. Completion
 * integrations normally expose those definitions as alternatives. ZenNotes
 * has no snippet-completion popup, so represent equally ranked, otherwise
 * identical definitions as one native choice node instead of silently making
 * every definition after the first unreachable.
 */
function combineManualAlternatives(candidates: readonly SnippetMatch[]): SnippetMatch | null {
  const winner = candidates[0]
  if (!winner) return null
  const alternatives = candidates.filter(
    (candidate) =>
      candidate.from === winner.from &&
      candidate.to === winner.to &&
      candidate.snippet.priority === winner.snippet.priority &&
      candidate.snippet.wordTrig === winner.snippet.wordTrig &&
      candidate.snippet.trigger.kind === winner.snippet.trigger.kind &&
      candidate.snippet.trigger.value === winner.snippet.trigger.value &&
      sameSnippetContext(candidate.snippet.context, winner.snippet.context)
  )
  if (alternatives.length < 2) return winner

  const choiceIndex =
    Math.max(...alternatives.map(({ snippet }) => largestSnippetFieldIndex(snippet.body))) + 1
  return {
    ...winner,
    snippet: {
      ...winner.snippet,
      body: [
        {
          type: 'choice',
          index: choiceIndex,
          editable: false,
          choices: alternatives.map(({ snippet }) => snippet.body)
        }
      ]
    }
  }
}

function findSnippetMatch(
  state: EditorState,
  cursor: number,
  snippets: readonly UserSnippet[],
  mode: 'automatic' | 'manual'
): SnippetMatch | null {
  const line = state.doc.lineAt(cursor)
  const linePrefix = state.doc.sliceString(line.from, cursor)
  const candidates: SnippetMatch[] = []
  for (const snippet of snippets) {
    if (mode === 'automatic' ? !snippet.auto : snippet.auto) continue
    const trigger = matchTrigger(snippet, linePrefix)
    if (!trigger) continue
    const from = line.from + trigger.index
    if (
      snippet.wordTrig &&
      trigger.index > 0 &&
      /[A-Za-z0-9_]/.test(linePrefix[trigger.index - 1])
    ) {
      continue
    }
    if (!contextMatches(snippet.context, state, from, cursor)) continue
    candidates.push({ snippet, from, to: cursor, captures: trigger.captures })
  }
  candidates.sort(
    (left, right) =>
      right.snippet.priority - left.snippet.priority ||
      left.snippet.order - right.snippet.order ||
      left.snippet.id.localeCompare(right.snippet.id)
  )
  return mode === 'manual' ? combineManualAlternatives(candidates) : (candidates[0] ?? null)
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]
const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The common `os.date` directives used by LuaSnip configs. */
export function formatLuaSnippetDate(format: string, date: Date): string {
  const replacements: Record<string, string> = {
    '%': '%',
    a: SHORT_DAYS[date.getDay()],
    A: LONG_DAYS[date.getDay()],
    b: SHORT_MONTHS[date.getMonth()],
    B: LONG_MONTHS[date.getMonth()],
    d: twoDigits(date.getDate()),
    D: `${twoDigits(date.getMonth() + 1)}/${twoDigits(date.getDate())}/${twoDigits(date.getFullYear() % 100)}`,
    H: twoDigits(date.getHours()),
    m: twoDigits(date.getMonth() + 1),
    M: twoDigits(date.getMinutes()),
    S: twoDigits(date.getSeconds()),
    y: twoDigits(date.getFullYear() % 100),
    Y: String(date.getFullYear())
  }
  return format.replace(
    /%([%aAbBdDHmMSyY])/g,
    (whole, directive: string) => replacements[directive] ?? whole
  )
}

function captureText(
  node: Extract<UserSnippetNode, { type: 'capture' }>,
  captures: readonly string[]
): string {
  const raw = captures[node.index - 1] ?? ''
  switch (node.transform) {
    case 'upper':
      return raw.toUpperCase()
    case 'repeat-hashes': {
      const count = Math.min(1_000, Math.max(0, Number.parseInt(raw, 10) || 0))
      return '#'.repeat(count)
    }
    default:
      return raw
  }
}

function selectedNodeValue(
  node: Extract<UserSnippetNode, { type: 'selected' }>,
  selectedText: string | null
): { text: string; editable: boolean } {
  const hasSelection = selectedText !== null
  const behavior = hasSelection ? node.whenSelected : node.whenEmpty
  return { text: selectedText ?? '', editable: behavior === 'insert' }
}

function renderNodes(
  nodes: readonly UserSnippetNode[],
  context: RenderContext
): RelativeRenderResult {
  let text = ''
  const fields: SnippetFieldRange[] = []
  const choices: SnippetChoiceRange[] = []

  const appendField = (index: number, from: number, to: number): void => {
    if (context.suppressField !== index) fields.push({ index, from, to })
  }

  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        text += node.text
        break
      case 'capture':
        text += captureText(node, context.captures)
        break
      case 'date':
        text += formatLuaSnippetDate(node.format, context.now)
        break
      case 'insert': {
        const value = context.values.get(node.index) ?? node.default ?? ''
        context.values.set(node.index, value)
        const from = text.length
        text += value
        appendField(node.index, from, text.length)
        break
      }
      case 'mirror': {
        const value = context.values.get(node.index) ?? ''
        const from = text.length
        text += value
        appendField(node.index, from, text.length)
        break
      }
      case 'selected': {
        const selected = selectedNodeValue(node, context.selectedText)
        const value = context.values.get(node.index) ?? selected.text
        context.values.set(node.index, value)
        const from = text.length
        text += value
        if (selected.editable) appendField(node.index, from, text.length)
        break
      }
      case 'choice': {
        const from = text.length
        const selectedChoice = node.choices[0] ?? []
        const rendered = renderNodes(selectedChoice, {
          ...context,
          suppressField: context.suppressField
        })
        text += rendered.text
        context.values.set(node.index, rendered.text)
        if (rendered.fields.length) {
          fields.push(
            ...rendered.fields.map((field) => ({
              ...field,
              from: field.from + from,
              to: field.to + from
            }))
          )
        } else if (node.editable === false) {
          fields.push({ index: node.index, from: text.length, to: text.length })
        } else {
          appendField(node.index, from, text.length)
        }
        choices.push({
          index: node.index,
          from,
          to: text.length,
          choices: node.choices,
          current: 0,
          editable: node.editable !== false
        })
        choices.push(
          ...rendered.choices.map((choice) => ({
            ...choice,
            from: choice.from + from,
            to: choice.to + from
          }))
        )
        break
      }
    }
  }
  return { text, fields, choices }
}

function fieldOrder(fields: readonly SnippetFieldRange[]): number[] {
  const unique = [...new Set(fields.map((field) => field.index))]
  return unique.sort((left, right) => {
    if (left === 0) return right === 0 ? 0 : 1
    if (right === 0) return -1
    return left - right
  })
}

function offsetRender(rendered: RelativeRenderResult, offset: number): RelativeRenderResult {
  return {
    text: rendered.text,
    fields: rendered.fields.map((field) => ({
      ...field,
      from: field.from + offset,
      to: field.to + offset
    })),
    choices: rendered.choices.map((choice) => ({
      ...choice,
      from: choice.from + offset,
      to: choice.to + offset
    }))
  }
}

function renderSnippet(
  match: SnippetMatch,
  selectedText: string | null,
  now: Date
): RelativeRenderResult {
  const hasExplicitExit = match.snippet.body.some(
    (node) => node.type === 'insert' && node.index === 0
  )
  const body: readonly UserSnippetNode[] = hasExplicitExit
    ? match.snippet.body
    : [...match.snippet.body, { type: 'insert', index: 0 }]
  return renderNodes(body, {
    captures: match.captures,
    selectedText,
    now,
    values: new Map(),
    suppressField: null
  })
}

function selectionForField(fields: readonly SnippetFieldRange[], index: number): EditorSelection {
  const ranges = fields
    .filter((field) => field.index === index)
    .map((field) => EditorSelection.range(field.from, field.to))
    .sort((left, right) => left.from - right.from || left.to - right.to)
  return EditorSelection.create(ranges)
}

function currentSelectedText(state: EditorState): string | null {
  const runtime = runtimeState(state)
  if (runtime.storedSelection !== null) return runtime.storedSelection
  if (state.selection.ranges.length !== 1 || state.selection.main.empty) return null
  return state.sliceDoc(state.selection.main.from, state.selection.main.to)
}

function nestedInsideActiveField(state: EditorState, from: number, to: number): boolean {
  const sessions = runtimeState(state).sessions
  if (!sessions.length) return false
  const top = sessions[sessions.length - 1]
  return top.fields.some(
    (field) => field.index === top.activeField && field.from <= from && field.to >= to
  )
}

interface ExpansionPlan {
  changes: ChangeSet
  selection: EditorSelection
  action: SnippetRuntimeAction
}

function expansionPlan(
  state: EditorState,
  match: SnippetMatch,
  config: UserSnippetRuntimeConfig
): ExpansionPlan {
  const selectedText = currentSelectedText(state)
  const rendered = renderSnippet(match, selectedText, config.now())
  const absolute = offsetRender(rendered, match.from)
  const changes = state.changes({
    from: match.from,
    to: match.to,
    insert: rendered.text
  })
  const order = fieldOrder(absolute.fields)
  if (!order.length) {
    return {
      changes,
      selection: EditorSelection.single(match.from + rendered.text.length),
      action: {
        type: 'expanded-without-fields',
        clearStored: selectedText !== null
      }
    }
  }
  const session: SnippetSession = {
    fields: absolute.fields,
    choices: absolute.choices,
    activeField: order[0],
    captures: match.captures,
    selectedText
  }
  return {
    changes,
    selection: selectionForField(session.fields, session.activeField),
    action: {
      type: 'push',
      session,
      nested: nestedInsideActiveField(state, match.from, match.to),
      clearStored: selectedText !== null
    }
  }
}

function vimAllowsAutomaticExpansion(view: EditorView): boolean {
  const cm = getCM(view) as {
    state?: { vim?: { insertMode?: boolean } }
  } | null
  return cm === null || cm.state?.vim?.insertMode === true
}

/**
 * CodeMirror input handler. Exported to make the actual DOM-input path directly
 * testable; programmatic document transactions intentionally never call it.
 */
export function handleUserSnippetInput(
  view: EditorView,
  from: number,
  to: number,
  text: string,
  insert: () => Transaction
): boolean {
  const initialConfig = view.state.facet(userSnippetConfig)
  if (
    view.composing ||
    from !== to ||
    !text ||
    view.state.selection.ranges.length !== 1 ||
    !view.state.selection.main.empty ||
    !initialConfig.shouldHandle(view)
  ) {
    return false
  }
  const typed = insert()
  if (!typed.isUserEvent('input.type') || typed.changes.empty) return false
  const typedState = typed.state
  if (typedState.selection.ranges.length !== 1 || !typedState.selection.main.empty) return false
  const config = typedState.facet(userSnippetConfig)
  const match = findSnippetMatch(
    typedState,
    typedState.selection.main.head,
    config.snippets,
    'automatic'
  )
  if (!match) return false

  const plan = expansionPlan(typedState, match, config)
  const expansion = typedState.update({
    changes: plan.changes,
    selection: plan.selection,
    effects: snippetRuntimeEffect.of(plan.action),
    annotations: [
      Transaction.userEvent.of('input.user-snippet.expand'),
      isolateHistory.of('full')
    ],
    scrollIntoView: true
  })
  view.dispatch([typed, expansion])
  return true
}

/** Expand the highest-priority matching snippet at the main cursor. */
export const expandUserSnippet: Command = ({ state, dispatch }) => {
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false
  const config = state.facet(userSnippetConfig)
  const match = findSnippetMatch(state, state.selection.main.head, config.snippets, 'manual')
  if (!match) return false
  const plan = expansionPlan(state, match, config)
  dispatch(
    state.update({
      changes: plan.changes,
      selection: plan.selection,
      effects: snippetRuntimeEffect.of(plan.action),
      annotations: Transaction.userEvent.of('input.user-snippet'),
      scrollIntoView: true
    })
  )
  return true
}

function moveUserSnippetField(direction: -1 | 1): Command {
  return ({ state, dispatch }) => {
    const runtime = runtimeState(state)
    if (!runtime.sessions.length) return false
    const sessions = runtime.sessions.slice()
    const top = sessions[sessions.length - 1]
    const order = fieldOrder(top.fields)
    const current = order.indexOf(top.activeField)
    const target = current + direction

    if (target >= 0 && target < order.length) {
      const updated = { ...top, activeField: order[target] }
      sessions[sessions.length - 1] = updated
      dispatch(
        state.update({
          selection: selectionForField(updated.fields, updated.activeField),
          effects: snippetRuntimeEffect.of({ type: 'set-sessions', sessions }),
          scrollIntoView: true
        })
      )
      return true
    }

    if (sessions.length > 1) {
      sessions.pop()
      if (direction < 0) {
        const parent = sessions[sessions.length - 1]
        dispatch(
          state.update({
            selection: selectionForField(parent.fields, parent.activeField),
            effects: snippetRuntimeEffect.of({
              type: 'set-sessions',
              sessions
            }),
            scrollIntoView: true
          })
        )
        return true
      }

      // Finishing a nested snippet is one forward jump: resume the enclosing
      // session at the field after the placeholder that contained the child.
      // If that parent is itself finished, continue unwinding the stack.
      while (sessions.length) {
        const parentIndex = sessions.length - 1
        const parent = sessions[parentIndex]
        const parentOrder = fieldOrder(parent.fields)
        const nextParentField = parentOrder.indexOf(parent.activeField) + 1
        if (nextParentField > 0 && nextParentField < parentOrder.length) {
          const updated = {
            ...parent,
            activeField: parentOrder[nextParentField]
          }
          sessions[parentIndex] = updated
          dispatch(
            state.update({
              selection: selectionForField(updated.fields, updated.activeField),
              effects: snippetRuntimeEffect.of({
                type: 'set-sessions',
                sessions
              }),
              scrollIntoView: true
            })
          )
          return true
        }
        sessions.pop()
      }

      const childActive = top.fields.filter((field) => field.index === top.activeField)
      const cursor = childActive.length
        ? Math.max(...childActive.map((field) => field.to))
        : state.selection.main.head
      dispatch(
        state.update({
          selection: EditorSelection.cursor(cursor),
          effects: snippetRuntimeEffect.of({
            type: 'set-sessions',
            sessions: []
          })
        })
      )
      return true
    }

    if (direction < 0) {
      if (top.activeField === 0) {
        dispatch(
          state.update({
            effects: snippetRuntimeEffect.of({
              type: 'set-sessions',
              sessions: []
            })
          })
        )
      }
      return false
    }
    const active = top.fields.filter((field) => field.index === top.activeField)
    const cursor = active.length
      ? Math.max(...active.map((field) => field.to))
      : state.selection.main.head
    dispatch(
      state.update({
        selection: EditorSelection.cursor(cursor),
        effects: snippetRuntimeEffect.of({
          type: 'set-sessions',
          sessions: []
        })
      })
    )
    // A root exit node is not jumpable in LuaSnip. Unlink it, but let the
    // editor's next Tab handler run. Nested exits are handled above and still
    // consume the jump while resuming their parent session.
    return top.activeField !== 0
  }
}

export const nextUserSnippetField = moveUserSnippetField(1)
export const previousUserSnippetField = moveUserSnippetField(-1)

/** LuaSnip-style command: expand first, otherwise jump to the next field. */
export const expandOrJumpUserSnippet: Command = (target) =>
  expandUserSnippet(target) || nextUserSnippetField(target)

function valuesFromSession(state: EditorState, session: SnippetSession): Map<number, string> {
  const values = new Map<number, string>()
  for (const field of session.fields) {
    if (!values.has(field.index)) values.set(field.index, state.sliceDoc(field.from, field.to))
  }
  return values
}

function cycleUserSnippetChoice(direction: -1 | 1): Command {
  return ({ state, dispatch }) => {
    const runtime = runtimeState(state)
    if (!runtime.sessions.length) return false
    const session = runtime.sessions[runtime.sessions.length - 1]
    // Position zero is the snippet-wide exit, even when it happens to sit on
    // the inclusive end boundary of a final choice node.
    if (session.activeField === 0) return false
    const activeRanges = session.fields.filter((field) => field.index === session.activeField)
    const choice = session.choices
      .filter(
        (candidate) =>
          candidate.index === session.activeField ||
          activeRanges.some((field) => field.from >= candidate.from && field.to <= candidate.to)
      )
      .sort((left, right) => left.to - left.from - (right.to - right.from))[0]
    if (!choice || choice.choices.length < 2) return false

    const current = choice.current
    const next = (current + direction + choice.choices.length) % choice.choices.length
    const config = state.facet(userSnippetConfig)
    const values = valuesFromSession(state, session)
    values.delete(choice.index)
    const rendered = renderNodes(choice.choices[next] ?? [], {
      captures: session.captures,
      selectedText: session.selectedText,
      now: config.now(),
      values,
      suppressField: null
    })

    // A choice owns one source range even when its active branch contains
    // several inner insert fields. Replacing those fields individually would
    // leave the branch's surrounding text behind (`\\vb{}` -> garbled text).
    const changes = state.changes({
      from: choice.from,
      to: choice.to,
      insert: rendered.text
    })
    const targetFrom = changes.mapPos(choice.from, -1)

    const fields: SnippetFieldRange[] = []
    for (const field of session.fields) {
      const zeroWidthAtOuterBoundary =
        field.from === field.to && (field.from === choice.from || field.from === choice.to)
      const insideChoice =
        field.index === choice.index ||
        (!zeroWidthAtOuterBoundary && field.from >= choice.from && field.to <= choice.to)
      if (insideChoice) continue
      const mapped = mapField(field, changes)
      if (mapped) fields.push(mapped)
    }
    if (rendered.fields.length) {
      fields.push(
        ...rendered.fields.map((field) => ({
          ...field,
          from: targetFrom + field.from,
          to: targetFrom + field.to
        }))
      )
    } else {
      const fieldFrom = choice.editable ? targetFrom : targetFrom + rendered.text.length
      fields.push({
        index: choice.index,
        from: fieldFrom,
        to: targetFrom + rendered.text.length
      })
    }

    const choices: SnippetChoiceRange[] = []
    for (const existing of session.choices) {
      if (existing === choice) continue
      const insideChoice = existing.from >= choice.from && existing.to <= choice.to
      if (insideChoice) continue
      const mapped = mapChoice(existing, changes)
      if (mapped) choices.push(mapped)
    }
    choices.push({
      ...choice,
      from: targetFrom,
      to: targetFrom + rendered.text.length,
      current: next
    })
    choices.push(
      ...rendered.choices.map((nested) => ({
        ...nested,
        from: targetFrom + nested.from,
        to: targetFrom + nested.to
      }))
    )
    const available = fieldOrder(fields)
    const activeField = available.includes(session.activeField)
      ? session.activeField
      : (available[0] ?? session.activeField)
    const updated: SnippetSession = {
      ...session,
      fields,
      choices,
      activeField
    }

    dispatch(
      state.update({
        changes,
        selection: selectionForField(updated.fields, updated.activeField),
        effects: snippetRuntimeEffect.of({
          type: 'replace-top',
          session: updated
        }),
        annotations: Transaction.userEvent.of('input.user-snippet.choice'),
        scrollIntoView: true
      })
    )
    return true
  }
}

export const nextUserSnippetChoice = cycleUserSnippetChoice(1)
export const previousUserSnippetChoice = cycleUserSnippetChoice(-1)

/** Store the current visual/ordinary selection for a later `selected` node. */
export const storeUserSnippetSelection: Command = ({ state, dispatch }) => {
  if (state.selection.ranges.length !== 1 || state.selection.main.empty) return false
  dispatch(
    state.update({
      effects: snippetRuntimeEffect.of({
        type: 'store-selection',
        text: state.sliceDoc(state.selection.main.from, state.selection.main.to)
      })
    })
  )
  return true
}

export const clearUserSnippetSession: Command = ({ state, dispatch }) => {
  if (!runtimeState(state).sessions.length) return false
  dispatch(
    state.update({
      effects: snippetRuntimeEffect.of({ type: 'set-sessions', sessions: [] })
    })
  )
  return true
}

const clearUserSnippetSessionAndPass: Command = (target) => {
  clearUserSnippetSession(target)
  // Escape must still reach CodeMirror-Vim (to leave insert mode) and the
  // surrounding editor's own Escape handlers after clearing snippet state.
  return false
}

export const userSnippetKeymap: readonly KeyBinding[] = [
  { key: 'Tab', run: nextUserSnippetField, shift: previousUserSnippetField },
  { key: 'Escape', run: clearUserSnippetSessionAndPass }
]

/** Test/debug helper; app code should use the commands above. */
export function userSnippetSessionDepth(state: EditorState): number {
  return runtimeState(state).sessions.length
}

export function userSnippetExtension(
  snippets: readonly UserSnippet[],
  options: UserSnippetExtensionOptions = {}
): Extension {
  return [
    userSnippetConfig.of({
      snippets,
      now: options.now ?? DEFAULT_CONFIG.now,
      shouldHandle: options.shouldHandle ?? DEFAULT_CONFIG.shouldHandle
    }),
    snippetRuntimeField,
    EditorState.allowMultipleSelections.of(true),
    Prec.highest(keymap.of(userSnippetKeymap)),
    EditorView.inputHandler.of(handleUserSnippetInput)
  ]
}
