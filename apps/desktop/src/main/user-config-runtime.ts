import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type {
  UserCommandContext,
  UserCommandDefinition,
  UserCommandDescriptor,
  UserCommandResult,
  UserConfigApi,
  UserKeyTargetOptions,
  UserTransformDefinition,
  UserVimMapping,
  UserVimMappingTarget,
  UserVimMode,
  UserVimModeInput
} from '@zennotes/bridge-contract/user-config'
import { USER_COMMAND_RESULT_LIMITS } from '@zennotes/bridge-contract/user-config'

export interface LoadedUserConfig {
  mappings: UserVimMapping[]
  commands: UserCommandDescriptor[]
  invoke(id: string, context: UserCommandContext): Promise<UserCommandResult | null>
}

const MODE_ALIASES: Record<UserVimModeInput, UserVimMode> = {
  n: 'n',
  normal: 'n',
  v: 'v',
  visual: 'v',
  i: 'i',
  insert: 'i',
  o: 'o',
  operatorPending: 'o'
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`)
  }
  return value.trim()
}

function normalizeMode(value: UserVimModeInput): UserVimMode {
  const mode = MODE_ALIASES[value]
  if (!mode) {
    throw new Error(`Unsupported Vim mode "${String(value)}". Use n, v, i, or o.`)
  }
  return mode
}

function mappingKey(mode: UserVimMode, lhs: string): string {
  return `${mode}\u0000${lhs}`
}

function immutableCommandContext(context: UserCommandContext): UserCommandContext {
  const selections = Object.freeze(
    context.selections.map((selection) => Object.freeze({ ...selection }))
  )
  return Object.freeze({
    ...context,
    selections: selections as UserCommandContext['selections'],
    cursor: Object.freeze({ ...context.cursor }),
    vim: Object.freeze({ ...context.vim })
  })
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer.`)
  }
  return value as number
}

/** Keep only the declarative, structured-clone-safe result surface. */
export function normalizeUserCommandResult(value: unknown): UserCommandResult | null {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A user command must return an object, null, or undefined.')
  }

  const raw = value as Record<string, unknown>
  const result: UserCommandResult = {}

  if (raw.edits !== undefined) {
    if (!Array.isArray(raw.edits)) throw new Error('Command result edits must be an array.')
    if (raw.edits.length > USER_COMMAND_RESULT_LIMITS.maxEdits) {
      throw new Error(
        `Command result has too many edits (maximum ${USER_COMMAND_RESULT_LIMITS.maxEdits}).`
      )
    }
    let insertedTextLength = 0
    result.edits = raw.edits.map((edit, index) => {
      if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
        throw new Error(`Command result edit ${index} must be an object.`)
      }
      const item = edit as Record<string, unknown>
      if (typeof item.insert !== 'string') {
        throw new Error(`Command result edit ${index}.insert must be a string.`)
      }
      insertedTextLength += item.insert.length
      if (insertedTextLength > USER_COMMAND_RESULT_LIMITS.maxInsertedTextLength) {
        throw new Error(
          `Command result inserted text exceeds ${USER_COMMAND_RESULT_LIMITS.maxInsertedTextLength} characters.`
        )
      }
      return {
        from: integer(item.from, `Command result edit ${index}.from`),
        to: integer(item.to, `Command result edit ${index}.to`),
        insert: item.insert
      }
    })
  }

  if (raw.selection !== undefined) {
    if (raw.selection === 'preserve') {
      result.selection = 'preserve'
    } else {
      if (!raw.selection || typeof raw.selection !== 'object' || Array.isArray(raw.selection)) {
        throw new Error('Command result selection must be "preserve" or an object.')
      }
      const selection = raw.selection as Record<string, unknown>
      result.selection = {
        anchor: integer(selection.anchor, 'Command result selection.anchor'),
        ...(selection.head === undefined
          ? {}
          : { head: integer(selection.head, 'Command result selection.head') })
      }
    }
  }

  if (raw.message !== undefined) {
    if (typeof raw.message !== 'string') {
      throw new Error('Command result message must be a string.')
    }
    if (raw.message.length > USER_COMMAND_RESULT_LIMITS.maxMessageLength) {
      throw new Error(
        `Command result message exceeds ${USER_COMMAND_RESULT_LIMITS.maxMessageLength} characters.`
      )
    }
    result.message = raw.message
  }

  return result
}

function createRuntime(): {
  api: UserConfigApi
  finish(): LoadedUserConfig
} {
  const mappings = new Map<string, UserVimMapping>()
  const handlers = new Map<string, UserCommandDefinition['run']>()
  const descriptors = new Map<string, UserCommandDescriptor>()
  let acceptingRegistrations = true

  const assertRegistering = (): void => {
    if (!acceptingRegistrations) {
      throw new Error('Registrations must happen before the init.mjs setup function resolves.')
    }
  }

  const addMapping = (
    rawMode: UserVimModeInput,
    rawLhs: string,
    target: UserVimMappingTarget
  ): void => {
    assertRegistering()
    const mode = normalizeMode(rawMode)
    const lhs = nonEmptyString(rawLhs, 'Mapping lhs')
    mappings.set(mappingKey(mode, lhs), { mode, lhs, target })
  }

  const recursiveOption = (options: UserKeyTargetOptions, fallback = false): boolean => {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Mapping options must be an object.')
    }
    if (options.recursive !== undefined && typeof options.recursive !== 'boolean') {
      throw new Error('Mapping option recursive must be a boolean.')
    }
    if (options.noremap !== undefined && typeof options.noremap !== 'boolean') {
      throw new Error('Mapping option noremap must be a boolean.')
    }
    if (
      options.recursive !== undefined &&
      options.noremap !== undefined &&
      options.recursive === options.noremap
    ) {
      throw new Error('Mapping options recursive and noremap contradict each other.')
    }
    if (options.recursive !== undefined) return options.recursive
    if (options.noremap !== undefined) return !options.noremap
    return fallback
  }

  const register = (definition: UserCommandDefinition): void => {
    assertRegistering()
    if (!definition || typeof definition !== 'object') {
      throw new Error('Command definition must be an object.')
    }
    const id = nonEmptyString(definition.id, 'Command id')
    if (!id.startsWith('user.')) {
      throw new Error(`User command id "${id}" must start with "user.".`)
    }
    if (typeof definition.run !== 'function') {
      throw new Error(`User command "${id}" must provide a run function.`)
    }
    if (handlers.has(id)) throw new Error(`User command "${id}" is already registered.`)
    const title = definition.title == null ? id : nonEmptyString(definition.title, 'Command title')
    handlers.set(id, definition.run)
    descriptors.set(id, { id, title })
  }

  const api: UserConfigApi = {
    keys: (keys) => ({
      type: 'keys',
      keys: nonEmptyString(keys, 'Mapped keys'),
      recursive: false
    }),
    command: (commandId) => ({
      type: 'command',
      commandId: nonEmptyString(commandId, 'Command id')
    }),
    keymap: {
      set: (mode, lhs, rawTarget, options = {}) => {
        let target: UserVimMappingTarget
        if (rawTarget === null) {
          target = { type: 'disabled' }
        } else if (typeof rawTarget === 'string') {
          target = {
            type: 'keys',
            keys: nonEmptyString(rawTarget, 'Mapped keys'),
            recursive: recursiveOption(options)
          }
        } else if (rawTarget?.type === 'keys') {
          if (
            rawTarget.recursive !== undefined &&
            typeof rawTarget.recursive !== 'boolean'
          ) {
            throw new Error('zen.keys() target recursive must be a boolean.')
          }
          target = {
            type: 'keys',
            keys: nonEmptyString(rawTarget.keys, 'Mapped keys'),
            recursive: recursiveOption(options, rawTarget.recursive === true)
          }
        } else if (rawTarget?.type === 'command') {
          target = {
            type: 'command',
            commandId: nonEmptyString(rawTarget.commandId, 'Command id')
          }
        } else {
          throw new Error('Mapping target must be a key string, zen.keys(), or zen.command().')
        }
        addMapping(mode, lhs, target)
      },
      disable: (mode, lhs) => addMapping(mode, lhs, { type: 'disabled' }),
      del: (rawMode, rawLhs) => {
        assertRegistering()
        const mode = normalizeMode(rawMode)
        const lhs = nonEmptyString(rawLhs, 'Mapping lhs')
        mappings.delete(mappingKey(mode, lhs))
      }
    },
    commands: {
      register,
      registerTransform: (definition) => {
        if (!definition || typeof definition.run !== 'function') {
          throw new Error('Transform definition must provide a run function.')
        }
        register({
          id: definition.id,
          title: definition.title,
          run: async (context) => {
            const edits = []
            for (const selection of context.selections) {
              if (selection.from === selection.to) continue
              const selectedText = context.text.slice(selection.from, selection.to)
              const insert = await definition.run(selectedText, context)
              if (typeof insert !== 'string') {
                throw new Error(`Transform "${definition.id}" must return a string.`)
              }
              edits.push({ from: selection.from, to: selection.to, insert })
            }
            return { edits, selection: 'preserve' }
          }
        })
      }
    }
  }

  return {
    api,
    finish: () => {
      acceptingRegistrations = false
      return {
        mappings: [...mappings.values()],
        commands: [...descriptors.values()],
        invoke: async (id, context) => {
          const handler = handlers.get(id)
          if (!handler) throw new Error(`Unknown user command "${id}".`)
          return normalizeUserCommandResult(await handler(immutableCommandContext(context)))
        }
      }
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

/** Load one complete config in a fresh module graph (the host uses a fresh process per reload). */
export async function loadUserConfig(configPath: string): Promise<LoadedUserConfig> {
  try {
    await fs.access(configPath)
  } catch (error) {
    if (isMissingFileError(error)) {
      const runtime = createRuntime()
      return runtime.finish()
    }
    throw error
  }

  const moduleUrl = `${pathToFileURL(configPath).href}?zennotes_reload=${Date.now()}-${Math.random()}`
  const loaded = (await import(moduleUrl)) as { default?: unknown }
  if (typeof loaded.default !== 'function') {
    throw new Error('init.mjs must default-export a setup function: export default function setup(zen) { … }')
  }

  const runtime = createRuntime()
  await loaded.default(runtime.api)
  return runtime.finish()
}
