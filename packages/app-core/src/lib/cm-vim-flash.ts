import { highlightingFor, syntaxTree } from '@codemirror/language'
import { StateEffect, type Extension, type Text } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType
} from '@codemirror/view'
import { Vim, getCM } from '@replit/codemirror-vim'
import type { CodeMirrorV } from '@replit/codemirror-vim'
import { getStyleTags, type Tag } from '@lezer/highlight'
import {
  assignFlashLabels,
  findFlashMatches,
  type FlashMatch,
  type FlashTarget
} from './flash-matcher'
import { placeMathMatches, tokenizeLatex, type MathSourceMatch } from './cm-vim-flash-math'
import { invokeVimFlashTarget } from './cm-vim-flash-motion'

type JumpSession = {
  kind: 'jump'
  query: string
  matches: FlashMatch[]
  mathMatches: MathJumpMatch[]
  targets: FlashTarget[]
}

type MathJumpMatch = {
  /** Exact (raw match) or approximate (rendered-only match) document range. */
  from: number
  to: number
  /** Opaque KaTeX replacement widget currently mounted in the viewport. */
  root: HTMLElement
  /** Match range in the widget's raw inner LaTeX, used only for placement. */
  sourceMatch: MathSourceMatch
}

type MathSearchResult = {
  matches: MathJumpMatch[]
  continuationCharacters: Set<string>
}

type MathOverlayLabelMeasurement = {
  label: string
  position: number
  sourceFrom: number
  sourceTo: number
  left: number
  top: number
  width: number
  height: number
  approximate: boolean
}

type MathOverlayMeasurement = {
  root: HTMLElement
  host: HTMLElement
  labels: MathOverlayLabelMeasurement[]
}

function jumpSessionSignature(session: JumpSession): string {
  const sourceMatches = session.matches.map((match) => `${match.from}:${match.to}`).join(',')
  const mathMatches = session.mathMatches.map((match) => `${match.from}:${match.to}`).join(',')
  const targets = session.targets
    .map((target) => `${target.from}:${target.to}:${target.label}`)
    .join(',')
  return `${session.query}|${sourceMatches}|${mathMatches}|${targets}`
}

type CharacterSession = {
  kind: 'character'
  /** Direction of the original f/F search. */
  direction: 1 | -1
  character: string
  positions: number[]
  index: number
}

type FlashSession = JumpSession | CharacterSession

type PendingCharacterSearch = {
  adapter: CodeMirrorV
  doc: Text
  forward: boolean
  origin: number
}

const refreshFlash = StateEffect.define<null>()

function isVimEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' ||
    (event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      (event.key === '[' || event.key.toLowerCase() === 'c'))
  )
}

function printableKey(event: KeyboardEvent): string | null {
  if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return null
  return Array.from(event.key).length === 1 ? event.key : null
}

function characterLengthAt(text: string, offset: number): number {
  const codePoint = text.codePointAt(offset)
  return codePoint != null && codePoint > 0xffff ? 2 : 1
}

function sourceHighlightClasses(view: EditorView, offset: number): string {
  const tags: Tag[] = []
  let node = syntaxTree(view.state).resolveInner(offset, 1)
  let deepest = true
  for (;;) {
    const rule = getStyleTags(node)
    if (rule && (deepest || rule.inherit)) tags.push(...rule.tags)
    if (!node.parent) break
    node = node.parent
    deepest = false
  }
  if (!tags.length) return ''

  const classes = highlightingFor(view.state, tags)
  return classes ? [...new Set(classes.split(/\s+/).filter(Boolean))].join(' ') : ''
}

function findExactCharacterPositions(
  text: string,
  character: string,
  from: number,
  to: number
): number[] {
  if (!character) return []
  const positions: number[] = []
  let position = text.indexOf(character, from)
  while (position >= from && position + character.length <= to) {
    positions.push(position)
    position = text.indexOf(character, position + character.length)
  }
  return positions
}

function renderedMatchesToSource(
  source: string,
  rendered: string,
  renderedMatches: readonly FlashMatch[]
): MathSourceMatch[] {
  const tokens = tokenizeLatex(source).filter(
    (token) =>
      token.kind !== 'whitespace' &&
      !(
        token.kind === 'character' &&
        (token.text === '{' || token.text === '}' || token.text === '_' || token.text === '^')
      )
  )
  if (!tokens.length || !rendered.length) return []

  const desiredIndices = renderedMatches.map((match) => {
    const progress = (match.from + match.to) / 2 / rendered.length
    return Math.round(progress * Math.max(0, tokens.length - 1))
  })
  const assignedIndices: number[] = []
  for (let index = 0; index < desiredIndices.length; index++) {
    if (renderedMatches.length > tokens.length) {
      assignedIndices.push(Math.max(0, Math.min(tokens.length - 1, desiredIndices[index])))
      continue
    }
    const minimum = index === 0 ? 0 : assignedIndices[index - 1] + 1
    const maximum = tokens.length - (desiredIndices.length - index)
    assignedIndices.push(Math.max(minimum, Math.min(maximum, desiredIndices[index])))
  }

  const unique = new Map<string, MathSourceMatch>()
  for (const tokenIndex of assignedIndices) {
    const token = tokens[tokenIndex]
    unique.set(`${token.from}:${token.to}`, {
      from: token.from,
      to: token.to
    })
  }
  return [...unique.values()]
}

/**
 * Search KaTeX replacement widgets that CodeMirror omits from
 * `EditorView.visibleRanges`.
 *
 * Raw LaTeX occurrences remain separate targets and retain their exact
 * document offsets. Rendered-only matches are mapped approximately back to a
 * generic source token. Visual placement is also approximate, but resolving a
 * raw match always lands on the precise occurrence and lets cm-math-render's
 * normal cursor rule reveal the source.
 */
function findMathJumpMatches(view: EditorView, query: string): MathSearchResult {
  const result: MathSearchResult = {
    matches: [],
    continuationCharacters: new Set()
  }
  if (!query) return result

  const roots = view.contentDOM.querySelectorAll<HTMLElement>(
    '.cm-math-inline[data-math-source][data-math-source-offset], .cm-math-block[data-math-source][data-math-source-offset]'
  )
  for (const root of roots) {
    const source = root.dataset.mathSource ?? ''
    const rendered = root.querySelector<HTMLElement>('.katex-html')?.textContent ?? ''
    const sourceOffset = Number.parseInt(root.dataset.mathSourceOffset ?? '', 10)
    if (!source || !Number.isFinite(sourceOffset)) continue

    const rawMatches = findFlashMatches(source, query, [{ from: 0, to: source.length }])
    const renderedMatches = rendered
      ? findFlashMatches(rendered, query, [{ from: 0, to: rendered.length }])
      : []
    const renderedSourceMatches = renderedMatchesToSource(source, rendered, renderedMatches)
    const sourceMatchesByRange = new Map<string, MathSourceMatch>()
    for (const match of rawMatches) {
      sourceMatchesByRange.set(`${match.from}:${match.to}`, match)
    }
    // Raw text is canonical when it already accounts for every rendered
    // occurrence. If rendering creates additional matches (for example a
    // literal `π` beside `\pi`), retain approximate source targets for those
    // extra visible occurrences as well.
    if (!rawMatches.length || renderedMatches.length > rawMatches.length) {
      for (const match of renderedSourceMatches) {
        sourceMatchesByRange.set(`${match.from}:${match.to}`, match)
      }
    }
    const sourceMatches = [...sourceMatchesByRange.values()].sort(
      (left, right) => left.from - right.from || left.to - right.to
    )
    if (!sourceMatches.length) continue

    for (const [alias, matches] of [
      [source, rawMatches],
      [rendered, renderedMatches]
    ] as const) {
      for (const match of matches) {
        if (match.to >= alias.length) continue
        const codePoint = alias.codePointAt(match.to)
        if (codePoint != null) {
          result.continuationCharacters.add(String.fromCodePoint(codePoint))
        }
      }
    }

    let sourceFrom: number
    try {
      sourceFrom = view.posAtDOM(root) + sourceOffset
    } catch {
      // A viewport update may detach a widget between the querySelector call
      // and position lookup. It will be reconsidered on the next recompute.
      continue
    }

    for (const sourceMatch of sourceMatches) {
      result.matches.push({
        from: sourceFrom + sourceMatch.from,
        to: sourceFrom + sourceMatch.to,
        root,
        sourceMatch
      })
    }
  }
  return result
}

/**
 * Render a jump label in place of the first source glyph.
 *
 * This deliberately uses a replacement widget instead of a mark plus an
 * absolutely-positioned pseudo-element. Markdown highlighting can nest its
 * own spans inside a mark (making the source glyph visible again), and an
 * absolute child of an inline span doesn't share the source text's baseline.
 * A replacement widget removes the source DOM entirely. The hidden source
 * glyph keeps its exact width and line box while the visible hint is laid out
 * against the same inherited font metrics.
 */
class FlashLabelWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly sourceCharacter: string,
    readonly sourceClasses: string
  ) {
    super()
  }

  eq(other: FlashLabelWidget): boolean {
    return (
      other.label === this.label &&
      other.sourceCharacter === this.sourceCharacter &&
      other.sourceClasses === this.sourceClasses
    )
  }

  toDOM(): HTMLElement {
    const label = document.createElement('span')
    label.className = ['cm-flash-label', this.sourceClasses].filter(Boolean).join(' ')
    label.dataset.flashLabel = this.label
    label.setAttribute('aria-hidden', 'true')
    label.setAttribute('contenteditable', 'false')

    const source = document.createElement('span')
    source.className = 'cm-flash-label-source'
    source.textContent = this.sourceCharacter

    const hint = document.createElement('span')
    hint.className = 'cm-flash-label-hint'
    hint.textContent = this.label

    label.append(source, hint)
    return label
  }
}

function makeDecorations(view: EditorView, session: FlashSession | null): DecorationSet {
  if (!session) return Decoration.none
  const text = view.state.doc.toString()

  if (session.kind === 'character') {
    return Decoration.set(
      session.positions.map((from, index) =>
        Decoration.mark({
          class:
            index === session.index
              ? 'cm-flash-char-match cm-flash-char-current'
              : 'cm-flash-char-match'
        }).range(from, from + characterLengthAt(text, from))
      ),
      true
    )
  }

  const labels = new Map(session.targets.map((target) => [target.from, target.label]))
  const ranges = session.matches.flatMap((match) => {
    const result = [Decoration.mark({ class: 'cm-flash-match' }).range(match.from, match.to)]
    const label = labels.get(match.from)
    if (label) {
      const to = match.from + characterLengthAt(text, match.from)
      result.push(
        Decoration.replace({
          widget: new FlashLabelWidget(
            label,
            text.slice(match.from, to),
            sourceHighlightClasses(view, match.from)
          )
        }).range(match.from, to)
      )
    }
    return result
  })
  return Decoration.set(ranges, true)
}

function vimModeAllowsFlash(adapter: CodeMirrorV | null): adapter is CodeMirrorV {
  return !!adapter?.state?.vim && !adapter.state.vim.insertMode
}

function bufferedInput(adapter: CodeMirrorV): string {
  return adapter.state.vim.inputState.keyBuffer.join('')
}

function inputCanStartFlash(adapter: CodeMirrorV): boolean {
  if (!vimModeAllowsFlash(adapter) || adapter.state.vim.expectLiteralNext) return false
  const buffered = bufferedInput(adapter)
  return !buffered || /^\d+$/.test(buffered)
}

function effectiveRepeat(adapter: CodeMirrorV): number {
  const committed = adapter.state.vim.inputState.getRepeat() || 1
  const buffered = bufferedInput(adapter)
  const pending = /^\d+$/.test(buffered) ? Number.parseInt(buffered, 10) : 1
  return Math.max(1, committed * pending)
}

class VimFlashController {
  decorations: DecorationSet = Decoration.none

  private session: FlashSession | null = null
  private adapter: CodeMirrorV | null = null
  private pendingCharacterSearch: PendingCharacterSearch | null = null
  private ignoreSelectionUpdates = 0
  private readonly prompt: HTMLDivElement
  private readonly mathOverlayMeasureKey = {}
  private readonly resizeObserver: ResizeObserver | null
  private destroyed = false
  private postDomRefreshQueued = false

  private readonly onVimKeypress = (key: unknown): void => {
    if (typeof key !== 'string') return

    const pending = this.pendingCharacterSearch
    if (pending) {
      this.pendingCharacterSearch = null
      if (key === '<Esc>' || key === '<C-c>') return

      const lastSearch = Vim.getVimGlobalState_().lastCharacterSearch
      const character = lastSearch.selectedCharacter
      if (!character || lastSearch.forward !== pending.forward) return

      // The adapter fires vim-keypress after the literal motion is complete.
      // Defer our own decoration update so it cannot nest a dispatch inside
      // codemirror-vim's key handler.
      queueMicrotask(() => {
        if (
          this.destroyed ||
          this.adapter !== pending.adapter ||
          this.view.state.doc !== pending.doc
        ) {
          return
        }
        this.finishCharacterSearch(character, pending.forward, pending.origin)
      })
      return
    }

    const adapter = this.adapter
    if (!vimModeAllowsFlash(adapter) || (key !== 'f' && key !== 'F')) return
    const vim = adapter.state.vim
    const keyBuffer = vim.inputState.keyBuffer
    if (!vim.expectLiteralNext || keyBuffer[keyBuffer.length - 1] !== key) return

    this.pendingCharacterSearch = {
      adapter,
      doc: this.view.state.doc,
      forward: key === 'f',
      origin: adapter.indexFromPos(adapter.getCursor('head'))
    }
  }

  constructor(readonly view: EditorView) {
    this.prompt = view.dom.ownerDocument.createElement('div')
    this.prompt.className = 'cm-flash-prompt'
    this.prompt.setAttribute('aria-live', 'polite')
    this.prompt.hidden = true
    view.dom.appendChild(this.prompt)
    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.requestMathOverlayMeasure())
    this.resizeObserver?.observe(view.dom)
    this.syncAdapter()
  }

  update(update: ViewUpdate): void {
    this.syncAdapter()

    if (!vimModeAllowsFlash(this.adapter) && (this.session || this.pendingCharacterSearch)) {
      this.clear(false)
      return
    }

    if (update.docChanged || (update.focusChanged && !this.view.hasFocus)) {
      this.clear(false)
      return
    }

    if (update.selectionSet && this.session) {
      if (this.ignoreSelectionUpdates > 0) {
        this.ignoreSelectionUpdates -= 1
      } else {
        this.clear(false)
        return
      }
    }

    if (!(update.viewportChanged && this.session?.kind === 'jump') && this.session) {
      this.decorations = makeDecorations(this.view, this.session)
    }
    if (update.geometryChanged && this.session?.kind === 'jump') {
      this.requestMathOverlayMeasure()
    }
  }

  /**
   * CodeMirror calls ViewPlugin.update before it mounts the new document DOM.
   * Re-scan replacement widgets here so formulas newly mounted by scrolling or
   * extension reconfiguration receive targets and overlays in the same update.
   */
  docViewUpdate(): void {
    const session = this.session
    if (session?.kind !== 'jump') return

    const before = jumpSessionSignature(session)
    this.recomputeJumpSession()
    if (jumpSessionSignature(session) !== before) {
      this.queuePostDomRefresh()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.resizeObserver?.disconnect()
    this.detachAdapter()
    this.clearMathDecorations()
    this.view.dom.classList.remove('cm-flash-jump-active')
    this.prompt.remove()
  }

  active(): boolean {
    return this.session !== null
  }

  startJump(): boolean {
    const adapter = getCM(this.view) as CodeMirrorV | null
    if (!adapter || !inputCanStartFlash(adapter)) return false
    this.syncAdapter()
    this.pendingCharacterSearch = null
    this.session = {
      kind: 'jump',
      query: '',
      matches: [],
      mathMatches: [],
      targets: []
    }
    this.recomputeJumpSession()
    this.refresh()
    return true
  }

  handleKey(event: KeyboardEvent): boolean {
    const session = this.session
    if (!session) return false

    if (isVimEscape(event)) {
      // Clear our UI, then let Vim receive Escape as well so visual mode,
      // pending operators, and counts are cancelled through their normal path.
      this.clear(true)
      return false
    }

    if (session.kind === 'character') {
      const adapter = this.adapter
      if (
        (event.key === 'f' || event.key === 'F') &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !!adapter &&
        inputCanStartFlash(adapter)
      ) {
        this.repeatCharacterSearch(event.key === 'f')
        return true
      }
      // Any other Vim motion is allowed through. Its resulting selection or
      // document update clears these highlights in update().
      return false
    }

    if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      const characters = Array.from(session.query)
      characters.pop()
      session.query = characters.join('')
      this.recomputeJumpSession()
      this.refresh()
      return true
    }

    if (event.key === 'Enter' && session.targets.length > 0) {
      this.resolveJump(session.targets[0].from)
      return true
    }

    const character = printableKey(event)
    if (character != null) {
      const target = session.targets.find((candidate) => candidate.label === character)
      if (target) {
        this.resolveJump(target.from)
      } else {
        session.query += character
        this.recomputeJumpSession()
        this.refresh()
      }
      return true
    }

    // While an incremental jump is open, don't leak unsupported keys into
    // app leader/pane routing or into an unfinished Vim operator.
    return true
  }

  private finishCharacterSearch(character: string, forward: boolean, origin: number): void {
    const adapter = this.adapter
    if (!vimModeAllowsFlash(adapter)) return

    const cursor = adapter.getCursor('head')
    const line = this.view.state.doc.line(cursor.line + 1)
    // The labeled `s` jump is case-insensitive, but native Vim f/F motions are
    // case-sensitive. Keep the enhanced repeat list aligned with the stock
    // motion that initiated the session.
    const positions = findExactCharacterPositions(
      this.view.state.doc.toString(),
      character,
      line.from,
      line.to
    )
    const cursorOffset = adapter.indexFromPos(cursor)
    const index = positions.indexOf(cursorOffset)

    // A failed f/F motion leaves the cursor in place. Do not create a repeat
    // session unless Vim actually landed on an occurrence.
    if (index < 0 || cursorOffset === origin) return

    this.session = {
      kind: 'character',
      direction: forward ? 1 : -1,
      character,
      positions,
      index
    }
    this.decorations = makeDecorations(this.view, this.session)
    this.updatePrompt()
    this.refresh()
  }

  private repeatCharacterSearch(sameDirection: boolean): void {
    const session = this.session
    if (session?.kind !== 'character') return

    const adapter = this.adapter
    if (!vimModeAllowsFlash(adapter)) {
      this.clear(true)
      return
    }

    const repeat = effectiveRepeat(adapter)
    const step = session.direction * (sameDirection ? 1 : -1)
    const nextIndex = session.index + step * repeat
    const target = session.positions[nextIndex]
    if (target == null) {
      const vimInput = adapter.state.vim.inputState
      const hadOperator = !!vimInput.operator
      const hasPendingInput =
        hadOperator || vimInput.getRepeat() > 0 || /^\d+$/.test(bufferedInput(adapter))
      if (!hasPendingInput) return

      if (hadOperator) {
        Vim.handleKey(adapter, '<Esc>', 'user')
        this.clear(true)
        return
      }

      const consumed = invokeVimFlashTarget(this.view, session.positions[session.index], {
        forward: step > 0,
        inclusive: false
      })
      if (!consumed) this.clear(true)
      return
    }

    session.index = nextIndex
    this.decorations = makeDecorations(this.view, session)
    this.ignoreSelectionUpdates += 1
    const moved = invokeVimFlashTarget(this.view, target, {
      forward: step > 0,
      inclusive: step > 0
    })
    if (!moved) this.clear(true)
  }

  private resolveJump(target: number): void {
    const adapter = this.adapter
    if (!vimModeAllowsFlash(adapter)) {
      this.clear(true)
      return
    }
    const origin = adapter.indexFromPos(adapter.getCursor('head'))
    this.session = null
    this.decorations = Decoration.none
    this.clearMathDecorations()
    this.updatePrompt()
    const moved = invokeVimFlashTarget(this.view, target, {
      forward: target >= origin,
      inclusive: target >= origin,
      toJumplist: true
    })
    if (!moved) this.refresh()
  }

  private recomputeJumpSession(): void {
    const session = this.session
    if (session?.kind !== 'jump') return
    const text = this.view.state.doc.toString()
    const previousLabels = new Map(session.targets.map((target) => [target.from, target.label]))
    session.matches = findFlashMatches(text, session.query, this.view.visibleRanges)
    const mathSearch = findMathJumpMatches(this.view, session.query)
    session.mathMatches = mathSearch.matches
    const allMatches = [
      ...session.matches,
      ...session.mathMatches.map(({ from, to }) => ({ from, to }))
    ]
    session.targets = assignFlashLabels(
      text,
      allMatches,
      this.view.state.selection.main.head,
      previousLabels,
      mathSearch.continuationCharacters
    )
    this.decorations = makeDecorations(this.view, session)
    this.applyMathDecorations(session)
    this.updatePrompt()
  }

  private measureMathDecorations(session: JumpSession): MathOverlayMeasurement[] {
    const labels = new Map(session.targets.map((target) => [target.from, target.label]))
    const matchesByRoot = new Map<HTMLElement, MathJumpMatch[]>()
    for (const match of session.mathMatches) {
      if (!labels.has(match.from)) continue
      const matches = matchesByRoot.get(match.root) ?? []
      matches.push(match)
      matchesByRoot.set(match.root, matches)
    }

    const measured: MathOverlayMeasurement[] = []
    for (const [root, matches] of matchesByRoot) {
      const source = root.dataset.mathSource ?? ''
      const placements = placeMathMatches(
        root,
        source,
        matches.map((match) => match.sourceMatch)
      )
      const placementsByRange = new Map(
        placements.map((placement) => [`${placement.from}:${placement.to}`, placement])
      )
      if (!placements.length) continue

      const host = root.querySelector<HTMLElement>('.katex-display') ?? root
      const hostRect = host.getBoundingClientRect()
      const occupied: Array<{
        left: number
        top: number
        width: number
        height: number
      }> = []
      const measuredLabels: MathOverlayLabelMeasurement[] = []

      for (const match of matches) {
        const labelText = labels.get(match.from)
        const placement = placementsByRange.get(`${match.sourceMatch.from}:${match.sourceMatch.to}`)
        if (!labelText || !placement) continue

        const anchorRect = placement.anchor.rect
        const width = Math.max(10, anchorRect.width)
        const height = Math.max(14, anchorRect.height)
        const desiredLeft =
          anchorRect.left - hostRect.left + host.scrollLeft + (anchorRect.width - width) / 2
        const desiredTop =
          anchorRect.top - hostRect.top + host.scrollTop + (anchorRect.height - height) / 2

        let left = desiredLeft
        let top = desiredTop
        for (let attempt = 0; attempt < 12; attempt++) {
          const overlaps = occupied.some(
            (box) =>
              left < box.left + box.width &&
              left + width > box.left &&
              top < box.top + box.height &&
              top + height > box.top
          )
          if (!overlaps) break
          const distance = Math.ceil((attempt + 1) / 2)
          const direction = attempt % 2 === 0 ? 1 : -1
          left = desiredLeft + direction * distance * (width + 2)
          top = desiredTop - Math.floor(attempt / 4) * (height + 2)
        }
        occupied.push({ left, top, width, height })

        measuredLabels.push({
          label: labelText,
          position: match.from,
          sourceFrom: match.sourceMatch.from,
          sourceTo: match.sourceMatch.to,
          left,
          top,
          width,
          height,
          approximate: placement.anchor.synthetic
        })
      }

      if (measuredLabels.length) measured.push({ root, host, labels: measuredLabels })
    }
    return measured
  }

  private paintMathDecorations(measured: readonly MathOverlayMeasurement[]): void {
    this.clearMathDecorations()
    for (const { root, host, labels } of measured) {
      if (!this.view.contentDOM.contains(root) || !root.contains(host)) continue

      const layer = root.ownerDocument.createElement('span')
      layer.className = 'cm-flash-math-overlay-layer'
      layer.setAttribute('aria-hidden', 'true')
      layer.setAttribute('contenteditable', 'false')
      for (const measurement of labels) {
        const label = root.ownerDocument.createElement('span')
        label.className = 'cm-flash-math-label'
        label.dataset.flashLabel = measurement.label
        label.dataset.flashPosition = String(measurement.position)
        label.dataset.flashMatchFrom = String(measurement.sourceFrom)
        label.dataset.flashMatchTo = String(measurement.sourceTo)
        label.dataset.flashAnchor = measurement.approximate ? 'approximate' : 'glyph'
        label.textContent = measurement.label
        label.style.left = `${measurement.left}px`
        label.style.top = `${measurement.top}px`
        label.style.width = `${measurement.width}px`
        label.style.height = `${measurement.height}px`
        layer.appendChild(label)
      }

      root.classList.add('cm-flash-math-match')
      host.classList.add('cm-flash-math-overlay-host')
      host.appendChild(layer)
    }
  }

  private applyMathDecorations(session: JumpSession): void {
    this.clearMathDecorations()
    const labeledPositions = new Set(session.targets.map((target) => target.from))
    if (session.mathMatches.some((match) => labeledPositions.has(match.from))) {
      this.requestMathOverlayMeasure()
    }
  }

  private requestMathOverlayMeasure(): void {
    if (this.destroyed || this.session?.kind !== 'jump') return
    this.view.requestMeasure({
      key: this.mathOverlayMeasureKey,
      read: () => {
        const session = this.session
        return session?.kind === 'jump'
          ? { session, measured: this.measureMathDecorations(session) }
          : null
      },
      write: (result) => {
        if (!result || this.destroyed || result.session !== this.session) return
        this.paintMathDecorations(result.measured)
      }
    })
  }

  private clearMathDecorations(): void {
    for (const layer of this.view.contentDOM.querySelectorAll<HTMLElement>(
      '.cm-flash-math-overlay-layer'
    )) {
      layer.remove()
    }
    for (const root of this.view.contentDOM.querySelectorAll<HTMLElement>('.cm-flash-math-match')) {
      root.classList.remove('cm-flash-math-match')
    }
    for (const host of this.view.contentDOM.querySelectorAll<HTMLElement>(
      '.cm-flash-math-overlay-host'
    )) {
      host.classList.remove('cm-flash-math-overlay-host')
    }
  }

  private updatePrompt(): void {
    const session = this.session
    const jumpActive = session?.kind === 'jump'
    this.view.dom.classList.toggle('cm-flash-jump-active', jumpActive)
    if (session?.kind === 'jump') {
      this.prompt.hidden = false
      this.prompt.textContent = `Jump: ${session.query}`
      return
    }
    this.prompt.hidden = true
    this.prompt.textContent = ''
  }

  private syncAdapter(): void {
    const next = getCM(this.view) as CodeMirrorV | null
    if (next === this.adapter) return
    this.detachAdapter()
    this.adapter = next
    this.adapter?.on('vim-keypress', this.onVimKeypress)
  }

  private detachAdapter(): void {
    this.adapter?.off('vim-keypress', this.onVimKeypress)
    this.adapter = null
    this.pendingCharacterSearch = null
  }

  private clear(dispatch: boolean): void {
    if (!this.session && !this.pendingCharacterSearch) return
    this.session = null
    this.pendingCharacterSearch = null
    this.decorations = Decoration.none
    this.clearMathDecorations()
    this.ignoreSelectionUpdates = 0
    this.updatePrompt()
    if (dispatch) this.refresh()
  }

  private refresh(): void {
    if (this.destroyed) return
    try {
      this.view.dispatch({ effects: refreshFlash.of(null) })
    } catch {
      // The editor can be destroyed while a deferred Vim signal is settling.
    }
  }

  private queuePostDomRefresh(): void {
    if (this.postDomRefreshQueued) return
    this.postDomRefreshQueued = true
    queueMicrotask(() => {
      this.postDomRefreshQueued = false
      if (this.destroyed || this.session?.kind !== 'jump') return
      this.refresh()
    })
  }
}

const vimFlashPlugin = ViewPlugin.fromClass(VimFlashController, {
  decorations: (controller) => controller.decorations
})

const vimFlashTheme = EditorView.baseTheme({
  '&': {
    position: 'relative'
  },
  // codemirror-vim paints its block cursor in a separate absolute layer and
  // copies the original document character into it. Hide that layer while
  // labels are active so a cursor on a target cannot redraw the source glyph
  // over the replacement hint.
  '&.cm-flash-jump-active .cm-vimCursorLayer': {
    visibility: 'hidden'
  },
  '.cm-flash-match': {
    backgroundColor: 'rgb(var(--z-accent) / 0.18)',
    borderRadius: '2px'
  },
  '.cm-flash-label': {
    display: 'inline-block',
    position: 'relative',
    boxSizing: 'border-box',
    verticalAlign: 'baseline',
    color: 'rgb(var(--z-bg))',
    backgroundColor: 'rgb(var(--z-accent))',
    borderRadius: '2px',
    padding: '0',
    margin: '0'
  },
  '.cm-flash-label-source': {
    visibility: 'hidden'
  },
  '.cm-flash-label-hint': {
    position: 'absolute',
    inset: '0',
    display: 'block',
    color: 'rgb(var(--z-bg))',
    WebkitTextFillColor: 'rgb(var(--z-bg))',
    fontWeight: '700',
    fontStyle: 'normal',
    textDecoration: 'none',
    textTransform: 'none',
    lineHeight: 'inherit',
    textAlign: 'center',
    whiteSpace: 'pre'
  },
  // KaTeX is an opaque replacement widget. Keep its DOM and dimensions
  // untouched, then paint one absolutely-positioned hint per raw match in a
  // root-local overlay that scrolls with the formula.
  '.cm-flash-math-match': {
    position: 'relative'
  },
  '.cm-flash-math-overlay-host': {
    position: 'relative'
  },
  '.cm-flash-math-overlay-layer': {
    position: 'absolute',
    inset: '0',
    zIndex: '4',
    overflow: 'visible',
    pointerEvents: 'none'
  },
  '.cm-flash-math-label': {
    position: 'absolute',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    padding: '0',
    color: 'rgb(var(--z-bg))',
    WebkitTextFillColor: 'rgb(var(--z-bg))',
    backgroundColor: 'rgb(var(--z-accent))',
    borderRadius: '2px',
    fontFamily: "var(--z-mono-font, 'SF Mono', 'SFMono-Regular', ui-monospace, Menlo, monospace)",
    fontSize: '11px',
    fontStyle: 'normal',
    fontWeight: '700',
    lineHeight: '1',
    textAlign: 'center',
    whiteSpace: 'nowrap',
    pointerEvents: 'none'
  },
  '.cm-flash-char-match': {
    color: 'rgb(var(--z-accent))',
    backgroundColor: 'rgb(var(--z-accent) / 0.18)',
    borderBottom: '2px solid rgb(var(--z-accent))',
    borderRadius: '2px',
    fontWeight: '700'
  },
  '.cm-flash-char-current': {
    backgroundColor: 'rgb(var(--z-accent) / 0.36)'
  },
  '.cm-flash-prompt': {
    position: 'absolute',
    right: '10px',
    bottom: '8px',
    zIndex: '20',
    padding: '3px 8px',
    color: 'rgb(var(--z-bg))',
    backgroundColor: 'rgb(var(--z-accent))',
    borderRadius: '4px',
    fontFamily: "var(--z-mono-font, 'SF Mono', 'SFMono-Regular', ui-monospace, Menlo, monospace)",
    fontSize: '12px',
    fontWeight: '700',
    pointerEvents: 'none'
  }
})

/** Native CodeMirror extension implementing Flash-style jump and f/F repeats. */
export const vimFlashExtension: Extension = [vimFlashPlugin, vimFlashTheme]

/** Start an incremental labeled jump in a Vim-enabled non-insert editor. */
export function startVimFlashJump(view: EditorView): boolean {
  return view.plugin(vimFlashPlugin)?.startJump() ?? false
}

/** Route a key to an active Flash session. Returns true when it was consumed. */
export function handleVimFlashKey(view: EditorView, event: KeyboardEvent): boolean {
  return view.plugin(vimFlashPlugin)?.handleKey(event) ?? false
}

export function isVimFlashActive(view: EditorView): boolean {
  return view.plugin(vimFlashPlugin)?.active() ?? false
}
