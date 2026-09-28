import { boundsOf, parseGpx, type BBox, type LatLon, type Track } from './geo'
import { fetchHeightGrid, type HeightGrid } from './dem'
import { averageRgb, fetchColorGrid, type ColorGrid } from './imagery'
import {
  parsePaletteText,
  pickRouteColorIndex,
  type Palette,
} from './palette'
import {
  buildTerrainModel,
  type BuildOptions,
  type TerrainModel,
} from './mesh'
import {
  DEFAULTS,
  DEFAULT_PALETTE,
  demBudgetForResolution,
  type ColorMode,
} from './defaults'
import type { ImagerySeason } from './sentinelSeason'

/** Everything that decides which pixels we download. */
export type FetchSettings = {
  bboxPadPercent: number
  fetchResolution: number
  /** `default` is the Esri mosaic. A season requests Sentinel-2 for those months. */
  imagerySeason?: ImagerySeason
}

/** Everything that only reshapes grids we already have in memory. */
export type MeshSettings = {
  exaggeration: number
  bedSizeMm: number
  routeHeightMm: number
  routeWidthMm: number
  minColorRegionMm: number
  colorEdgeSmooth: number
  routeColorIndex: number | null
  baseThicknessMm: number
  colorShellMm: number
  colorMode: ColorMode
  /** Mesh at most this many samples on a side (grids stay at fetch size). */
  meshResolution?: number
}

export type PipelineSettings = FetchSettings & MeshSettings

/** Fetched DEM + imagery for one bbox — cacheable across remeshes. */
export type TerrainGrids = {
  track: Track
  bbox: BBox
  height: HeightGrid
  colors: ColorGrid
  /** Year-stamped season when one was requested, e.g. "Fall 2025" */
  imageryLabel?: string
  /** Average terrain color, used to auto-pick a contrasting route filament */
  averageRgb: [number, number, number]
}

export type PipelineResult = {
  track: Track
  model: TerrainModel
  palette: Palette
  routeColorIndex: number
  imageryLabel?: string
}

/** Stable identity for a grid fetch — anything else can remesh from cache. */
export function gridsCacheKey(
  gpxText: string,
  settings: FetchSettings,
): string {
  return [
    gpxText.length,
    settings.bboxPadPercent,
    settings.fetchResolution,
    settings.imagerySeason ?? 'default',
  ].join('|')
}

export async function fetchTerrainGrids(
  gpxText: string,
  settings: FetchSettings,
  onProgress?: (msg: string) => void,
): Promise<TerrainGrids> {
  onProgress?.('Parsing GPX…')
  const track = parseGpx(gpxText)
  const bbox = boundsOf(track.points, settings.bboxPadPercent)
  const res = settings.fetchResolution
  const demZoom = demBudgetForResolution(res)

  const [height, colors] = await Promise.all([
    fetchHeightGrid(bbox, res, onProgress, demZoom),
    fetchColorGrid(
      bbox,
      res,
      onProgress,
      undefined,
      settings.imagerySeason ?? 'default',
    ),
  ])

  return {
    track,
    bbox,
    height,
    colors,
    imageryLabel: colors.label,
    averageRgb: averageRgb(colors),
  }
}

export function meshBuildOptions(
  settings: MeshSettings,
  routeColorIndex: number,
): BuildOptions {
  return {
    exaggeration: settings.exaggeration,
    bedSizeMm: settings.bedSizeMm,
    routeHeightMm: settings.routeHeightMm,
    routeWidthMm: settings.routeWidthMm,
    routeColorIndex,
    minColorRegionMm: settings.minColorRegionMm,
    colorEdgeSmooth: settings.colorEdgeSmooth,
    baseThicknessMm: settings.baseThicknessMm,
    colorShellMm: settings.colorShellMm,
    colorMode: settings.colorMode,
    meshResolution: settings.meshResolution,
  }
}

export function buildFromGrids(
  grids: TerrainGrids,
  palette: Palette,
  settings: MeshSettings,
): { model: TerrainModel; routeColorIndex: number } {
  const routeColorIndex =
    settings.routeColorIndex ?? pickRouteColorIndex(palette, grids.averageRgb)
  const model = buildTerrainModel(
    grids.height,
    grids.colors,
    palette,
    grids.track.points,
    meshBuildOptions(settings, routeColorIndex),
  )
  return { model, routeColorIndex }
}

export async function runPipeline(
  gpxText: string,
  palette: Palette,
  settings: PipelineSettings,
  onProgress?: (msg: string) => void,
): Promise<PipelineResult> {
  const grids = await fetchTerrainGrids(gpxText, settings, onProgress)
  onProgress?.('Building mesh…')
  const { model, routeColorIndex } = buildFromGrids(grids, palette, settings)
  onProgress?.('Ready')
  return {
    track: grids.track,
    model,
    palette,
    routeColorIndex,
    imageryLabel: grids.imageryLabel,
  }
}

export { parsePaletteText, DEFAULT_PALETTE, DEFAULTS }
export type { Palette, TerrainModel, HeightGrid, ColorGrid, LatLon, Track }
