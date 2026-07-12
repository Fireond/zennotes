import type {
  UserCommandDescriptor,
  UserConfigSnapshot
} from '@bridge-contract/user-config'

const EMPTY_USER_CONFIG: UserConfigSnapshot = {
  revision: 0,
  configPath: '',
  mappings: [],
  commands: [],
  error: null
}

let snapshot: UserConfigSnapshot = EMPTY_USER_CONFIG
let initializePromise: Promise<UserConfigSnapshot> | null = null
let unsubscribeBridge: (() => void) | null = null
const listeners = new Set<(next: UserConfigSnapshot) => void>()

function publish(next: UserConfigSnapshot): UserConfigSnapshot {
  // A watch event can overtake the initial IPC response. Never let that older
  // response roll the renderer back to a previous host generation.
  if (next.revision < snapshot.revision) return snapshot
  snapshot = next
  for (const listener of listeners) listener(next)
  return next
}

/** Latest trusted-user-config metadata received from the desktop host. */
export function getUserConfigSnapshot(): UserConfigSnapshot {
  return snapshot
}

export function getUserCommandDescriptors(): readonly UserCommandDescriptor[] {
  return snapshot.commands
}

export function isHostedUserCommand(commandId: string): boolean {
  return snapshot.commands.some((command) => command.id === commandId)
}

export function subscribeUserConfig(
  listener: (next: UserConfigSnapshot) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Start the desktop bridge subscription exactly once. Web and test bridges may
 * omit this desktop-only API, in which case programmable config is simply off.
 */
export function initializeUserConfig(): Promise<UserConfigSnapshot> {
  if (initializePromise) return initializePromise

  const bridge = window.zen as typeof window.zen & {
    getUserConfig?: () => Promise<UserConfigSnapshot>
    onUserConfigChange?: (cb: (next: UserConfigSnapshot) => void) => () => void
  }
  if (typeof bridge.getUserConfig !== 'function') {
    initializePromise = Promise.resolve(snapshot)
    return initializePromise
  }

  if (typeof bridge.onUserConfigChange === 'function' && !unsubscribeBridge) {
    unsubscribeBridge = bridge.onUserConfigChange((next) => publish(next))
  }

  initializePromise = bridge
    .getUserConfig()
    .then((next) => publish(next))
    .catch((error) =>
      publish({
        ...EMPTY_USER_CONFIG,
        error: error instanceof Error ? error.message : String(error)
      })
    )
  return initializePromise
}

export async function reloadUserConfig(): Promise<UserConfigSnapshot> {
  const bridge = window.zen as typeof window.zen & {
    reloadUserConfig?: () => Promise<UserConfigSnapshot>
  }
  if (typeof bridge.reloadUserConfig !== 'function') return snapshot
  return publish(await bridge.reloadUserConfig())
}

/** Test/HMR cleanup; production normally keeps the subscription for the window lifetime. */
export function resetUserConfigState(): void {
  unsubscribeBridge?.()
  unsubscribeBridge = null
  initializePromise = null
  snapshot = EMPTY_USER_CONFIG
  listeners.clear()
}

if (import.meta.hot) {
  import.meta.hot.dispose(resetUserConfigState)
}
