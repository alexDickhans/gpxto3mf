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

export const DEFAULTS = {
  exaggeration: 1.8,
  routeHeightMm: 1.2,
  routeWidthMm: 1.5,
  bedSizeMm: 200,
  bboxPadPercent: 12,
  /** Map/DEM sample size — slider from balanced (160) → export max (4096) */
  fetchResolution: FETCH_RESOLUTION_MIN,
  /**
   * Minimum color patch size on the bed (mm). Smaller islands merge into
   * neighbors so AMS contours stay printable.
   */
  minColorRegionMm: 4,
  showNorth: true,
  showScale: true,
} as const

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
 * Expanded AMS-style library. Toggle `enabled` to include/exclude a slot from
 * terrain color matching (route filament can still use any swatch).
 */
export const DEFAULT_PALETTE = {
  name: 'Crag AMS Library',
  colors: [
    { name: 'Stone', hex: '#8A7F72', enabled: true },
    { name: 'Granite', hex: '#9A958C', enabled: true },
    { name: 'Sand', hex: '#C4A882', enabled: true },
    { name: 'Clay', hex: '#A66B4A', enabled: false },
    { name: 'Earth', hex: '#6E4B32', enabled: true },
    { name: 'Dirt', hex: '#5C4030', enabled: false },
    { name: 'Lichen', hex: '#6B7F4A', enabled: true },
    { name: 'Moss', hex: '#4A6B3A', enabled: false },
    { name: 'Forest', hex: '#2F4A38', enabled: true },
    { name: 'Sage', hex: '#7A8F6E', enabled: false },
    { name: 'Water', hex: '#3D6B8A', enabled: false },
    { name: 'Ice', hex: '#B8D4E0', enabled: false },
    { name: 'Snow', hex: '#E8E4DC', enabled: true },
    { name: 'Shadow', hex: '#3A3F3C', enabled: true },
    { name: 'Charcoal', hex: '#2A2A2A', enabled: false },
    { name: 'Route', hex: '#E23B2F', enabled: true },
  ],
}
