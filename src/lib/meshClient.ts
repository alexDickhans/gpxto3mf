/**
 * Main-thread side of the meshing worker. Grids are posted once per fetch and
 * held in the worker, so a palette toggle only ships the settings object.
 * Falls back to a synchronous build when workers are unavailable.
 */
import { buildTerrainModel, type BuildOptions, type TerrainModel } from './mesh'
import type {
  MeshWorkerGrids,
  MeshWorkerRequest,
  MeshWorkerResponse,
} from './meshWorker'
import type { Palette } from './palette'

type Pending = {
  resolve: (model: TerrainModel) => void
  reject: (err: Error) => void
  request: MeshWorkerRequest
  grids: MeshWorkerGrids
}

let worker: Worker | null = null
let workerUnavailable = false
let workerKey = ''
let seq = 0
const pending = new Map<number, Pending>()

function failAll(err: Error) {
  for (const job of pending.values()) job.reject(err)
  pending.clear()
}

function ensureWorker(): Worker | null {
  if (workerUnavailable) return null
  if (worker) return worker
  try {
    worker = new Worker(new URL('./meshWorker.ts', import.meta.url), {
      type: 'module',
    })
  } catch {
    workerUnavailable = true
    return null
  }
  workerKey = ''
  worker.addEventListener('message', (event: MessageEvent<MeshWorkerResponse>) => {
    const msg = event.data
    const job = pending.get(msg.id)
    if (!job) return
    if (msg.ok) {
      pending.delete(msg.id)
      job.resolve(msg.model)
      return
    }
    if (msg.needGrids && !job.request.grids) {
      // Worker restarted or saw a newer key first — resend the payload.
      job.request.grids = job.grids
      workerKey = job.request.gridsKey
      worker?.postMessage(job.request)
      return
    }
    pending.delete(msg.id)
    job.reject(new Error(msg.error))
  })
  worker.addEventListener('error', () => {
    workerUnavailable = true
    worker?.terminate()
    worker = null
    failAll(new Error('Mesh worker crashed — reload to retry'))
  })
  return worker
}

export function buildMesh(
  gridsKey: string,
  grids: MeshWorkerGrids,
  palette: Palette,
  opts: BuildOptions,
): Promise<TerrainModel> {
  const active = ensureWorker()
  if (!active) {
    return Promise.resolve(
      buildTerrainModel(grids.height, grids.colors, palette, grids.track, opts),
    )
  }
  const id = ++seq
  const request: MeshWorkerRequest = {
    id,
    gridsKey,
    palette,
    opts,
    grids: workerKey === gridsKey ? undefined : grids,
  }
  workerKey = gridsKey
  return new Promise<TerrainModel>((resolve, reject) => {
    pending.set(id, { resolve, reject, request, grids })
    active.postMessage(request)
  })
}
