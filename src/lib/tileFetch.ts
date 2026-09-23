import type { BBox } from './geo'
import { lonLatToTile } from './geo'
import { decodeTileImage } from './tileImage'

const DEM_UPSTREAM =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const IMG_UPSTREAM =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'

/** Cap parallel transfers — browsers only open ~6 sockets/host; flooding is slower. */
const MAX_CONCURRENT = 16

/** Skip full mosaic when it would exceed this (RGBA bytes). */
const MAX_MOSAIC_BYTES = 180 * 1024 * 1024

type Kind = 'dem' | 'imagery'

const memoryCache = new Map<string, ImageData>()
const inflight = new Map<string, Promise<ImageData>>()

let active = 0
const waitQueue: Array<() => void> = []

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    waitQueue.push(() => {
      active++
      resolve()
    })
  })
}

function release() {
  active--
  const next = waitQueue.shift()
  if (next) next()
}

function cacheKey(kind: Kind, z: number, tx: number, ty: number) {
  return `${kind}:${z}/${tx}/${ty}`
}

function upstreamUrl(kind: Kind, z: number, tx: number, ty: number) {
  if (kind === 'dem') return `${DEM_UPSTREAM}/${z}/${tx}/${ty}.png`
  return `${IMG_UPSTREAM}/${z}/${ty}/${tx}`
}

function proxyUrl(kind: Kind, z: number, tx: number, ty: number) {
  return `/api/${kind}/${z}/${tx}/${ty}.png`
}

async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, { mode: 'cors', credentials: 'omit' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.blob()
}

/** Prefer direct CDN (one hop). Fall back to same-origin proxy if CORS/network fails. */
async function loadTileBlob(
  kind: Kind,
  z: number,
  tx: number,
  ty: number,
): Promise<Blob> {
  try {
    return await fetchBlob(upstreamUrl(kind, z, tx, ty))
  } catch {
    return fetchBlob(proxyUrl(kind, z, tx, ty))
  }
}

export async function getTile(
  kind: Kind,
  z: number,
  tx: number,
  ty: number,
): Promise<ImageData> {
  const key = cacheKey(kind, z, tx, ty)
  const hit = memoryCache.get(key)
  if (hit) return hit

  let pending = inflight.get(key)
  if (!pending) {
    pending = (async () => {
      await acquire()
      try {
        const blob = await loadTileBlob(kind, z, tx, ty)
        const img = await decodeTileImage(blob)
        memoryCache.set(key, img)
        return img
      } finally {
        release()
        inflight.delete(key)
      }
    })()
    inflight.set(key, pending)
  }
  return pending
}

export type TileRange = {
  z: number
  minTX: number
  maxTX: number
  minTY: number
  maxTY: number
  count: number
}

export function tileRangeForBBox(bbox: BBox, z: number): TileRange {
  const sw = lonLatToTile(bbox.minLon, bbox.minLat, z)
  const ne = lonLatToTile(bbox.maxLon, bbox.maxLat, z)
  const minTX = Math.floor(Math.min(sw.x, ne.x))
  const maxTX = Math.floor(Math.max(sw.x, ne.x))
  const minTY = Math.floor(Math.min(sw.y, ne.y))
  const maxTY = Math.floor(Math.max(sw.y, ne.y))
  const count = (maxTX - minTX + 1) * (maxTY - minTY + 1)
  return { z, minTX, maxTX, minTY, maxTY, count }
}

/** Prefetch a tile window with bounded concurrency; returns a sync lookup map. */
export async function prefetchTiles(
  kind: Kind,
  range: TileRange,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, ImageData>> {
  const { z, minTX, maxTX, minTY, maxTY, count } = range
  const local = new Map<string, ImageData>()
  let done = 0

  const coords: Array<[number, number]> = []
  for (let ty = minTY; ty <= maxTY; ty++) {
    for (let tx = minTX; tx <= maxTX; tx++) {
      coords.push([tx, ty])
    }
  }

  await Promise.all(
    coords.map(async ([tx, ty]) => {
      const img = await getTile(kind, z, tx, ty)
      local.set(`${tx}/${ty}`, img)
      done++
      if (done === count || done % 8 === 0) onProgress?.(done, count)
    }),
  )

  return local
}

export type Mosaic = {
  data: Uint8ClampedArray
  width: number
  height: number
  tileSize: number
  originTX: number
  originTY: number
}

/**
 * Stitch tiles into one mosaic when memory allows. Returns null if too large —
 * callers should sample tiles map directly instead.
 */
export function tryStitchTileMosaic(
  tiles: Map<string, ImageData>,
  range: TileRange,
): Mosaic | null {
  const sample = tiles.values().next().value
  const tileSize = sample?.width ?? 256
  const tilesX = range.maxTX - range.minTX + 1
  const tilesY = range.maxTY - range.minTY + 1
  const width = tilesX * tileSize
  const height = tilesY * tileSize
  if (width * height * 4 > MAX_MOSAIC_BYTES) return null

  const data = new Uint8ClampedArray(width * height * 4)

  for (let ty = range.minTY; ty <= range.maxTY; ty++) {
    for (let tx = range.minTX; tx <= range.maxTX; tx++) {
      const img = tiles.get(`${tx}/${ty}`)
      if (!img) continue
      const ox = (tx - range.minTX) * tileSize
      const oy = (ty - range.minTY) * tileSize
      const tw = img.width
      const th = img.height
      for (let row = 0; row < th; row++) {
        const src = row * tw * 4
        const dst = ((oy + row) * width + ox) * 4
        data.set(img.data.subarray(src, src + tw * 4), dst)
      }
    }
  }

  return {
    data,
    width,
    height,
    tileSize,
    originTX: range.minTX,
    originTY: range.minTY,
  }
}

/** Bilinear RGB sample from either a mosaic or per-tile map (sync). */
export function sampleRgbBilinear(
  lon: number,
  lat: number,
  z: number,
  tiles: Map<string, ImageData>,
  mosaic: Mosaic | null,
): [number, number, number] {
  const { x, y } = lonLatToTile(lon, lat, z)

  if (mosaic) {
    const mx = (x - mosaic.originTX) * mosaic.tileSize
    const my = (y - mosaic.originTY) * mosaic.tileSize
    return bilinearFromBuffer(
      mosaic.data,
      mosaic.width,
      mosaic.height,
      mx,
      my,
    )
  }

  const tx = Math.floor(x)
  const ty = Math.floor(y)
  const img = tiles.get(`${tx}/${ty}`)
  if (!img) return [0, 0, 0]
  const fx = (x - tx) * img.width
  const fy = (y - ty) * img.height
  return bilinearFromBuffer(img.data, img.width, img.height, fx, fy)
}

/**
 * Sample elevation in meters from Terrarium tiles.
 * MUST decode each integer pixel first, then bilinear — never lerp RGB
 * (R encodes 256 m steps; RGB lerp creates huge spikes).
 */
export function sampleElevationBilinear(
  lon: number,
  lat: number,
  z: number,
  tiles: Map<string, ImageData>,
  mosaic: Mosaic | null,
  decode: (r: number, g: number, b: number) => number,
): number {
  const { x, y } = lonLatToTile(lon, lat, z)
  const tileSize = mosaic?.tileSize ?? tiles.values().next().value?.width ?? 256

  // Continuous pixel coords in global tile-pixel space (or mosaic space)
  const px = mosaic
    ? (x - mosaic.originTX) * mosaic.tileSize
    : x * tileSize
  const py = mosaic
    ? (y - mosaic.originTY) * mosaic.tileSize
    : y * tileSize

  const x0 = Math.floor(px)
  const y0 = Math.floor(py)
  const x1 = x0 + 1
  const y1 = y0 + 1
  const u = px - x0
  const v = py - y0

  const read = (ix: number, iy: number): number => {
    if (mosaic) {
      if (ix < 0 || iy < 0 || ix >= mosaic.width || iy >= mosaic.height) {
        return Number.NaN
      }
      const o = (iy * mosaic.width + ix) * 4
      return decode(mosaic.data[o], mosaic.data[o + 1], mosaic.data[o + 2])
    }
    const tx = Math.floor(ix / tileSize)
    const ty = Math.floor(iy / tileSize)
    const img = tiles.get(`${tx}/${ty}`)
    if (!img) return Number.NaN
    const lx = ix - tx * tileSize
    const ly = iy - ty * tileSize
    if (lx < 0 || ly < 0 || lx >= img.width || ly >= img.height) {
      return Number.NaN
    }
    const o = (ly * img.width + lx) * 4
    return decode(img.data[o], img.data[o + 1], img.data[o + 2])
  }

  const h00 = read(x0, y0)
  const h10 = read(x1, y0)
  const h01 = read(x0, y1)
  const h11 = read(x1, y1)

  const parts: Array<{ h: number; w: number }> = []
  if (Number.isFinite(h00)) parts.push({ h: h00, w: (1 - u) * (1 - v) })
  if (Number.isFinite(h10)) parts.push({ h: h10, w: u * (1 - v) })
  if (Number.isFinite(h01)) parts.push({ h: h01, w: (1 - u) * v })
  if (Number.isFinite(h11)) parts.push({ h: h11, w: u * v })
  if (parts.length === 0) return Number.NaN
  let wsum = 0
  let hsum = 0
  for (const p of parts) {
    wsum += p.w
    hsum += p.h * p.w
  }
  return wsum > 0 ? hsum / wsum : Number.NaN
}

function bilinearFromBuffer(
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  px: number,
  py: number,
): [number, number, number] {
  const x = Math.min(width - 1.001, Math.max(0, px))
  const y = Math.min(height - 1.001, Math.max(0, py))
  const ix0 = Math.floor(x)
  const iy0 = Math.floor(y)
  const ix1 = Math.min(width - 1, ix0 + 1)
  const iy1 = Math.min(height - 1, iy0 + 1)
  const u = x - ix0
  const v = y - iy0
  const at = (ix: number, iy: number, k: number) => data[(iy * width + ix) * 4 + k]
  const out: [number, number, number] = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    out[k] = Math.round(
      at(ix0, iy0, k) * (1 - u) * (1 - v) +
        at(ix1, iy0, k) * u * (1 - v) +
        at(ix0, iy1, k) * (1 - u) * v +
        at(ix1, iy1, k) * u * v,
    )
  }
  return out
}

export function clearTileMemoryCache() {
  memoryCache.clear()
}
