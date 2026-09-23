export type LatLon = { lat: number; lon: number; ele?: number }

export type Track = {
  name: string
  points: LatLon[]
}

export type BBox = {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

const DEG2RAD = Math.PI / 180
const RAD2DEG = 180 / Math.PI
const EARTH_M = 6378137

export function parseGpx(xmlText: string): Track {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('Invalid GPX XML')
  }

  const name =
    doc.querySelector('trk > name')?.textContent?.trim() ||
    doc.querySelector('metadata > name')?.textContent?.trim() ||
    'Track'

  const points: LatLon[] = []
  const nodes = doc.querySelectorAll('trkpt, rtept')
  nodes.forEach((el) => {
    const lat = parseFloat(el.getAttribute('lat') ?? '')
    const lon = parseFloat(el.getAttribute('lon') ?? '')
    if (Number.isNaN(lat) || Number.isNaN(lon)) return
    const eleText = el.querySelector('ele')?.textContent
    const ele = eleText != null ? parseFloat(eleText) : undefined
    points.push({
      lat,
      lon,
      ele: ele != null && !Number.isNaN(ele) ? ele : undefined,
    })
  })

  if (points.length < 2) {
    throw new Error('GPX needs at least 2 track points')
  }

  return { name, points }
}

export function boundsOf(points: LatLon[], padPercent: number): BBox {
  let minLat = Infinity
  let maxLat = -Infinity
  let minLon = Infinity
  let maxLon = -Infinity
  for (const p of points) {
    minLat = Math.min(minLat, p.lat)
    maxLat = Math.max(maxLat, p.lat)
    minLon = Math.min(minLon, p.lon)
    maxLon = Math.max(maxLon, p.lon)
  }
  const dLat = Math.max(maxLat - minLat, 1e-6)
  const dLon = Math.max(maxLon - minLon, 1e-6)
  const pad = padPercent / 100
  return {
    minLat: minLat - dLat * pad,
    maxLat: maxLat + dLat * pad,
    minLon: minLon - dLon * pad,
    maxLon: maxLon + dLon * pad,
  }
}

/** Local tangent plane meters relative to bbox SW corner */
export function toLocalMeters(lat: number, lon: number, origin: BBox) {
  const lat0 = origin.minLat
  const lon0 = origin.minLon
  const x = (lon - lon0) * DEG2RAD * EARTH_M * Math.cos(lat0 * DEG2RAD)
  const y = (lat - lat0) * DEG2RAD * EARTH_M
  return { x, y }
}

export function localExtent(bbox: BBox) {
  const sw = toLocalMeters(bbox.minLat, bbox.minLon, bbox)
  const ne = toLocalMeters(bbox.maxLat, bbox.maxLon, bbox)
  return {
    widthM: ne.x - sw.x,
    heightM: ne.y - sw.y,
  }
}

export function lonLatToTile(lon: number, lat: number, z: number) {
  const n = 2 ** z
  const x = ((lon + 180) / 360) * n
  const latRad = lat * DEG2RAD
  const y =
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  return { x, y, n }
}

export function tileToLonLat(x: number, y: number, z: number) {
  const n = 2 ** z
  const lon = (x / n) * 360 - 180
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)))
  return { lon, lat: latRad * RAD2DEG }
}

export function chooseZoom(
  bbox: BBox,
  targetTiles = 4,
  options?: { maxZ?: number; minZ?: number },
): number {
  const maxZ = options?.maxZ ?? 14
  const minZ = options?.minZ ?? 8
  const midLat = (bbox.minLat + bbox.maxLat) / 2
  const widthM = localExtent(bbox).widthM
  // rough meters per tile at z
  for (let z = maxZ; z >= minZ; z--) {
    const mPerTile =
      (Math.cos(midLat * DEG2RAD) * 2 * Math.PI * EARTH_M) / 2 ** z
    if (widthM / mPerTile <= targetTiles) return z
  }
  return minZ
}
