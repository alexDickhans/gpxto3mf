import type { HeightGrid } from './dem'
import { sampleHeight } from './dem'
import type { ColorGrid } from './imagery'
import {
  enabledColorIndices,
  hexToLab,
  nearestPaletteIndex,
  type Palette,
} from './palette'
import { toLocalMeters, type LatLon } from './geo'
import { smoothCellMaterials } from './colorSmooth'

export type Vec3 = { x: number; y: number; z: number }

export type TerrainModel = {
  /** All vertices in mm, centered on XY, Z up from base */
  positions: Float32Array
  /** Triangle indices (uint32) */
  indices: Uint32Array
  /** Per-triangle material index into materials[] */
  triMaterials: Uint16Array
  materials: { name: string; hex: string }[]
  /** Usage counts aligned with materials */
  usageCounts: number[]
  extentMm: { x: number; y: number; z: number }
  scaleMmPerM: number
  northAngle: number
}

export type BuildOptions = {
  exaggeration: number
  bedSizeMm: number
  routeHeightMm: number
  routeWidthMm: number
  routeColorIndex: number
  /** Min printable color patch size in mm — speckles below this merge into neighbors */
  minColorRegionMm?: number
  baseThicknessMm?: number
  /** Inset distance over which the top surface rolls down to the base. */
  skirtMm?: number
}

/** Sample color grid onto mesh resolution (handles mismatched fetch sizes). */
function sampleColorAt(
  colors: ColorGrid,
  u: number,
  v: number,
): [number, number, number] {
  const x = Math.max(0, Math.min(colors.cols - 1, u * (colors.cols - 1)))
  const y = Math.max(0, Math.min(colors.rows - 1, v * (colors.rows - 1)))
  const i0 = Math.max(0, Math.min(colors.cols - 2, Math.floor(x)))
  const j0 = Math.max(0, Math.min(colors.rows - 2, Math.floor(y)))
  const fx = x - i0
  const fy = y - j0
  const pix = (i: number, j: number) => {
    const o = (j * colors.cols + i) * 3
    return [colors.rgb[o], colors.rgb[o + 1], colors.rgb[o + 2]] as const
  }
  const c00 = pix(i0, j0)
  const c10 = pix(i0 + 1, j0)
  const c01 = pix(i0, j0 + 1)
  const c11 = pix(i0 + 1, j0 + 1)
  const out: [number, number, number] = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    out[k] =
      c00[k] * (1 - fx) * (1 - fy) +
      c10[k] * fx * (1 - fy) +
      c01[k] * (1 - fx) * fy +
      c11[k] * fx * fy
  }
  return out
}

export function buildTerrainModel(
  height: HeightGrid,
  colors: ColorGrid,
  palette: Palette,
  track: LatLon[],
  opts: BuildOptions,
): TerrainModel {
  const baseThicknessMm = opts.baseThicknessMm ?? 2.5
  const { cols, rows, heights, widthM, heightM, minH, bbox } = height

  const longestM = Math.max(widthM, heightM)
  const scale = opts.bedSizeMm / longestM // mm per meter of ground

  const activeIdxs = enabledColorIndices(palette)
  const paletteLabs = activeIdxs.map((i) => hexToLab(palette.colors[i].hex))

  // Cell material from colors resampled onto this mesh grid
  const cellW = cols - 1
  const cellH = rows - 1
  let cellMat = new Uint16Array(cellW * cellH)
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      const samples = [
        [i, j],
        [i + 1, j],
        [i, j + 1],
        [i + 1, j + 1],
      ] as const
      let r = 0
      let g = 0
      let b = 0
      for (const [ci, cj] of samples) {
        const u = cols <= 1 ? 0 : ci / (cols - 1)
        const v = rows <= 1 ? 0 : cj / (rows - 1)
        const c = sampleColorAt(colors, u, v)
        r += c[0]
        g += c[1]
        b += c[2]
      }
      const local = nearestPaletteIndex([r / 4, g / 4, b / 4], paletteLabs)
      cellMat[j * cellW + i] = activeIdxs[local]
    }
  }

  // Merge speckles so AMS contours are print-friendly contiguous regions
  cellMat = new Uint16Array(
    smoothCellMaterials(
      cellMat,
      cellW,
      cellH,
      opts.bedSizeMm,
      opts.minColorRegionMm ?? 3,
    ),
  )

  const usedTerrain = new Set<number>()
  for (const m of cellMat) usedTerrain.add(m)

  const materials: { name: string; hex: string }[] = []
  const terrainToMat = new Map<number, number>()
  for (const idx of [...usedTerrain].sort((a, b) => a - b)) {
    terrainToMat.set(idx, materials.length)
    const { name, hex } = palette.colors[idx]
    materials.push({ name, hex })
  }

  const routePalIdx = Math.max(
    0,
    Math.min(palette.colors.length - 1, opts.routeColorIndex),
  )
  let routeMatIdx = materials.findIndex(
    (m) => m.hex.toUpperCase() === palette.colors[routePalIdx].hex.toUpperCase(),
  )
  if (routeMatIdx < 0) {
    routeMatIdx = materials.length
    const { name, hex } = palette.colors[routePalIdx]
    materials.push({ name, hex })
  }

  const elevMm = (h: number) =>
    (h - minH) * scale * opts.exaggeration + baseThicknessMm

  const halfW = (widthM * scale) / 2
  const halfH = (heightM * scale) / 2
  const minHalf = Math.min(halfW, halfH)
  const skirtMm = Math.min(
    opts.skirtMm ?? Math.min(18, Math.max(8, minHalf * 0.16)),
    minHalf * 0.45,
  )

  /**
   * Quarter-circle roll: 1 in the interior, 0 on the perimeter, with a
   * vertical tangent at the rim so the surface wraps down into the side wall.
   */
  const roll = (dist: number) => {
    if (!(skirtMm > 0) || dist >= skirtMm) return 1
    if (dist <= 0) return 0
    const u = 1 - dist / skirtMm
    return Math.sqrt(Math.max(0, 1 - u * u))
  }
  const reliefFactor = (x: number, y: number) =>
    roll(halfW - Math.abs(x)) * roll(halfH - Math.abs(y))
  const surfaceZ = (x: number, y: number, h: number) => {
    const z = elevMm(h)
    const factor = reliefFactor(x, y)
    return baseThicknessMm + (z - baseThicknessMm) * factor
  }

  // Regular grid in local meters — avoids lat/lon re-projection jitter per vertex
  const topCount = cols * rows
  const vertCount = topCount * 2
  const positions = new Float32Array(vertCount * 3)

  for (let j = 0; j < rows; j++) {
    const v = rows <= 1 ? 0.5 : j / (rows - 1)
    for (let i = 0; i < cols; i++) {
      const u = cols <= 1 ? 0.5 : i / (cols - 1)
      const xm = (u - 0.5) * widthM * scale
      const ym = (v - 0.5) * heightM * scale
      const h = heights[j * cols + i]
      const zm = surfaceZ(xm, ym, h)
      const ti = (j * cols + i) * 3
      positions[ti] = xm
      positions[ti + 1] = ym
      positions[ti + 2] = zm
      const bi = (topCount + j * cols + i) * 3
      positions[bi] = xm
      positions[bi + 1] = ym
      positions[bi + 2] = 0
    }
  }

  // Expandable vertex buffer (terrain first, route appended)
  const posList = Array.from(positions)
  const indices: number[] = []
  const triMaterials: number[] = []

  const addTri = (a: number, b: number, c: number, mat: number) => {
    const ax = posList[a * 3]
    const ay = posList[a * 3 + 1]
    const az = posList[a * 3 + 2]
    const bx = posList[b * 3]
    const by = posList[b * 3 + 1]
    const bz = posList[b * 3 + 2]
    const cx = posList[c * 3]
    const cy = posList[c * 3 + 1]
    const cz = posList[c * 3 + 2]
    if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) return
    const abx = bx - ax
    const aby = by - ay
    const abz = bz - az
    const acx = cx - ax
    const acy = cy - ay
    const acz = cz - az
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx
    if (nx * nx + ny * ny + nz * nz < 1e-12) return
    indices.push(a, b, c)
    triMaterials.push(mat)
  }

  const pushV = (x: number, y: number, z: number) => {
    const i = posList.length / 3
    posList.push(x, y, z)
    return i
  }

  // Top surface
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      const mat = terrainToMat.get(cellMat[j * cellW + i]) ?? 0
      addTri(a, b, d, mat)
      addTri(a, d, c, mat)
    }
  }

  // Bottom
  const bottomMat = 0
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = topCount + j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      addTri(a, d, b, bottomMat)
      addTri(a, c, d, bottomMat)
    }
  }

  // Short vertical rim: the rolled skirt meets the wall at base thickness
  // and the wall drops to the flat z=0 base. Same footprint, no gap.
  const wallMat = 0
  for (let i = 0; i < cols - 1; i++) {
    const t0 = i
    const t1 = i + 1
    addTri(t0, topCount + i, topCount + i + 1, wallMat)
    addTri(t0, topCount + i + 1, t1, wallMat)
    const n0 = (rows - 1) * cols + i
    const n1 = n0 + 1
    addTri(n0, topCount + n1, topCount + n0, wallMat)
    addTri(n0, n1, topCount + n1, wallMat)
  }
  for (let j = 0; j < rows - 1; j++) {
    const t0 = j * cols
    const t1 = (j + 1) * cols
    addTri(t0, topCount + t1, topCount + t0, wallMat)
    addTri(t0, t1, topCount + t1, wallMat)
    const e0 = j * cols + (cols - 1)
    const e1 = (j + 1) * cols + (cols - 1)
    addTri(e0, topCount + e0, topCount + e1, wallMat)
    addTri(e0, topCount + e1, e1, wallMat)
  }

  // Route — closed rectangular tube (sides + caps, or looped join)
  const routeHalfW = opts.routeWidthMm / 2
  const routeH = opts.routeHeightMm
  const routeRaw: { x: number; y: number; zTop: number }[] = []
  for (const p of track) {
    const { x, y } = toLocalMeters(p.lat, p.lon, bbox)
    const xm = (x - widthM / 2) * scale
    const ym = (y - heightM / 2) * scale
    const zTop = surfaceZ(xm, ym, sampleHeight(height, p.lat, p.lon)) + routeH
    routeRaw.push({ x: xm, y: ym, zTop })
  }

  const routePts: typeof routeRaw = []
  for (const p of routeRaw) {
    const prev = routePts[routePts.length - 1]
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < 0.15) continue
    routePts.push(p)
  }

  let pts = routePts
  const maxRoute = Math.min(600, Math.max(80, Math.floor(cols * 1.5)))
  if (pts.length > maxRoute) {
    const step = Math.ceil(pts.length / maxRoute)
    pts = pts.filter((_, i) => i % step === 0 || i === pts.length - 1)
  }

  // Closed loop if endpoints meet
  let routeClosed = false
  if (pts.length >= 3) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) < Math.max(routeHalfW * 2, 0.8)) {
      pts = pts.slice(0, -1)
      routeClosed = pts.length >= 3
    }
  }

  if (pts.length >= 3) {
    const zs = pts.map((p) => p.zTop)
    for (let i = 1; i < pts.length - 1; i++) {
      pts[i] = {
        ...pts[i],
        zTop: zs[i - 1] * 0.25 + zs[i] * 0.5 + zs[i + 1] * 0.25,
      }
    }
    if (routeClosed) {
      pts[0] = {
        ...pts[0],
        zTop:
          pts[pts.length - 1].zTop * 0.25 +
          zs[0] * 0.5 +
          pts[1].zTop * 0.25,
      }
    }
  }

  if (pts.length >= 2) {
    type Ring = { bl: number; br: number; tl: number; tr: number }
    const rings: Ring[] = []
    const nPts = pts.length

    for (let i = 0; i < nPts; i++) {
      const p = pts[i]
      const p0 = pts[routeClosed ? (i - 1 + nPts) % nPts : Math.max(0, i - 1)]
      const p1 =
        pts[routeClosed ? (i + 1) % nPts : Math.min(nPts - 1, i + 1)]
      let dx = p1.x - p0.x
      let dy = p1.y - p0.y
      let len = Math.hypot(dx, dy)
      if (len < 1e-6) {
        dx = 1
        dy = 0
        len = 1
      }
      const nx = (-dy / len) * routeHalfW
      const ny = (dx / len) * routeHalfW
      const zBot = p.zTop - routeH
      rings.push({
        bl: pushV(p.x + nx, p.y + ny, zBot),
        br: pushV(p.x - nx, p.y - ny, zBot),
        tl: pushV(p.x + nx, p.y + ny, p.zTop),
        tr: pushV(p.x - nx, p.y - ny, p.zTop),
      })
    }

    const m = routeMatIdx
    const link = (a: Ring, b: Ring) => {
      addTri(a.tl, a.tr, b.tr, m)
      addTri(a.tl, b.tr, b.tl, m)
      addTri(a.bl, b.br, a.br, m)
      addTri(a.bl, b.bl, b.br, m)
      addTri(a.bl, a.tl, b.tl, m)
      addTri(a.bl, b.tl, b.bl, m)
      addTri(a.br, b.br, b.tr, m)
      addTri(a.br, b.tr, a.tr, m)
    }

    for (let i = 0; i < rings.length - 1; i++) link(rings[i], rings[i + 1])

    if (routeClosed) {
      // Torus join — no caps needed
      link(rings[rings.length - 1], rings[0])
    } else {
      // End caps close the tube (were missing → open non-manifold mesh)
      const s = rings[0]
      const e = rings[rings.length - 1]
      addTri(s.bl, s.br, s.tr, m)
      addTri(s.bl, s.tr, s.tl, m)
      addTri(e.bl, e.tl, e.tr, m)
      addTri(e.bl, e.tr, e.br, m)
    }
  }

  const usageCounts = materials.map(() => 0)
  for (const tm of triMaterials) usageCounts[tm]++

  const finalPositions = new Float32Array(posList)
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < finalPositions.length; i += 3) {
    minX = Math.min(minX, finalPositions[i])
    maxX = Math.max(maxX, finalPositions[i])
    minY = Math.min(minY, finalPositions[i + 1])
    maxY = Math.max(maxY, finalPositions[i + 1])
    minZ = Math.min(minZ, finalPositions[i + 2])
    maxZ = Math.max(maxZ, finalPositions[i + 2])
  }

  return {
    positions: finalPositions,
    indices: new Uint32Array(indices),
    triMaterials: new Uint16Array(triMaterials),
    materials,
    usageCounts,
    extentMm: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    scaleMmPerM: scale,
    northAngle: 0,
  }
}
