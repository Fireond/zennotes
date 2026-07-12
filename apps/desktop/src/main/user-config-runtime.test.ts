import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { UserCommandContext } from '@zennotes/bridge-contract/user-config'
import { loadUserConfig, normalizeUserCommandResult } from './user-config-runtime'

const tempDirs: string[] = []

async function tempConfig(source?: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zennotes-user-config-'))
  tempDirs.push(dir)
  const configPath = path.join(dir, 'init.mjs')
  if (source !== undefined) await fs.writeFile(configPath, source, 'utf8')
  return configPath
}

function context(text = 'abc'): UserCommandContext {
  return {
    path: 'inbox/example.md',
    text,
    version: 7,
    selections: [{ from: 0, to: text.length }],
    cursor: { offset: text.length, line: 1, column: text.length },
    vim: { mode: 'v', count: null, register: null }
  }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('user config runtime', () => {
  it('treats a missing init.mjs as an empty successful config', async () => {
    const runtime = await loadUserConfig(await tempConfig())

    expect(runtime.mappings).toEqual([])
    expect(runtime.commands).toEqual([])
  })

  it('collects key, command, and disabled mappings using mode aliases', async () => {
    const configPath = await tempConfig(`
      export default function setup(zen) {
        zen.keymap.set('normal', 'H', '^', { noremap: true })
        zen.keymap.set('n', 'L', zen.keys('$'))
        zen.keymap.set('n', '<C-w>', zen.command('tab.close'))
        zen.keymap.set('visual', 'Q', null)
        zen.keymap.disable('operatorPending', 'Z')
        zen.keymap.set('n', 'X', 'dd')
        zen.keymap.del('n', 'X')
      }
    `)

    const runtime = await loadUserConfig(configPath)

    expect(runtime.mappings).toEqual([
      { mode: 'n', lhs: 'H', target: { type: 'keys', keys: '^', recursive: false } },
      { mode: 'n', lhs: 'L', target: { type: 'keys', keys: '$', recursive: false } },
      { mode: 'n', lhs: '<C-w>', target: { type: 'command', commandId: 'tab.close' } },
      { mode: 'v', lhs: 'Q', target: { type: 'disabled' } },
      { mode: 'o', lhs: 'Z', target: { type: 'disabled' } }
    ])
  })

  it('runs a registered visual selection transform declaratively', async () => {
    const configPath = await tempConfig(`
      export default function setup(zen) {
        zen.commands.registerTransform({
          id: 'user.uppercase-selection',
          title: 'Uppercase selection',
          run(text) { return text.toUpperCase() }
        })
        zen.keymap.set('v', '<leader>u', zen.command('user.uppercase-selection'))
      }
    `)

    const runtime = await loadUserConfig(configPath)

    expect(runtime.commands).toEqual([
      { id: 'user.uppercase-selection', title: 'Uppercase selection' }
    ])
    await expect(runtime.invoke('user.uppercase-selection', context())).resolves.toEqual({
      edits: [{ from: 0, to: 3, insert: 'ABC' }],
      selection: 'preserve'
    })
  })

  it('gives commands a frozen buffer snapshot', async () => {
    const configPath = await tempConfig(`
      export default function setup(zen) {
        zen.commands.register({
          id: 'user.inspect-context',
          run(context) {
            return {
              message: String(
                Object.isFrozen(context) &&
                Object.isFrozen(context.selections) &&
                Object.isFrozen(context.selections[0]) &&
                Object.isFrozen(context.cursor) &&
                Object.isFrozen(context.vim)
              )
            }
          }
        })
      }
    `)

    const runtime = await loadUserConfig(configPath)

    await expect(runtime.invoke('user.inspect-context', context())).resolves.toEqual({
      message: 'true'
    })
  })

  it('rejects malformed command results before they cross the process boundary', () => {
    expect(() => normalizeUserCommandResult({ edits: [{ from: 0, to: 1, insert: 42 }] }))
      .toThrow('insert must be a string')
    expect(() =>
      normalizeUserCommandResult({
        edits: Array.from({ length: 1_001 }, (_, from) => ({ from, to: from, insert: '' }))
      })
    ).toThrow('too many edits')
  })

  it('reports setup errors rather than publishing a partial config', async () => {
    const configPath = await tempConfig(`
      export default function setup(zen) {
        zen.keymap.set('n', 'H', '^')
        zen.commands.register({ id: 'bad-id', run() {} })
      }
    `)

    await expect(loadUserConfig(configPath)).rejects.toThrow('must start with "user."')
  })

  it('rejects invalid recursive options before publishing a config', async () => {
    const configPath = await tempConfig(`
      export default function setup(zen) {
        zen.keymap.set('n', 'H', '^', { recursive: 'yes' })
      }
    `)

    await expect(loadUserConfig(configPath)).rejects.toThrow('recursive must be a boolean')
  })
})
