import type { BBox } from './geo'
import { decodeTileImage } from './tileImage'
import {
  prefetchTiles,
  sampleRgbBilinear,
  tileRangeForBBox,
  tryStitchTileMosaic,
} from './tileFetch'
import { chooseZoom } from './geo'

export type ColorGrid = {
  cols: number
  rows: number
  /** RGB 0–255, 3 * cols * rows */
  rgb: Uint8Array
}

/** Esri MapServer export often caps around 4096 on a side */
const MAX_EXPORT_PX = 4096

const EXPORT_UPSTREAM =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'

function exportQuery(bbox: BBox, w: number, h: number): string {
  const params = new URLSearchParams({
    bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${w},${h}`,
    format: 'png',
    transparent: 'false',
    f: 'image',
  })
  return params.toString()
}

async function fetchExportBlob(bbox: BBox, w: number, h: number): Promise<Blob> {
  const q = exportQuery(bbox, w, h)
  // Prefer direct CDN (one request). Proxy if CORS blocks.
  try {
    const res = await fetch(`${EXPORT_UPSTREAM}?${q}`, {
      mode: 'cors',
      credentials: 'omit',
    })
    if (!res.ok) throw new Error(`export ${res.status}`)
    return res.blob()
  } catch {
    const res = await fetch(`/api/imagery-export?${q}`)
    if (!res.ok) throw new Error(`Imagery export failed: ${res.status}`)
    return res.blob()
  }
}

/**
 * One MapServer export covering the whole bbox — avoids thousands of tile GETs.
 * Image row 0 is north; our grid row 0 is south, so Y is flipped when copying.
 */
async function fetchColorGridFromExport(
  bbox: BBox,
  resolution: number,
  onProgress?: (msg: string) => void,
): Promise<ColorGrid> {
  const size = Math.max(2, Math.min(MAX_EXPORT_PX, resolution))
  onProgress?.(`Fetching map image ${size}×${size}…`)
  const blob = await fetchExportBlob(bbox, size, size)
  onProgress?.(`Decoding map image…`)
  const img = await decodeTileImage(blob)

  const cols = resolution
  const rows = resolution
  const rgb = new Uint8Array(cols * rows * 3)

  // If export size === grid, copy with Y flip; else bilinear resample
  for (let j = 0; j < rows; j++) {
    const v = rows === 1 ? 0 : j / (rows - 1) // 0 = south
    const srcY = (1 - v) * (img.height - 1) // flip: south → bottom of image
    for (let i = 0; i < cols; i++) {
      const u = cols === 1 ? 0 : i / (cols - 1)
      const srcX = u * (img.width - 1)
      const [r, g, b] = sampleImageBilinear(img, srcX, srcY)
      const oi = (j * cols + i) * 3
      rgb[oi] = r
      rgb[oi + 1] = g
      rgb[oi + 2] = b
    }
  }

  return { cols, rows, rgb }
}

function sampleImageBilinear(
  img: ImageData,
  px: number,
  py: number,
): [number, number, number] {
  const x = Math.min(img.width - 1.001, Math.max(0, px))
  const y = Math.min(img.height - 1.001, Math.max(0, py))
  const ix0 = Math.floor(x)
  const iy0 = Math.floor(y)
  const ix1 = Math.min(img.width - 1, ix0 + 1)
  const iy1 = Math.min(img.height - 1, iy0 + 1)
  const fu = x - ix0
  const fv = y - iy0
  const at = (ix: number, iy: number, k: number) =>
    img.data[(iy * img.width + ix) * 4 + k]
  const out: [number, number, number] = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    out[k] = Math.round(
      at(ix0, iy0, k) * (1 - fu) * (1 - fv) +
        at(ix1, iy0, k) * fu * (1 - fv) +
        at(ix0, iy1, k) * (1 - fu) * fv +
        at(ix1, iy1, k) * fu * fv,
    )
  }
  return out
}

/** Legacy tile mosaic path — used only if the single-image export fails. */
async function fetchColorGridFromTiles(
  bbox: BBox,
  resolution: number,
  onProgress?: (msg: string) => void,
  zoom?: { maxZ: number; minZ: number; targetTiles: number },
): Promise<ColorGrid> {
  const budget = zoom ?? { maxZ: 16, minZ: 13, targetTiles: 16 }
  const z = chooseZoom(bbox, budget.targetTiles, {
    maxZ: budget.maxZ,
    minZ: budget.minZ,
  })
  const range = tileRangeForBBox(bbox, z)
  onProgress?.(`Imagery tiles z${z} · 0/${range.count}…`)

  const tiles = await prefetchTiles('imagery', range, (done, total) => {
    onProgress?.(`Imagery tiles z${z} · ${done}/${total}…`)
  })

  const mosaic = tryStitchTileMosaic(tiles, range)
  const cols = resolution
  const rows = resolution
  const rgb = new Uint8Array(cols * rows * 3)

  for (let j = 0; j < rows; j++) {
    const lat =
      bbox.minLat + ((bbox.maxLat - bbox.minLat) * j) / (rows - 1)
    for (let i = 0; i < cols; i++) {
      const lon =
        bbox.minLon + ((bbox.maxLon - bbox.minLon) * i) / (cols - 1)
      const [r, g, b] = sampleRgbBilinear(lon, lat, z, tiles, mosaic)
      const oi = (j * cols + i) * 3
      rgb[oi] = r
      rgb[oi + 1] = g
      rgb[oi + 2] = b
    }
  }

  return { cols, rows, rgb }
}

export async function fetchColorGrid(
  bbox: BBox,
  resolution: number,
  onProgress?: (msg: string) => void,
  zoom?: { maxZ: number; minZ: number; targetTiles: number },
): Promise<ColorGrid> {
  try {
    return await fetchColorGridFromExport(bbox, resolution, onProgress)
  } catch (err) {
    console.warn('Imagery export failed, falling back to tiles', err)
    onProgress?.('Map export unavailable — using tiles…')
    return fetchColorGridFromTiles(bbox, resolution, onProgress, zoom)
  }
}

export function averageRgb(grid: ColorGrid): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  const n = grid.cols * grid.rows
  for (let i = 0; i < n; i++) {
    r += grid.rgb[i * 3]
    g += grid.rgb[i * 3 + 1]
    b += grid.rgb[i * 3 + 2]
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
}
