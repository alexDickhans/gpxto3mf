import {
  chooseZoom,
  type BBox,
  toLocalMeters,
  localExtent,
} from './geo'
import {
  prefetchTiles,
  sampleElevationBilinear,
  tileRangeForBBox,
  tryStitchTileMosaic,
} from './tileFetch'

export type HeightGrid = {
  cols: number
  rows: number
  /** meters above sea level, row-major south→north, west→east */
  heights: Float32Array
  bbox: BBox
  widthM: number
  heightM: number
  minH: number
  maxH: number
}

/** Terrarium encoding: elevation = R*256 + G + B/256 - 32768 */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768
}

function isPlausibleElevation(h: number): boolean {
  return Number.isFinite(h) && h > -500 && h < 9000
}

/**
 * Fast O(N) cleanup — no per-cell allocations or sorts.
 * With decode-then-bilinear DEM sampling, bad cells are rare; we only rewrite
 * voids and true outliers vs a 4-neighbor mean.
 */
function repairHeightField(heights: Float32Array, cols: number, rows: number) {
  const n = heights.length

  // Running mean of valid samples (avoids sorting the whole grid for a median)
  let sum = 0
  let count = 0
  let bad = 0
  for (let k = 0; k < n; k++) {
    const h = heights[k]
    if (isPlausibleElevation(h)) {
      sum += h
      count++
    } else {
      bad++
    }
  }
  const fallback = count > 0 ? sum / count : 0

  // Fill voids from 4-neighbors (at most 2 sweeps — enough for thin gaps)
  if (bad > 0) {
    for (let pass = 0; pass < 2; pass++) {
      let fixed = 0
      for (let j = 0; j < rows; j++) {
        const row = j * cols
        for (let i = 0; i < cols; i++) {
          const k = row + i
          if (isPlausibleElevation(heights[k])) continue
          let s = 0
          let c = 0
          if (i > 0 && isPlausibleElevation(heights[k - 1])) {
            s += heights[k - 1]
            c++
          }
          if (i + 1 < cols && isPlausibleElevation(heights[k + 1])) {
            s += heights[k + 1]
            c++
          }
          if (j > 0 && isPlausibleElevation(heights[k - cols])) {
            s += heights[k - cols]
            c++
          }
          if (j + 1 < rows && isPlausibleElevation(heights[k + cols])) {
            s += heights[k + cols]
            c++
          }
          if (c > 0) {
            heights[k] = s / c
            fixed++
          } else if (pass === 1) {
            heights[k] = fallback
            fixed++
          }
        }
      }
      if (fixed === 0) break
    }
  }

  // Spike pass: compare to 4-neighbor mean (no arrays, no sort). Write into
  // a scratch buffer only when something changes so we stay O(N).
  let spikeCount = 0
  const SPIKE_M = 150
  for (let j = 0; j < rows; j++) {
    const row = j * cols
    for (let i = 0; i < cols; i++) {
      const k = row + i
      let s = 0
      let c = 0
      if (i > 0) {
        s += heights[k - 1]
        c++
      }
      if (i + 1 < cols) {
        s += heights[k + 1]
        c++
      }
      if (j > 0) {
        s += heights[k - cols]
        c++
      }
      if (j + 1 < rows) {
        s += heights[k + cols]
        c++
      }
      if (c < 2) continue
      const mean = s / c
      if (Math.abs(heights[k] - mean) > SPIKE_M) {
        // Mark in-place with a sentinel by temporarily using a parallel flag —
        // collect indices of spikes in a small list if rare; else rewrite now
        // from neighbors only (safe because we read originals first into mean).
        spikeCount++
        heights[k] = mean
      }
    }
  }

  // If we rewrote spikes from left-to-right, order bias is tiny at 150m threshold.
  // One optional progress-free second pass only when many spikes (tile-edge bands).
  if (spikeCount > n * 0.01) {
    for (let j = 0; j < rows; j++) {
      const row = j * cols
      for (let i = 0; i < cols; i++) {
        const k = row + i
        let s = 0
        let c = 0
        if (i > 0) {
          s += heights[k - 1]
          c++
        }
        if (i + 1 < cols) {
          s += heights[k + 1]
          c++
        }
        if (j > 0) {
          s += heights[k - cols]
          c++
        }
        if (j + 1 < rows) {
          s += heights[k + cols]
          c++
        }
        if (c >= 2 && Math.abs(heights[k] - s / c) > SPIKE_M) {
          heights[k] = s / c
        }
      }
    }
  }
}

export async function fetchHeightGrid(
  bbox: BBox,
  resolution: number,
  onProgress?: (msg: string) => void,
  zoom?: { maxZ: number; minZ: number; targetTiles: number },
): Promise<HeightGrid> {
  const budget = zoom ?? { maxZ: 13, minZ: 10, targetTiles: 10 }
  const z = chooseZoom(bbox, budget.targetTiles, {
    maxZ: budget.maxZ,
    minZ: budget.minZ,
  })
  const range = tileRangeForBBox(bbox, z)
  onProgress?.(`DEM z${z} · 0/${range.count} tiles…`)

  const tiles = await prefetchTiles('dem', range, (done, total) => {
    onProgress?.(`DEM z${z} · ${done}/${total} tiles…`)
  })

  const mosaic = tryStitchTileMosaic(tiles, range)
  onProgress?.(mosaic ? `Sampling DEM mosaic…` : `Sampling DEM…`)

  const cols = resolution
  const rows = resolution
  const heights = new Float32Array(cols * rows)

  for (let j = 0; j < rows; j++) {
    const lat =
      bbox.minLat + ((bbox.maxLat - bbox.minLat) * j) / Math.max(1, rows - 1)
    for (let i = 0; i < cols; i++) {
      const lon =
        bbox.minLon + ((bbox.maxLon - bbox.minLon) * i) / Math.max(1, cols - 1)
      heights[j * cols + i] = sampleElevationBilinear(
        lon,
        lat,
        z,
        tiles,
        mosaic,
        decodeTerrarium,
      )
    }
  }

  onProgress?.('Repairing elevation spikes…')
  repairHeightField(heights, cols, rows)

  let minH = Infinity
  let maxH = -Infinity
  for (let k = 0; k < heights.length; k++) {
    minH = Math.min(minH, heights[k])
    maxH = Math.max(maxH, heights[k])
  }

  const { widthM, heightM } = localExtent(bbox)
  return { cols, rows, heights, bbox, widthM, heightM, minH, maxH }
}

export function sampleHeight(
  grid: HeightGrid,
  lat: number,
  lon: number,
): number {
  const { bbox, cols, rows, heights } = grid
  const u =
    (lon - bbox.minLon) / Math.max(1e-12, bbox.maxLon - bbox.minLon)
  const v =
    (lat - bbox.minLat) / Math.max(1e-12, bbox.maxLat - bbox.minLat)
  const x = Math.max(0, Math.min(cols - 1, u * (cols - 1)))
  const y = Math.max(0, Math.min(rows - 1, v * (rows - 1)))
  const i0 = Math.max(0, Math.min(cols - 2, Math.floor(x)))
  const j0 = Math.max(0, Math.min(rows - 2, Math.floor(y)))
  const fx = x - i0
  const fy = y - j0
  const h00 = heights[j0 * cols + i0]
  const h10 = heights[j0 * cols + i0 + 1]
  const h01 = heights[(j0 + 1) * cols + i0]
  const h11 = heights[(j0 + 1) * cols + i0 + 1]
  return (
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy
  )
}

export function gridCellLocal(
  grid: HeightGrid,
  i: number,
  j: number,
): { x: number; y: number } {
  const lon =
    grid.bbox.minLon +
    ((grid.bbox.maxLon - grid.bbox.minLon) * i) / (grid.cols - 1)
  const lat =
    grid.bbox.minLat +
    ((grid.bbox.maxLat - grid.bbox.minLat) * j) / (grid.rows - 1)
  return toLocalMeters(lat, lon, grid.bbox)
}
