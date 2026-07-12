import type { LoadedUserConfig } from './user-config-runtime'
import { loadUserConfig } from './user-config-runtime'
import { errorText, type UserConfigHostMessage, type UserConfigWorkerMessage } from './user-config-protocol'

const parentPort = process.parentPort
let runtime: LoadedUserConfig | null = null
let loading = false

function send(message: UserConfigWorkerMessage): void {
  parentPort.postMessage(message)
}

async function handleMessage(message: UserConfigHostMessage): Promise<void> {
  if (!message || typeof message !== 'object') return

  if (message.type === 'load') {
    if (loading || runtime) {
      send({ type: 'load-error', error: 'The user config worker was asked to load more than once.' })
      return
    }
    loading = true
    try {
      runtime = await loadUserConfig(message.configPath)
      send({
        type: 'ready',
        mappings: runtime.mappings,
        commands: runtime.commands
      })
    } catch (error) {
      send({ type: 'load-error', error: errorText(error) })
    }
    return
  }

  if (message.type === 'invoke') {
    if (!runtime) {
      send({
        type: 'invoke-result',
        requestId: message.requestId,
        response: { ok: false, error: 'User configuration is not loaded.' }
      })
      return
    }
    try {
      const result = await runtime.invoke(message.commandId, message.context)
      send({
        type: 'invoke-result',
        requestId: message.requestId,
        response: { ok: true, result }
      })
    } catch (error) {
      send({
        type: 'invoke-result',
        requestId: message.requestId,
        response: { ok: false, error: errorText(error) }
      })
    }
  }
}

parentPort.on('message', (event) => {
  void handleMessage(event.data as UserConfigHostMessage)
})
