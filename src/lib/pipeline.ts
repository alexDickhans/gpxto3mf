import { boundsOf, parseGpx, type LatLon, type Track } from './geo'
import { fetchHeightGrid, type HeightGrid } from './dem'
import { averageRgb, fetchColorGrid, type ColorGrid } from './imagery'
import {
  parsePaletteText,
  pickRouteColorIndex,
  type Palette,
} from './palette'
import { buildTerrainModel, type TerrainModel } from './mesh'
import { DEFAULTS, DEFAULT_PALETTE, demBudgetForResolution } from './defaults'

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
}

export type PipelineResult = {
  track: Track
  model: TerrainModel
  palette: Palette
  routeColorIndex: number
}

export async function runPipeline(
  gpxText: string,
  palette: Palette,
  settings: PipelineSettings,
  onProgress?: (msg: string) => void,
): Promise<PipelineResult> {
  onProgress?.('Parsing GPX…')
  const track = parseGpx(gpxText)
  const bbox = boundsOf(track.points, settings.bboxPadPercent)
  const res = settings.fetchResolution
  const demZoom = demBudgetForResolution(res)

  const [height, colors] = await Promise.all([
    fetchHeightGrid(bbox, res, onProgress, demZoom),
    fetchColorGrid(bbox, res, onProgress),
  ])

  onProgress?.('Matching palette…')
  const avg = averageRgb(colors)
  const routeColorIndex =
    settings.routeColorIndex ?? pickRouteColorIndex(palette, avg)

  onProgress?.('Building mesh…')
  const model = buildTerrainModel(height, colors, palette, track.points, {
    exaggeration: settings.exaggeration,
    bedSizeMm: settings.bedSizeMm,
    routeHeightMm: settings.routeHeightMm,
    routeWidthMm: settings.routeWidthMm,
    routeColorIndex,
    minColorRegionMm: settings.minColorRegionMm,
    colorEdgeSmooth: settings.colorEdgeSmooth,
  })

  onProgress?.('Ready')
  return { track, model, palette, routeColorIndex }
}

export { parsePaletteText, DEFAULT_PALETTE, DEFAULTS }
export type { Palette, TerrainModel, HeightGrid, ColorGrid, LatLon, Track }
