import { boundsOf, parseGpx, type LatLon, type Track } from './geo'
import { fetchHeightGrid, type HeightGrid } from './dem'
import { averageRgb, fetchColorGrid, type ColorGrid } from './imagery'
import {
  parsePaletteText,
  pickRouteColorIndex,
  type Palette,
} from './palette'
import {
  buildTerrainModel,
  downsampleColorGrid,
  downsampleHeightGrid,
  type TerrainModel,
} from './mesh'
import type { TerrainWorkerRequest, TerrainWorkerResponse } from './terrain.worker'
import { DEFAULTS, DEFAULT_PALETTE, demBudgetForResolution } from './defaults'
import type { ImagerySeason } from './sentinelSeason'

export type PipelineSettings = {
  exaggeration: number
  bedSizeMm: number
  routeHeightMm: number
  routeWidthMm: number
  bboxPadPercent: number
  fetchResolution: number
  minColorRegionMm: number
  colorEdgeSmooth: number
  routeColorIndex: number | null
  /** `default` is the Esri mosaic. A season requests Sentinel-2 for those months. */
  imagerySeason?: ImagerySeason
}

export type PipelineResult = {
  track: Track
  model: TerrainModel
  palette: Palette
  routeColorIndex: number
  /** Year-stamped season when one was requested, e.g. "Fall 2025" */
  imageryLabel?: string
}

function buildTerrainInWorker(
  height: HeightGrid,
  colors: ColorGrid,
  palette: Palette,
  track: LatLon[],
  opts: Parameters<typeof buildTerrainModel>[4],
): Promise<TerrainModel> {
  const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), {
    type: 'module',
  })
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<TerrainWorkerResponse>) => {
      const data = event.data
      worker.terminate()
      resolve({
        positions: data.positions,
        indices: data.indices,
        triMaterials: data.triMaterials,
        materials: data.materials,
        usageCounts: data.usageCounts,
        extentMm: data.extentMm,
        scaleMmPerM: data.scaleMmPerM,
        northAngle: data.northAngle,
      })
    }
    worker.onerror = (event) => {
      worker.terminate()
      reject(new Error(event.message || 'Mesh build failed'))
    }
    const request: TerrainWorkerRequest = { height, colors, palette, track, opts }
    worker.postMessage(request, [height.heights.buffer, colors.rgb.buffer])
  })
}

export async function runPipeline(
  gpxText: string,
  palette: Palette,
  settings: PipelineSettings,
  onProgress?: (msg: string) => void,
  onCoarse?: (model: TerrainModel) => void | Promise<void>,
): Promise<PipelineResult> {
  onProgress?.('Parsing GPX…')
  const track = parseGpx(gpxText)
  const bbox = boundsOf(track.points, settings.bboxPadPercent)
  const res = settings.fetchResolution
  const demZoom = demBudgetForResolution(res)

  const [height, colors] = await Promise.all([
    fetchHeightGrid(bbox, res, onProgress, demZoom),
    fetchColorGrid(bbox, res, onProgress, undefined, settings.imagerySeason ?? 'default'),
  ])

  onProgress?.('Matching palette…')
  const avg = averageRgb(colors)
  const routeColorIndex =
    settings.routeColorIndex ?? pickRouteColorIndex(palette, avg)

  const buildOpts = {
    exaggeration: settings.exaggeration,
    bedSizeMm: settings.bedSizeMm,
    routeHeightMm: settings.routeHeightMm,
    routeWidthMm: settings.routeWidthMm,
    routeColorIndex,
    minColorRegionMm: settings.minColorRegionMm,
    colorEdgeSmooth: settings.colorEdgeSmooth,
  }
  let model: TerrainModel
  if (onCoarse) {
    onProgress?.('Building preview…')
    const coarse = buildTerrainModel(
      downsampleHeightGrid(height, 48),
      downsampleColorGrid(colors, 48),
      palette,
      track.points,
      buildOpts,
    )
    await onCoarse(coarse)
    onProgress?.('Finishing mesh…')
    model =
      typeof Worker === 'undefined'
        ? buildTerrainModel(height, colors, palette, track.points, buildOpts)
        : await buildTerrainInWorker(height, colors, palette, track.points, buildOpts)
  } else {
    onProgress?.('Building mesh…')
    model = buildTerrainModel(height, colors, palette, track.points, buildOpts)
  }

  onProgress?.('Ready')
  return { track, model, palette, routeColorIndex, imageryLabel: colors.label }
}

export { parsePaletteText, DEFAULT_PALETTE, DEFAULTS }
export type { Palette, TerrainModel, HeightGrid, ColorGrid, LatLon, Track }
