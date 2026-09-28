/**
 * Meshing off the main thread. The worker keeps the last DEM/imagery grids so
 * palette and print-setting rebuilds only post the small settings payload; the
 * UI keeps rendering the previous model while this runs.
 */
import { buildTerrainModel, type BuildOptions, type TerrainModel } from './mesh'
import type { HeightGrid } from './dem'
import type { ColorGrid } from './imagery'
import type { Palette } from './palette'
import type { LatLon } from './geo'

export type MeshWorkerGrids = {
  track: LatLon[]
  height: HeightGrid
  colors: ColorGrid
}

export type MeshWorkerRequest = {
  id: number
  gridsKey: string
  /** Omitted when the worker already holds grids for `gridsKey`. */
  grids?: MeshWorkerGrids
  palette: Palette
  opts: BuildOptions
}

export type MeshWorkerResponse =
  | { id: number; ok: true; model: TerrainModel }
  | { id: number; ok: false; error: string; needGrids: boolean }

let cacheKey = ''
let cached: MeshWorkerGrids | null = null

self.addEventListener('message', (event: MessageEvent<MeshWorkerRequest>) => {
  const req = event.data
  if (req.grids) {
    cached = req.grids
    cacheKey = req.gridsKey
  }
  if (!cached || cacheKey !== req.gridsKey) {
    const miss: MeshWorkerResponse = {
      id: req.id,
      ok: false,
      error: 'grids not cached in worker',
      needGrids: true,
    }
    self.postMessage(miss)
    return
  }

  try {
    const model = buildTerrainModel(
      cached.height,
      cached.colors,
      req.palette,
      cached.track,
      req.opts,
    )
    const done: MeshWorkerResponse = { id: req.id, ok: true, model }
    self.postMessage(done, {
      transfer: [
        model.positions.buffer,
        model.indices.buffer,
        model.triMaterials.buffer,
      ],
    })
  } catch (err) {
    const failed: MeshWorkerResponse = {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : 'Mesh build failed',
      needGrids: false,
    }
    self.postMessage(failed)
  }
})
