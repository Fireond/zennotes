/**
 * Home-row-first labels used by Flash jump targets.
 *
 * Labels are deliberately limited to one character. That keeps the input
 * state unambiguous: a printable key either extends the query or selects a
 * visible target.
 */
export const FLASH_LABEL_ALPHABET = 'asdfghjklqwertyuiopzxcvbnm'

/** A UTF-16 document range, with an inclusive start and exclusive end. */
export interface FlashSearchRange {
  from: number
  to: number
}

/** A literal query match, expressed using UTF-16 document offsets. */
export interface FlashMatch {
  from: number
  to: number
}

/** A match that can be selected with a single-character label. */
export interface FlashTarget extends FlashMatch {
  label: string
}

/**
 * Find every literal, case-insensitive query match contained by the supplied
 * ranges. Overlapping matches are included; overlapping ranges do not create
 * duplicate results.
 *
 * Matching uses ECMAScript's Unicode-aware simple case folding. Searching the
 * original string (instead of a lower-cased copy) is important here: Unicode
 * case conversion can change a string's UTF-16 length, while CodeMirror needs
 * every returned offset to refer directly to the original document.
 */
export function findFlashMatches(
  text: string,
  query: string,
  ranges: readonly FlashSearchRange[]
): FlashMatch[] {
  if (!query || !ranges.length) return []

  const matches = new Map<number, number>()
  const matcher = new RegExp(escapeRegExp(query), 'giu')
  for (const range of ranges) {
    const from = clampOffset(range.from, text.length)
    const to = clampOffset(range.to, text.length)
    if (from >= to) continue

    matcher.lastIndex = from
    let match: RegExpExecArray | null
    while ((match = matcher.exec(text))) {
      const matchFrom = match.index
      const matchTo = matchFrom + match[0].length

      // A Unicode regular expression may align lastIndex from the middle of a
      // surrogate pair back to the pair's start. Do not let that escape a
      // search range whose boundary happens to split the pair.
      const nextOffset = matchFrom + codePointLengthAt(text, matchFrom)
      matcher.lastIndex = nextOffset

      if (matchFrom < from) continue
      if (matchFrom >= to) break
      if (matchTo <= to) matches.set(matchFrom, matchTo)
    }
  }

  return [...matches]
    .sort(([left], [right]) => left - right)
    .map(([from, to]) => ({ from, to }))
}

/**
 * Assign collision-free labels to matches, nearest to the cursor first.
 *
 * Any label character found immediately after a current match is withheld:
 * typing that character must refine the query instead of prematurely jumping.
 * Labels from the previous query refinement are retained when they remain
 * available and unique.
 */
export function assignFlashLabels(
  text: string,
  matches: readonly FlashMatch[],
  cursor: number,
  previousLabels: ReadonlyMap<number, string> = new Map(),
  additionalContinuationCharacters: Iterable<string> = []
): FlashTarget[] {
  if (!matches.length) return []

  // Some visible targets are backed by replacement widgets rather than a
  // literal document span. Their searchable representation can contribute
  // continuation characters even though it has no direct source offset.
  const continuationCharacters = new Set(additionalContinuationCharacters)
  for (const match of matches) {
    if (match.to < text.length) {
      continuationCharacters.add(
        String.fromCodePoint(text.codePointAt(match.to) ?? 0)
      )
    }
  }

  const availableLabels = [...FLASH_LABEL_ALPHABET].filter(
    (label) =>
      ![...continuationCharacters].some((character) =>
        equalsIgnoringCase(character, label)
      )
  )
  if (!availableLabels.length) return []

  const prioritizedMatches = uniqueMatches(matches).sort((left, right) => {
    const distance =
      Math.abs(left.from - cursor) - Math.abs(right.from - cursor)
    return distance || left.from - right.from || left.to - right.to
  })

  const allowedLabels = new Set(availableLabels)
  const usedLabels = new Set<string>()
  const assignedLabels = new Map<number, string>()

  // Preserve stable labels before allocating new ones. Processing in distance
  // order resolves malformed duplicate prior labels in favor of the closest
  // target while still guaranteeing that every visible label is unique.
  for (const match of prioritizedMatches) {
    const label = previousLabels.get(match.from)
    if (!label || !allowedLabels.has(label) || usedLabels.has(label)) continue
    assignedLabels.set(match.from, label)
    usedLabels.add(label)
  }

  let nextLabelIndex = 0
  for (const match of prioritizedMatches) {
    if (assignedLabels.has(match.from)) continue
    while (
      nextLabelIndex < availableLabels.length &&
      usedLabels.has(availableLabels[nextLabelIndex])
    ) {
      nextLabelIndex += 1
    }
    const label = availableLabels[nextLabelIndex]
    if (!label) break
    assignedLabels.set(match.from, label)
    usedLabels.add(label)
    nextLabelIndex += 1
  }

  return prioritizedMatches.flatMap((match) => {
    const label = assignedLabels.get(match.from)
    return label ? [{ ...match, label }] : []
  })
}

/** Find and label Flash targets in one call. */
export function buildFlashTargets(
  text: string,
  query: string,
  ranges: readonly FlashSearchRange[],
  cursor: number,
  previousLabels: ReadonlyMap<number, string> = new Map()
): FlashTarget[] {
  return assignFlashLabels(
    text,
    findFlashMatches(text, query, ranges),
    cursor,
    previousLabels
  )
}

function clampOffset(value: number, length: number): number {
  if (!Number.isFinite(value)) return value === Infinity ? length : 0
  return Math.max(0, Math.min(length, Math.trunc(value)))
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function codePointLengthAt(value: string, offset: number): number {
  return (value.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1
}

function equalsIgnoringCase(left: string, right: string): boolean {
  return new RegExp(`^(?:${escapeRegExp(left)})$`, 'iu').test(right)
}

function uniqueMatches(matches: readonly FlashMatch[]): FlashMatch[] {
  const seen = new Set<number>()
  const result: FlashMatch[] = []
  for (const match of matches) {
    if (seen.has(match.from)) continue
    seen.add(match.from)
    result.push(match)
  }
  return result
}
