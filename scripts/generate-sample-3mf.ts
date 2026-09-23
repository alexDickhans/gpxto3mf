/**
 * Build a 3MF from public/sample.gpx and the default palette, without a browser.
 * Heights come from the GPX elevations (plus a smooth hill) so the mesh builder
 * runs headless; colors are a height ramp matched to the palette.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildTerrainModel } from '../src/lib/mesh.ts'
import { export3mf } from '../src/lib/export3mf.ts'
import { DEFAULTS, DEFAULT_PALETTE } from '../src/lib/defaults.ts'
import { boundsOf, localExtent, type LatLon } from '../src/lib/geo.ts'
import type { HeightGrid } from '../src/lib/dem.ts'
import type { ColorGrid } from '../src/lib/imagery.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseTrack(xml: string): { name: string; points: LatLon[] } {
  const nameMatch = xml.match(/<trk>\s*<name>([^<]*)<\/name>/)
  const name = nameMatch?.[1]?.trim() || 'Track'
  const points: LatLon[] = []
  const re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g
  let match: RegExpExecArray | null
  while ((match = re.exec(xml))) {
    const lat = Number(match[1].match(/lat="([^"]+)"/)?.[1])
    const lon = Number(match[1].match(/lon="([^"]+)"/)?.[1])
    const eleText = match[2].match(/<ele>([^<]*)<\/ele>/)?.[1]
    const ele = eleText != null ? Number(eleText) : undefined
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      points.push({
        lat,
        lon,
        ele: ele != null && Number.isFinite(ele) ? ele : undefined,
      })
    }
  }
  if (points.length < 2) throw new Error('GPX needs at least 2 track points')
  return { name, points }
}

function heightAt(
  lat: number,
  lon: number,
  points: LatLon[],
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number },
) {
  let num = 0
  let den = 0
  for (const point of points) {
    const dLat = lat - point.lat
    const dLon = lon - point.lon
    const w = 1 / (dLat * dLat + dLon * dLon + 1e-12)
    num += w * (point.ele ?? 0)
    den += w
  }
  const u = (lon - bbox.minLon) / Math.max(1e-12, bbox.maxLon - bbox.minLon)
  const v = (lat - bbox.minLat) / Math.max(1e-12, bbox.maxLat - bbox.minLat)
  return num / den + 35 * Math.sin(u * Math.PI) * Math.sin(v * Math.PI)
}

async function main() {
  const outPath = resolve(process.argv[2] || '/tmp/gpxto3mf-sample.3mf')
  const res = Math.max(8, Number(process.env.GPX_GRID || 128))
  const gpx = readFileSync(join(root, 'public/sample.gpx'), 'utf8')
  const track = parseTrack(gpx)
  const bbox = boundsOf(track.points, DEFAULTS.bboxPadPercent)
  const { widthM, heightM } = localExtent(bbox)
  const cols = res
  const rows = res
  const heights = new Float32Array(cols * rows)
  let minH = Infinity
  let maxH = -Infinity
  for (let j = 0; j < rows; j++) {
    const lat = bbox.minLat + ((bbox.maxLat - bbox.minLat) * j) / (rows - 1)
    for (let i = 0; i < cols; i++) {
      const lon = bbox.minLon + ((bbox.maxLon - bbox.minLon) * i) / (cols - 1)
      const h = heightAt(lat, lon, track.points, bbox)
      heights[j * cols + i] = h
      minH = Math.min(minH, h)
      maxH = Math.max(maxH, h)
    }
  }
  const height: HeightGrid = {
    cols,
    rows,
    heights,
    bbox,
    widthM,
    heightM,
    minH,
    maxH,
  }
  const rgb = new Uint8Array(cols * rows * 3)
  const span = Math.max(1e-6, maxH - minH)
  for (let k = 0; k < heights.length; k++) {
    const t = (heights[k] - minH) / span
    rgb[k * 3] = Math.round(80 + t * 150)
    rgb[k * 3 + 1] = Math.round(70 + (1 - t) * 90)
    rgb[k * 3 + 2] = Math.round(50 + t * 40)
  }
  const colors: ColorGrid = { cols, rows, rgb }
  const model = buildTerrainModel(height, colors, DEFAULT_PALETTE, track.points, {
    exaggeration: DEFAULTS.exaggeration,
    bedSizeMm: DEFAULTS.bedSizeMm,
    routeHeightMm: DEFAULTS.routeHeightMm,
    routeWidthMm: DEFAULTS.routeWidthMm,
    routeColorIndex: DEFAULT_PALETTE.colors.findIndex((c) => /route/i.test(c.name)),
    minColorRegionMm: DEFAULTS.minColorRegionMm,
  })
  const base = 2.5
  const halfW = (widthM * model.scaleMmPerM) / 2
  const halfH = (heightM * model.scaleMmPerM) / 2
  const pos = model.positions
  let maxEdge = 0
  let maxInterior = 0
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i]
    const y = pos[i + 1]
    const z = pos[i + 2]
    if (Math.abs(Math.abs(x) - halfW) < 0.25 && Math.abs(y) < halfH * 0.08) {
      if (z > maxEdge) maxEdge = z
    }
    if (Math.abs(x) < halfW * 0.15 && Math.abs(y) < halfH * 0.15 && z > maxInterior) {
      maxInterior = z
    }
  }
  if (maxEdge > base + 0.35) {
    throw new Error(`rim did not roll down to the base (edge z ${maxEdge.toFixed(2)} mm)`)
  }
  if (maxInterior < base + 1) {
    throw new Error(`interior relief collapsed (z ${maxInterior.toFixed(2)} mm)`)
  }
  console.log(
    `skirt rimZ=${maxEdge.toFixed(2)} mm interiorZ=${maxInterior.toFixed(2)} mm`,
  )

  const blob = await export3mf(model, track.name)
  const buf = Buffer.from(await blob.arrayBuffer())
  writeFileSync(outPath, buf)
  console.log(
    `wrote ${outPath} bytes=${buf.length} vertices=${model.positions.length / 3} tris=${model.indices.length / 3} materials=${model.materials.length}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
