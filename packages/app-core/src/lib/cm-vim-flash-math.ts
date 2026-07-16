/**
 * Geometry helpers for Vim Flash targets inside rendered KaTeX widgets.
 *
 * KaTeX does not expose a general source-to-output map. These helpers therefore
 * use source token order and visible glyph order to choose an approximate
 * anchor. The document offsets remain exact; only the on-screen hint position
 * is approximate. All functions are read-only and never insert anything into
 * KaTeX's layout.
 */

export type LatexTokenKind = 'control-word' | 'control-symbol' | 'whitespace' | 'character'

export interface LatexToken {
  /** UTF-16 offsets in the raw inner LaTeX source. */
  from: number
  to: number
  text: string
  kind: LatexTokenKind
}

export interface MathSourceMatch {
  /** UTF-16 offsets in the raw inner LaTeX source. */
  from: number
  to: number
}

/** A viewport-relative rectangle copied from the DOM. */
export interface MathVisualRect {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface MathVisualAnchor {
  /** The nearest rendered element; useful for lifecycle/containment checks. */
  element: HTMLElement
  /** Viewport-relative geometry. No layout styles are applied by this module. */
  rect: MathVisualRect
  /** Visible code point represented by this anchor, if one was available. */
  text: string
  /** Stable visual-order index within the collection returned for one formula. */
  index: number
  /** True when geometry was estimated proportionally from the formula box. */
  synthetic: boolean
}

export interface MathMatchPlacement extends MathSourceMatch {
  anchor: MathVisualAnchor
  /** Index of the chosen anchor in the supplied visual-anchor array. */
  anchorIndex: number
  /** Approximate position of this match through the token stream, from 0 to 1. */
  sourceProgress: number
  /** First visual source token touched, or null for an empty token stream. */
  sourceTokenIndex: number | null
  /** Metadata for separating labels that inevitably share one visual anchor. */
  collisionIndex: number
  collisionCount: number
  /** Suggested overlay offsets. The first label stays directly on its glyph. */
  offsetX: number
  offsetY: number
}

const INVISIBLE_TEXT = /^[\s\u200b-\u200d\u2060\ufeff]+$/u
const NON_GLYPH_SELECTOR =
  '.katex-mathml, annotation, style, script, noscript, .strut, .vlist-s, .mspace, .cm-flash-math-overlay-layer'

/**
 * Split LaTeX without interpreting any commands.
 *
 * A control word such as `\\sum` is deliberately one token. A backslash plus
 * one non-letter code point is one control-symbol token, whitespace is grouped,
 * and every other Unicode code point is an independent token. This gives us a
 * useful source order while avoiding a command-specific semantic map.
 */
export function tokenizeLatex(source: string): LatexToken[] {
  const tokens: LatexToken[] = []
  let offset = 0

  while (offset < source.length) {
    const from = offset
    const codePoint = source.codePointAt(offset)
    if (codePoint == null) break
    const character = String.fromCodePoint(codePoint)

    if (character === '\\') {
      offset += 1
      const wordStart = offset
      while (offset < source.length && /[A-Za-z@]/.test(source[offset])) {
        offset += 1
      }
      if (offset > wordStart) {
        tokens.push({
          from,
          to: offset,
          text: source.slice(from, offset),
          kind: 'control-word'
        })
        continue
      }

      if (offset < source.length) {
        offset += codePointLengthAt(source, offset)
      }
      tokens.push({
        from,
        to: offset,
        text: source.slice(from, offset),
        kind: 'control-symbol'
      })
      continue
    }

    if (/\s/u.test(character)) {
      offset += character.length
      while (offset < source.length) {
        const next = source.codePointAt(offset)
        if (next == null || !/\s/u.test(String.fromCodePoint(next))) break
        offset += codePointLengthAt(source, offset)
      }
      tokens.push({
        from,
        to: offset,
        text: source.slice(from, offset),
        kind: 'whitespace'
      })
      continue
    }

    offset += character.length
    tokens.push({
      from,
      to: offset,
      text: source.slice(from, offset),
      kind: 'character'
    })
  }

  return tokens
}

/**
 * Collect visible KaTeX glyphs in DOM order.
 *
 * Text-node ranges provide character-sized rectangles in browsers. When a
 * range rectangle is unavailable (notably in jsdom), the host element's box is
 * divided between its visible code points. Sizing struts, MathML accessibility
 * markup, hidden nodes, whitespace, and zero-area artifacts are omitted.
 */
export function collectKatexGlyphs(root: HTMLElement): MathVisualAnchor[] {
  const visualRoot =
    (root.matches('.katex-html') ? root : null) ??
    root.querySelector<HTMLElement>('.katex-html') ??
    root
  const document = root.ownerDocument
  const showText = document.defaultView?.NodeFilter.SHOW_TEXT ?? 4
  const walker = document.createTreeWalker(visualRoot, showText)
  const anchors: MathVisualAnchor[] = []

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType !== 3) continue
    const textNode = node as Text
    const element = textNode.parentElement
    if (!element || isExcludedGlyphHost(element, visualRoot)) continue

    const segments = codePointSegments(textNode.data).filter(
      (segment) => !INVISIBLE_TEXT.test(segment.text)
    )
    if (!segments.length) continue

    const hostRect = readRect(element.getBoundingClientRect())
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
      const segment = segments[segmentIndex]
      const rangeRect = readTextRangeRect(document, textNode, segment.from, segment.to)
      const rect =
        rangeRect && isUsableGlyphRect(rangeRect)
          ? rangeRect
          : hostRect && isUsableGlyphRect(hostRect)
            ? sliceRect(hostRect, segmentIndex, segments.length)
            : null
      if (!rect || !isUsableGlyphRect(rect)) continue

      anchors.push({
        element,
        rect,
        text: segment.text,
        index: anchors.length,
        synthetic: false
      })
    }
  }

  return anchors
}

/**
 * Assign raw-source matches to visible glyphs in source order.
 *
 * When enough glyphs exist, matches receive distinct, monotonically ordered
 * anchors. When that is impossible, labels may share an anchor and receive
 * deterministic collision offsets.
 */
export function assignMathMatchAnchors(
  source: string,
  matches: readonly MathSourceMatch[],
  anchors: readonly MathVisualAnchor[]
): MathMatchPlacement[] {
  const normalizedMatches = normalizeMatches(source, matches)
  if (!normalizedMatches.length || !anchors.length) return []

  const tokens = visualLatexTokens(source)
  const positioned = normalizedMatches.map((match) => ({
    ...match,
    ...sourcePosition(match, source, tokens)
  }))
  const desiredIndices = positioned.map(({ sourceProgress }) =>
    Math.round(sourceProgress * Math.max(0, anchors.length - 1))
  )
  const assignedIndices = chooseAnchorIndices(desiredIndices, anchors.length)

  const placements = positioned.map((match, index) => ({
    ...match,
    anchor: anchors[assignedIndices[index]],
    anchorIndex: assignedIndices[index],
    collisionIndex: 0,
    collisionCount: 1,
    offsetX: 0,
    offsetY: 0
  }))
  return addCollisionMetadata(placements)
}

/**
 * Integration entry point: collect rendered glyphs and place every raw match.
 * If KaTeX exposes no usable leaf geometry, use proportional positions inside
 * the formula rectangle so distinct source matches still get distinct hints.
 */
export function placeMathMatches(
  root: HTMLElement,
  source: string,
  matches: readonly MathSourceMatch[]
): MathMatchPlacement[] {
  const normalizedMatches = normalizeMatches(source, matches)
  if (!normalizedMatches.length) return []

  const glyphs = collectKatexGlyphs(root)
  if (glyphs.length) {
    return assignMathMatchAnchors(source, normalizedMatches, glyphs)
  }

  const tokens = visualLatexTokens(source)
  const positioned = normalizedMatches.map((match) => ({
    ...match,
    ...sourcePosition(match, source, tokens)
  }))
  const rootRect = readRect(root.getBoundingClientRect()) ?? zeroRect()
  const syntheticAnchors = positioned.map((match, index) =>
    proportionalAnchor(root, rootRect, match.sourceProgress, tokens.length, index)
  )

  return positioned.map((match, index) => ({
    ...match,
    anchor: syntheticAnchors[index],
    anchorIndex: index,
    collisionIndex: 0,
    collisionCount: 1,
    offsetX: 0,
    offsetY: 0
  }))
}

/**
 * Keep source tokens that normally correspond to an item in KaTeX's visual
 * stream. Braces, script markers, and whitespace affect layout but do not
 * produce their own glyphs, so counting them would progressively move later
 * anchors away from the pattern they represent.
 */
function visualLatexTokens(source: string): LatexToken[] {
  return tokenizeLatex(source).filter(
    (token) =>
      token.kind !== 'whitespace' &&
      !(
        token.kind === 'character' &&
        (token.text === '{' || token.text === '}' || token.text === '_' || token.text === '^')
      )
  )
}

function sourcePosition(
  match: MathSourceMatch,
  source: string,
  tokens: readonly LatexToken[]
): { sourceProgress: number; sourceTokenIndex: number | null } {
  if (!tokens.length) {
    const midpoint = (match.from + match.to) / 2
    return {
      sourceProgress: source.length ? clamp(midpoint / source.length, 0, 1) : 0.5,
      sourceTokenIndex: null
    }
  }

  const touched: number[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token.from < match.to && token.to > match.from) touched.push(index)
  }

  if (!touched.length) {
    const midpoint = (match.from + match.to) / 2
    const nearest = tokens.reduce(
      (best, token, index) => {
        const tokenMidpoint = (token.from + token.to) / 2
        return Math.abs(tokenMidpoint - midpoint) < best.distance
          ? { index, distance: Math.abs(tokenMidpoint - midpoint) }
          : best
      },
      { index: 0, distance: Infinity }
    )
    const progress = (nearest.index + 0.5) / tokens.length
    return {
      sourceProgress: clamp(progress, 0, 1),
      sourceTokenIndex: nearest.index
    }
  }

  const first = touched[0]
  const last = touched[touched.length - 1]
  const progress = ((first + last) / 2 + 0.5) / tokens.length
  return {
    sourceProgress: clamp(progress, 0, 1),
    sourceTokenIndex: first
  }
}

function chooseAnchorIndices(desiredIndices: readonly number[], anchorCount: number): number[] {
  if (desiredIndices.length > anchorCount) {
    return desiredIndices.map((index) => clamp(index, 0, anchorCount - 1))
  }

  const assigned: number[] = []
  for (let index = 0; index < desiredIndices.length; index++) {
    const minimum = index === 0 ? 0 : assigned[index - 1] + 1
    const maximum = anchorCount - (desiredIndices.length - index)
    assigned.push(clamp(desiredIndices[index], minimum, maximum))
  }
  return assigned
}

function addCollisionMetadata(placements: readonly MathMatchPlacement[]): MathMatchPlacement[] {
  const groups = new Map<number, number[]>()
  placements.forEach((placement, index) => {
    const group = groups.get(placement.anchorIndex) ?? []
    group.push(index)
    groups.set(placement.anchorIndex, group)
  })

  const result = placements.map((placement) => ({ ...placement }))
  for (const indices of groups.values()) {
    indices.forEach((placementIndex, collisionIndex) => {
      const placement = result[placementIndex]
      const slot = collisionOffsetSlot(collisionIndex)
      const step = clamp(placement.anchor.rect.width, 8, 14)
      placement.collisionIndex = collisionIndex
      placement.collisionCount = indices.length
      placement.offsetX = slot * step
      placement.offsetY = Math.abs(slot) > 1 ? -Math.ceil((Math.abs(slot) - 1) / 2) * 4 : 0
    })
  }
  return result
}

function proportionalAnchor(
  root: HTMLElement,
  rootRect: MathVisualRect,
  progress: number,
  tokenCount: number,
  index: number
): MathVisualAnchor {
  // Retain usable geometry in production while still returning deterministic
  // 1px geometry in non-layout DOMs used by tests.
  const width = Math.max(1, rootRect.width)
  const height = Math.max(1, rootRect.height)
  const glyphWidth = Math.max(1, Math.min(width, width / Math.max(1, tokenCount)))
  const center = rootRect.left + clamp(progress, 0, 1) * width
  const left = clamp(center - glyphWidth / 2, rootRect.left, rootRect.left + width - glyphWidth)
  const rect: MathVisualRect = {
    left,
    top: rootRect.top,
    right: left + glyphWidth,
    bottom: rootRect.top + height,
    width: glyphWidth,
    height
  }
  return {
    element: root,
    rect,
    text: '',
    index,
    synthetic: true
  }
}

function normalizeMatches(source: string, matches: readonly MathSourceMatch[]): MathSourceMatch[] {
  const unique = new Map<string, MathSourceMatch>()
  for (const match of matches) {
    if (!Number.isFinite(match.from) || !Number.isFinite(match.to)) continue
    const from = clamp(Math.trunc(match.from), 0, source.length)
    const to = clamp(Math.trunc(match.to), 0, source.length)
    if (from >= to) continue
    unique.set(`${from}:${to}`, { from, to })
  }
  return [...unique.values()].sort((left, right) => left.from - right.from || left.to - right.to)
}

function isExcludedGlyphHost(element: HTMLElement, visualRoot: HTMLElement): boolean {
  const excluded = element.closest<HTMLElement>(NON_GLYPH_SELECTOR)
  if (excluded && visualRoot.contains(excluded)) return true

  const view = element.ownerDocument.defaultView
  if (!view) return false
  const style = view.getComputedStyle(element)
  return style.display === 'none' || style.visibility === 'hidden'
}

function codePointSegments(text: string): Array<{ text: string; from: number; to: number }> {
  const result: Array<{ text: string; from: number; to: number }> = []
  let offset = 0
  for (const character of text) {
    result.push({
      text: character,
      from: offset,
      to: offset + character.length
    })
    offset += character.length
  }
  return result
}

function readTextRangeRect(
  document: Document,
  node: Text,
  from: number,
  to: number
): MathVisualRect | null {
  try {
    const range = document.createRange()
    range.setStart(node, from)
    range.setEnd(node, to)
    const getBoundingClientRect = (range as Range & { getBoundingClientRect?: () => DOMRect })
      .getBoundingClientRect
    return typeof getBoundingClientRect === 'function'
      ? readRect(getBoundingClientRect.call(range))
      : null
  } catch {
    return null
  }
}

function sliceRect(rect: MathVisualRect, index: number, count: number): MathVisualRect {
  const width = rect.width / count
  const left = rect.left + width * index
  return {
    left,
    top: rect.top,
    right: left + width,
    bottom: rect.bottom,
    width,
    height: rect.height
  }
}

function readRect(rect: DOMRect | DOMRectReadOnly): MathVisualRect | null {
  const values = [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height]
  if (!values.every(Number.isFinite)) return null
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  }
}

function isUsableGlyphRect(rect: MathVisualRect): boolean {
  return rect.width > 0 && rect.height > 0
}

function zeroRect(): MathVisualRect {
  return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
}

function collisionOffsetSlot(index: number): number {
  if (index === 0) return 0
  const distance = Math.ceil(index / 2)
  return index % 2 === 1 ? distance : -distance
}

function codePointLengthAt(value: string, offset: number): number {
  return (value.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
