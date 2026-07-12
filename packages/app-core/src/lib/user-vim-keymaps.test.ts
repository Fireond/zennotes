import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const vimMock = vi.hoisted(() => ({
  defineAction: vi.fn(),
  map: vi.fn(),
  noremap: vi.fn(),
  mapCommand: vi.fn(),
  unmap: vi.fn()
}))

vi.mock('@replit/codemirror-vim', () => ({ Vim: vimMock }))

import {
  applyUserVimMappings,
  clearUserVimMappings,
  getUserVimMappings,
  getUserVimSequenceMatch,
  sequenceTokenToVimNotation,
  userVimMappingsOwnPrefix,
  type UserVimMappingRegistration
} from './user-vim-keymaps'

describe('user Vim keymap manager', () => {
  beforeEach(() => {
    clearUserVimMappings()
    vi.clearAllMocks()
  })

  afterEach(() => {
    clearUserVimMappings()
  })

  it('installs non-recursive key mappings in every supported mode', () => {
    const mappings: UserVimMappingRegistration[] = [
      { mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^' } },
      { mode: 'v', lhs: 'L', target: { type: 'keys', keys: '$' } },
      { mode: 'i', lhs: 'jk', target: { type: 'keys', keys: '<Esc>' } },
      { mode: 'o', lhs: 'H', target: { type: 'keys', keys: '^' } }
    ]

    applyUserVimMappings(mappings, { runCommand: vi.fn() })

    expect(vimMock.noremap.mock.calls).toEqual([
      ['H', '^', 'normal'],
      ['L', '$', 'visual'],
      ['jk', '<Esc>', 'insert'],
      ['H', '^', 'operatorPending']
    ])
    expect(vimMock.map).not.toHaveBeenCalled()
  })

  it('uses recursive mapping only when explicitly requested', () => {
    applyUserVimMappings(
      [{ mode: 'n', lhs: 'H', target: { type: 'keys', keys: 'L', recursive: true } }],
      { runCommand: vi.fn() }
    )

    expect(vimMock.map).toHaveBeenCalledWith('H', 'L', 'normal')
    expect(vimMock.noremap).not.toHaveBeenCalled()
  })

  it('maps command and disabled targets to private Vim actions', () => {
    applyUserVimMappings(
      [
        { mode: 'n', lhs: '<C-w>', target: { type: 'command', commandId: 'tab.close' } },
        { mode: 'n', lhs: 'Q', target: { type: 'disabled' } }
      ],
      { runCommand: vi.fn() }
    )

    expect(vimMock.mapCommand).toHaveBeenCalledTimes(2)
    expect(vimMock.mapCommand.mock.calls[0]?.slice(0, 3)).toEqual([
      '<C-w>',
      'action',
      'zenUserVimCommand'
    ])
    expect(vimMock.mapCommand.mock.calls[1]?.slice(0, 3)).toEqual([
      'Q',
      'action',
      'zenUserVimDisabled'
    ])
  })

  it('dispatches a mapped command through the current runtime', async () => {
    const runCommand = vi.fn()
    applyUserVimMappings(
      [{ mode: 'v', lhs: '<leader>u', target: { type: 'command', commandId: 'user.upper' } }],
      { runCommand }
    )
    const action = vimMock.defineAction.mock.calls.find(
      ([name]) => name === 'zenUserVimCommand'
    )?.[1] as ((cm: unknown, args: unknown) => void) | undefined
    const actionArgs = vimMock.mapCommand.mock.calls[0]?.[3]

    action?.({ editor: true }, actionArgs)
    await Promise.resolve()

    expect(runCommand).toHaveBeenCalledWith({
      commandId: 'user.upper',
      mode: 'v',
      lhs: '<leader>u',
      count: null,
      register: null,
      cm: { editor: true }
    })
  })

  it('removes the old generation before applying a reload', () => {
    applyUserVimMappings(
      [
        { mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^' } },
        { mode: 'v', lhs: 'L', target: { type: 'keys', keys: '$' } }
      ],
      { runCommand: vi.fn() }
    )
    vi.clearAllMocks()

    applyUserVimMappings(
      [{ mode: 'n', lhs: 'J', target: { type: 'keys', keys: '5j' } }],
      { runCommand: vi.fn() }
    )

    expect(vimMock.unmap.mock.calls).toEqual([
      ['H', 'normal'],
      ['L', 'visual']
    ])
    expect(vimMock.noremap).toHaveBeenCalledOnce()
    expect(vimMock.noremap).toHaveBeenCalledWith('J', '5j', 'normal')
    expect(getUserVimMappings()).toEqual([
      { mode: 'n', lhs: 'J', target: { type: 'keys', keys: '5j', recursive: false } }
    ])
  })

  it('validates the whole next generation before removing live mappings', () => {
    applyUserVimMappings(
      [{ mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^' } }],
      { runCommand: vi.fn() }
    )
    vi.clearAllMocks()

    expect(() =>
      applyUserVimMappings(
        [{ mode: 'n', lhs: 'L', target: { type: 'command', commandId: '' } }],
        { runCommand: vi.fn() }
      )
    ).toThrow('command ID must not be empty')
    expect(vimMock.unmap).not.toHaveBeenCalled()
    expect(getUserVimMappings()[0]).toMatchObject({ mode: 'n', lhs: 'H' })
  })

  it('rolls back to the previous generation when installation fails', () => {
    applyUserVimMappings(
      [{ mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^' } }],
      { runCommand: vi.fn() }
    )
    vi.clearAllMocks()
    vimMock.noremap
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('invalid mapping')
      })
      .mockImplementationOnce(() => undefined)

    expect(() =>
      applyUserVimMappings(
        [
          { mode: 'n', lhs: 'J', target: { type: 'keys', keys: '5j' } },
          { mode: 'n', lhs: 'K', target: { type: 'keys', keys: '5k' } }
        ],
        { runCommand: vi.fn() }
      )
    ).toThrow('invalid mapping')

    expect(vimMock.unmap.mock.calls).toEqual([
      ['H', 'normal'],
      ['J', 'normal']
    ])
    expect(vimMock.noremap).toHaveBeenLastCalledWith('H', '^', 'normal')
    expect(getUserVimMappings()[0]).toMatchObject({ mode: 'n', lhs: 'H' })
  })

  it('lets the last duplicate mode/lhs declaration win', () => {
    applyUserVimMappings(
      [
        { mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^' } },
        { mode: 'n', lhs: 'H', target: { type: 'keys', keys: '$' } }
      ],
      { runCommand: vi.fn() }
    )

    expect(vimMock.noremap).toHaveBeenCalledOnce()
    expect(vimMock.noremap).toHaveBeenCalledWith('H', '$', 'normal')
  })

  it('reports exact and partial user-owned sequences token by token', () => {
    applyUserVimMappings(
      [
        { mode: 'n', lhs: '<C-w>', target: { type: 'command', commandId: 'tab.close' } },
        { mode: 'n', lhs: '<C-w>v', target: { type: 'command', commandId: 'pane.split' } },
        { mode: 'v', lhs: '<Leader>u', target: { type: 'command', commandId: 'user.upper' } }
      ],
      { runCommand: vi.fn() }
    )

    expect(getUserVimSequenceMatch('n', '<c-W>')).toBe('exact-prefix')
    expect(getUserVimSequenceMatch('n', '<C-w>v')).toBe('exact')
    expect(getUserVimSequenceMatch('n', '<C-w>x')).toBe('none')
    expect(getUserVimSequenceMatch('v', '<leader>')).toBe('prefix')
    expect(userVimMappingsOwnPrefix('v', '<LEADER>')).toBe(true)
    expect(userVimMappingsOwnPrefix('n', 'H')).toBe(false)
  })

  it('converts portable sequence tokens to CodeMirror-Vim notation', () => {
    expect(sequenceTokenToVimNotation('Ctrl+W')).toBe('<C-w>')
    expect(sequenceTokenToVimNotation('Space')).toBe('<Space>')
    expect(sequenceTokenToVimNotation('ArrowLeft')).toBe('<Left>')
    expect(sequenceTokenToVimNotation('H')).toBe('H')
    expect(sequenceTokenToVimNotation('Meta+W')).toBe('<M-w>')
  })

  it('translates Neovim D notation to codemirror-vim Meta notation', () => {
    applyUserVimMappings(
      [{ mode: 'n', lhs: '<D-w>', target: { type: 'keys', keys: '<D-l>' } }],
      { runCommand: vi.fn() }
    )

    expect(vimMock.noremap).toHaveBeenCalledWith('<M-w>', '<M-l>', 'normal')
  })
})
