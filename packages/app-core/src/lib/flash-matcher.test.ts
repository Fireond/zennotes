import { describe, expect, it } from 'vitest'
import {
  FLASH_LABEL_ALPHABET,
  assignFlashLabels,
  buildFlashTargets,
  findFlashMatches
} from './flash-matcher'

describe('findFlashMatches', () => {
  it('matches a literal query case-insensitively and includes overlaps', () => {
    expect(findFlashMatches('AaAaA', 'AaA', [{ from: 0, to: 5 }])).toEqual([
      { from: 0, to: 3 },
      { from: 1, to: 4 },
      { from: 2, to: 5 }
    ])
    expect(
      findFlashMatches('ABC abc AbC', 'abc', [{ from: 0, to: 11 }])
    ).toEqual([
      { from: 0, to: 3 },
      { from: 4, to: 7 },
      { from: 8, to: 11 }
    ])
  })

  it('treats regular-expression syntax in the query as literal text', () => {
    const text = 'A.C a-c a.c [ABC]'

    expect(
      findFlashMatches(text, 'a.c', [{ from: 0, to: text.length }])
    ).toEqual([
      { from: 0, to: 3 },
      { from: 8, to: 11 }
    ])
    expect(
      findFlashMatches(text, '[abc]', [{ from: 0, to: text.length }])
    ).toEqual([{ from: 12, to: 17 }])
  })

  it('refines a multi-character query to the remaining matches', () => {
    const text = 'alpha alpine alphabet alps'
    const ranges = [{ from: 0, to: text.length }]

    expect(
      findFlashMatches(text, 'al', ranges).map((match) => match.from)
    ).toEqual([0, 6, 13, 22])
    expect(
      findFlashMatches(text, 'alp', ranges).map((match) => match.from)
    ).toEqual([0, 6, 13, 22])
    expect(
      findFlashMatches(text, 'alph', ranges).map((match) => match.from)
    ).toEqual([0, 13])
  })

  it('only includes matches fully contained by provided ranges', () => {
    const text = 'one cat two cat three cat'

    expect(
      findFlashMatches(text, 'cat', [
        { from: 4, to: 7 },
        { from: 10, to: 17 },
        { from: 0, to: 12 }
      ])
    ).toEqual([
      { from: 4, to: 7 },
      { from: 12, to: 15 }
    ])
  })

  it('returns no matches for an empty query, empty ranges, or absent text', () => {
    expect(findFlashMatches('alpha', '', [{ from: 0, to: 5 }])).toEqual([])
    expect(findFlashMatches('alpha', 'a', [])).toEqual([])
    expect(findFlashMatches('alpha', 'z', [{ from: 0, to: 5 }])).toEqual([])
  })

  it('reports Unicode matches using CodeMirror-compatible UTF-16 offsets', () => {
    const text = 'a🚀B 🚀b'

    expect(
      findFlashMatches(text, '🚀b', [{ from: 0, to: text.length }])
    ).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 8 }
    ])
  })

  it('uses Unicode-aware simple case folding without changing offsets', () => {
    const text = 'ſS SS Kk kk'

    expect(
      findFlashMatches(text, 'ss', [{ from: 0, to: text.length }])
    ).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 }
    ])
    expect(
      findFlashMatches(text, 'kk', [{ from: 0, to: text.length }])
    ).toEqual([
      { from: 6, to: 8 },
      { from: 9, to: 11 }
    ])
  })

  it('does not let a range boundary inside a surrogate pair escape the range', () => {
    const text = 'a🚀b 🚀b'

    expect(findFlashMatches(text, '🚀b', [{ from: 2, to: 8 }])).toEqual([
      { from: 5, to: 8 }
    ])
  })
})

describe('assignFlashLabels', () => {
  it('excludes every character that could continue the current query', () => {
    const text = 'aB aC aD aZ aſ'
    const matches = findFlashMatches(text, 'a', [{ from: 0, to: text.length }])
    const targets = assignFlashLabels(text, matches, 0)
    const labels = targets.map((target) => target.label)

    expect(labels).not.toContain('b')
    expect(labels).not.toContain('c')
    expect(labels).not.toContain('d')
    expect(labels).not.toContain('z')
    expect(labels).not.toContain('s')
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('prioritizes targets by cursor distance', () => {
    const text = 'x---x---x---x'
    const matches = findFlashMatches(text, 'x', [{ from: 0, to: text.length }])

    expect(assignFlashLabels(text, matches, 9)).toEqual([
      { from: 8, to: 9, label: 'a' },
      { from: 12, to: 13, label: 's' },
      { from: 4, to: 5, label: 'd' },
      { from: 0, to: 1, label: 'f' }
    ])
  })

  it('preserves valid position-to-label assignments after refinement', () => {
    const text = 'alpha alpine alphabet alps'
    const ranges = [{ from: 0, to: text.length }]
    const initial = buildFlashTargets(text, 'alp', ranges, 9)
    const previousLabels = new Map(
      initial.map((target) => [target.from, target.label] as const)
    )
    const refined = buildFlashTargets(text, 'alph', ranges, 9, previousLabels)

    expect(refined).toEqual([
      { from: 13, to: 17, label: previousLabels.get(13) },
      { from: 0, to: 4, label: previousLabels.get(0) }
    ])
  })

  it('drops prior labels that become query-continuation collisions', () => {
    const text = 'ax ay'
    const matches = findFlashMatches(text, 'a', [{ from: 0, to: text.length }])

    expect(assignFlashLabels(text, matches, 0, new Map([[0, 'x']]))).toEqual([
      { from: 0, to: 1, label: 'a' },
      { from: 3, to: 4, label: 's' }
    ])
  })

  it('withholds continuation characters supplied by virtual targets', () => {
    const text = 'x x'
    const matches = findFlashMatches(text, 'x', [{ from: 0, to: text.length }])
    const labels = assignFlashLabels(text, matches, 0, new Map(), [
      'A',
      'ſ'
    ]).map((target) => target.label)

    expect(labels).not.toContain('a')
    expect(labels).not.toContain('s')
  })

  it('uses only the single-character Flash label alphabet', () => {
    const text = Array.from(
      { length: FLASH_LABEL_ALPHABET.length + 4 },
      () => 'x'
    ).join(' ')
    const targets = buildFlashTargets(
      text,
      'x',
      [{ from: 0, to: text.length }],
      0
    )

    expect(targets).toHaveLength(FLASH_LABEL_ALPHABET.length)
    expect(targets.every((target) => target.label.length === 1)).toBe(true)
    expect(new Set(targets.map((target) => target.label)).size).toBe(
      targets.length
    )
  })
})
