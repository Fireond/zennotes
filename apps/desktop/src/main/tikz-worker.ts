import { compileTikz } from './tikz-compiler'
import type { TikzHostMessage, TikzWorkerMessage } from './tikz-protocol'

const parentPort = process.parentPort
let renderQueue: Promise<void> = Promise.resolve()

function send(message: TikzWorkerMessage): void {
  parentPort.postMessage(message)
}

async function handleMessage(message: TikzHostMessage): Promise<void> {
  if (!message || typeof message !== 'object' || message.type !== 'render') return
  const response = await compileTikz(message.source)
  send({ type: 'render-result', requestId: message.requestId, response })
}

parentPort.on('message', (event) => {
  const message = event.data as TikzHostMessage
  // Keep this guard in the worker too: node-tikzjax uses module-global TeX
  // state and explicitly does not support concurrent compilation.
  renderQueue = renderQueue.then(
    () => handleMessage(message),
    () => handleMessage(message)
  )
})

send({ type: 'ready' })
