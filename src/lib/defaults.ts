export type ZoomBudget = {
  maxZ: number
  minZ: number
  /** Allow denser zoom when bbox fits in this many tiles across */
  targetTiles: number
}

/** Balanced floor — previous default “balanced” preset */
export const FETCH_RESOLUTION_MIN = 160
/**
 * Absolute max for a single Esri World Imagery MapServer export (px on a side).
 * DEM zoom also ramps to Terrarium’s densest coverage with this value.
 */
export const FETCH_RESOLUTION_MAX = 4096

/**
 * Interactive rebuilds mesh at most this many samples on a side. The fetched
 * grid is kept at full `fetchResolution` and re-meshed at that resolution only
 * when the 3MF is exported, so orbiting stays smooth on a 4096² fetch.
 */
export const MESH_RESOLUTION_PREVIEW_MAX = 384

/** Thinner than this and the slab warps off the plate. */
export const BASE_THICKNESS_MIN_MM = 0.8

/** How terrain colors are chosen for each cell. */
export type ColorMode = 'imagery' | 'elevation' | 'blend'

export const COLOR_MODES: { id: ColorMode; label: string; hint: string }[] = [
  { id: 'imagery', label: 'Imagery', hint: 'Match the satellite hue' },
  { id: 'elevation', label: 'Elevation', hint: 'Hypsometric bands by height' },
  { id: 'blend', label: 'Blend', hint: 'Imagery hue pulled toward its band' },
]

export const DEFAULTS = {
  exaggeration: 1.8,
  routeHeightMm: 1.2,
  routeWidthMm: 1.5,
  bedSizeMm: 200,
  bboxPadPercent: 12,
  /** Map/DEM sample size — slider from balanced (160) → export max (4096) */
  fetchResolution: 256,
  /**
   * Minimum color patch size on the bed (mm). Smaller islands merge into
   * neighbors so AMS contours stay printable.
   */
  minColorRegionMm: 4,
  /** 0 = stair-stepped color edges, 1 = rounded anti-aliased contours */
  colorEdgeSmooth: 0.75,
  /** Single-color solid under the colored shell (mm). */
  baseThicknessMm: 1.6,
  /**
   * Depth of the per-color top shell (mm). Everything below is one color, so
   * the AMS only swaps filament in the last few layers. 0 = color full depth.
   */
  colorShellMm: 1,
  colorMode: 'blend' as const,
  showNorth: true,
  showScale: true,
  /** `default` keeps Esri World Imagery; other values request that season */
  imagerySeason: 'default' as const,
} as const

/** Rough triangle count for a mesh grid — drives the interactive cost warning. */
export function estimateTriangleCount(
  meshResolution: number,
  colorShellMm: number,
): number {
  const cells = Math.max(1, meshResolution - 1) ** 2
  // top + bottom per cell, plus a base slab top when the color shell is on
  const perCell = colorShellMm > 0.05 ? 6 : 4
  return cells * perCell
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function clamp01(t: number) {
  return Math.max(0, Math.min(1, t))
}

/** 0 = balanced, 1 = absolute max */
export function fetchResolutionT(resolution: number): number {
  return clamp01(
    (resolution - FETCH_RESOLUTION_MIN) /
      (FETCH_RESOLUTION_MAX - FETCH_RESOLUTION_MIN),
  )
}

/** DEM tile zoom budget scales with the fetch slider (imagery is one export). */
export function demBudgetForResolution(resolution: number): ZoomBudget {
  const t = fetchResolutionT(resolution)
  return {
    maxZ: Math.round(lerp(13, 15, t)),
    minZ: Math.round(lerp(10, 12, t)),
    targetTiles: Math.round(lerp(10, 512, t)),
  }
}

/**
 * AMS-style library. Toggle `enabled` to include/exclude a slot from terrain
 * color matching; the swatch picked as the route filament is always excluded
 * from matching so the line stays readable against the terrain.
 *
 * Defaults ship four terrain colors plus the route — an AMS-friendly load with
 * a min pairwise ΔE76 of 33, so every band is obvious at arm's length.
 * Near-duplicate greys (Granite) were dropped; Stone survives as the opt-in
 * rock tone.
 */
export const DEFAULT_PALETTE = {
  name: 'Crag AMS Library',
  colors: [
    { name: 'Stone', hex: '#8A7F72', enabled: false },
    { name: 'Sand', hex: '#C4A882', enabled: true },
    { name: 'Clay', hex: '#A66B4A', enabled: false },
    { name: 'Earth', hex: '#6E4B32', enabled: false },
    { name: 'Dirt', hex: '#5C4030', enabled: false },
    { name: 'Lichen', hex: '#6B7F4A', enabled: false },
    { name: 'Moss', hex: '#4A6B3A', enabled: false },
    { name: 'Forest', hex: '#2F4A38', enabled: true },
    { name: 'Sage', hex: '#7A8F6E', enabled: false },
    { name: 'Water', hex: '#3D6B8A', enabled: true },
    { name: 'Ice', hex: '#B8D4E0', enabled: true },
    { name: 'Snow', hex: '#E8E4DC', enabled: false },
    { name: 'Shadow', hex: '#3A3F3C', enabled: false },
    { name: 'Charcoal', hex: '#2A2A2A', enabled: false },
    { name: 'Route', hex: '#E23B2F', enabled: true },
  ],
}
