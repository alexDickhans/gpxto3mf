import type { HeightGrid } from './dem'
import type { LatLon } from './geo'
import type { ColorGrid } from './imagery'
import { buildTerrainModel, type BuildOptions, type TerrainModel } from './mesh'
import type { Palette } from './palette'

export type TerrainWorkerRequest = {
  height: HeightGrid
  colors: ColorGrid
  palette: Palette
  track: LatLon[]
  opts: BuildOptions
}

export type TerrainWorkerResponse = {
  positions: Float32Array
  indices: Uint32Array
  triMaterials: Uint16Array
  materials: TerrainModel['materials']
  usageCounts: number[]
  extentMm: TerrainModel['extentMm']
  scaleMmPerM: number
  northAngle: number
}

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TerrainWorkerRequest>) => void) | null
  postMessage: (message: TerrainWorkerResponse, transfer: Transferable[]) => void
}

scope.onmessage = (event) => {
  const { height, colors, palette, track, opts } = event.data
  const model = buildTerrainModel(height, colors, palette, track, opts)
  const response: TerrainWorkerResponse = {
    positions: model.positions,
    indices: model.indices,
    triMaterials: model.triMaterials,
    materials: model.materials,
    usageCounts: model.usageCounts,
    extentMm: model.extentMm,
    scaleMmPerM: model.scaleMmPerM,
    northAngle: model.northAngle,
  }
  scope.postMessage(response, [
    model.positions.buffer,
    model.indices.buffer,
    model.triMaterials.buffer,
  ])
}
