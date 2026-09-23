import type { HeightGrid } from './dem'
import type { ColorGrid } from './imagery'
import {
  enabledColorIndices,
  hexToLab,
  nearestPaletteIndex,
  type Palette,
} from './palette'
import { toLocalMeters, type LatLon } from './geo'
import { smoothCellMaterials, smoothColorBoundary } from './colorSmooth'

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
  /** 0 keeps pixel edges, 1 rounds color borders into smooth contours */
  colorEdgeSmooth?: number
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

  // Face-connected regions of one color. Regions that only meet at a corner
  // get their own vertex copies so that shared corner column is not a
  // non-manifold edge.
  const cellComp = new Int32Array(cellW * cellH)
  cellComp.fill(-1)
  let compCount = 0
  const stack: number[] = []
  for (let start = 0; start < cellComp.length; start++) {
    if (cellComp[start] >= 0) continue
    const color = cellMat[start]
    const id = compCount++
    stack.push(start)
    cellComp[start] = id
    while (stack.length) {
      const cur = stack.pop()!
      const cj = Math.floor(cur / cellW)
      const ci = cur - cj * cellW
      const neighbors = [
        ci - 1, cj, ci + 1, cj, ci, cj - 1, ci, cj + 1,
      ]
      for (let n = 0; n < neighbors.length; n += 2) {
        const ni = neighbors[n]
        const nj = neighbors[n + 1]
        if (ni < 0 || nj < 0 || ni >= cellW || nj >= cellH) continue
        const nk = nj * cellW + ni
        if (cellComp[nk] >= 0 || cellMat[nk] !== color) continue
        cellComp[nk] = id
        stack.push(nk)
      }
    }
  }

  const smoothX = new Float32Array(topCount)
  const smoothY = new Float32Array(topCount)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const vi = j * cols + i
      const o = vi * 3
      smoothX[vi] = positions[o]
      smoothY[vi] = positions[o + 1]
    }
  }
  smoothColorBoundary(
    smoothX,
    smoothY,
    cellMat,
    cols,
    rows,
    opts.colorEdgeSmooth ?? 0.75,
  )

  const vertOf = new Map<number, number>()
  const corner = (gridIndex: number, component: number) => {
    const key = component * vertCount + gridIndex
    const found = vertOf.get(key)
    if (found !== undefined) return found
    const column = gridIndex >= topCount ? gridIndex - topCount : gridIndex
    const o = gridIndex * 3
    const id = pushV(smoothX[column], smoothY[column], posList[o + 2])
    vertOf.set(key, id)
    return id
  }

  // One solid per color: each cell is a column from z=0 to the rolled
  // surface. Walls are emitted only on a different color or the map edge.
  const topOf = (i: number, j: number) => j * cols + i
  const botOf = (i: number, j: number) => topCount + j * cols + i
  const sameColor = (i: number, j: number, ni: number, nj: number) => {
    if (ni < 0 || nj < 0 || ni >= cellW || nj >= cellH) return false
    return cellMat[nj * cellW + ni] === cellMat[j * cellW + i]
  }

  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      const mat = terrainToMat.get(cellMat[j * cellW + i]) ?? 0
      const component = cellComp[j * cellW + i]
      const a = corner(topOf(i, j), component)
      const b = corner(topOf(i + 1, j), component)
      const c = corner(topOf(i, j + 1), component)
      const d = corner(topOf(i + 1, j + 1), component)
      const aB = corner(botOf(i, j), component)
      const bB = corner(botOf(i + 1, j), component)
      const cB = corner(botOf(i, j + 1), component)
      const dB = corner(botOf(i + 1, j + 1), component)

      addTri(a, b, d, mat)
      addTri(a, d, c, mat)
      addTri(aB, dB, bB, mat)
      addTri(aB, cB, dB, mat)

      const wall = (t0: number, t1: number, b0: number, b1: number) => {
        addTri(t0, b0, b1, mat)
        addTri(t0, b1, t1, mat)
      }
      if (!sameColor(i, j, i, j - 1)) wall(a, b, aB, bB)
      if (!sameColor(i, j, i + 1, j)) wall(b, d, bB, dB)
      if (!sameColor(i, j, i, j + 1)) wall(d, c, dB, cB)
      if (!sameColor(i, j, i - 1, j)) wall(c, a, cB, aB)
    }
  }

  // Route — closed rectangular tube seated on the triangulated surface.
  const routeHalfW = opts.routeWidthMm / 2
  const routeH = opts.routeHeightMm
  const spanX = widthM * scale
  const spanY = heightM * scale
  const meshZ = (x: number, y: number) => {
    if (cols < 2 || rows < 2 || spanX <= 0 || spanY <= 0) return baseThicknessMm
    const u = x / spanX + 0.5
    const v = y / spanY + 0.5
    const gx = Math.min(cols - 1 - 1e-6, Math.max(0, u * (cols - 1)))
    const gy = Math.min(rows - 1 - 1e-6, Math.max(0, v * (rows - 1)))
    const i0 = Math.floor(gx)
    const j0 = Math.floor(gy)
    const fx = gx - i0
    const fy = gy - j0
    const zAt = (ci: number, cj: number) => positions[(cj * cols + ci) * 3 + 2]
    const z00 = zAt(i0, j0)
    const z10 = zAt(i0 + 1, j0)
    const z01 = zAt(i0, j0 + 1)
    const z11 = zAt(i0 + 1, j0 + 1)
    // Match the cell split (a,b,d) / (a,d,c), not a bilinear patch.
    if (fx >= fy) return z00 * (1 - fx) + z10 * (fx - fy) + z11 * fy
    return z00 * (1 - fy) + z11 * fx + z01 * (fy - fx)
  }

  const routeRaw: { x: number; y: number }[] = []
  for (const p of track) {
    const { x, y } = toLocalMeters(p.lat, p.lon, bbox)
    const xm = (x - widthM / 2) * scale
    const ym = (y - heightM / 2) * scale
    const prev = routeRaw[routeRaw.length - 1]
    if (prev && Math.hypot(xm - prev.x, ym - prev.y) < 0.05) continue
    routeRaw.push({ x: xm, y: ym })
  }

  const cellMm = Math.min(
    spanX / Math.max(1, cols - 1),
    spanY / Math.max(1, rows - 1),
  )
  let pts = resamplePolyline(routeRaw, Math.max(0.35, cellMm * 0.85), 8000)

  let routeClosed = false
  if (pts.length >= 3) {
    const a = pts[0]
    const b = pts[pts.length - 1]
    if (Math.hypot(a.x - b.x, a.y - b.y) < Math.max(routeHalfW * 2, 0.8)) {
      pts = pts.slice(0, -1)
      routeClosed = pts.length >= 3
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
      const zSurf = Math.min(
        meshZ(p.x, p.y),
        meshZ(p.x + nx, p.y + ny),
        meshZ(p.x - nx, p.y - ny),
      )
      const zBot = zSurf - 0.35
      const zTop = zBot + routeH
      rings.push({
        bl: pushV(p.x + nx, p.y + ny, zBot),
        br: pushV(p.x - nx, p.y - ny, zBot),
        tl: pushV(p.x + nx, p.y + ny, zTop),
        tr: pushV(p.x - nx, p.y - ny, zTop),
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

function resamplePolyline(
  points: { x: number; y: number }[],
  spacing: number,
  maxPoints: number,
) {
  if (points.length < 2) return points
  const cumulative = [0]
  for (let i = 1; i < points.length; i++) {
    const prev = cumulative[i - 1]
    cumulative.push(
      prev +
        Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
    )
  }
  const length = cumulative[cumulative.length - 1]
  if (length < 1e-4) return [points[0]]
  let count = Math.max(2, Math.ceil(length / Math.max(0.05, spacing)) + 1)
  if (count > maxPoints) count = maxPoints
  const step = length / (count - 1)
  const out: { x: number; y: number }[] = []
  let seg = 1
  for (let k = 0; k < count; k++) {
    const dist = k === count - 1 ? length : k * step
    while (seg < cumulative.length - 1 && cumulative[seg] < dist) seg++
    const span = cumulative[seg] - cumulative[seg - 1]
    const t = span < 1e-9 ? 0 : (dist - cumulative[seg - 1]) / span
    const a = points[seg - 1]
    const b = points[seg]
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  }
  return out
}
