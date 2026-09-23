import { parentPort } from 'node:worker_threads'
import { processBucket, processChunk } from './mesh-checks.mjs'

parentPort.on('message', (msg) => {
  try {
    const result = msg.type === 'chunk' ? processChunk(msg) : processBucket(msg)
    const transfers = result.transfers || []
    delete result.transfers
    parentPort.postMessage({ id: msg.id, result }, transfers)
  } catch (err) {
    parentPort.postMessage({
      id: msg.id,
      error: err instanceof Error ? err.stack || err.message : String(err),
    })
  }
})
