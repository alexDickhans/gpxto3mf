import type { HeightGrid } from './dem'
import type { ColorGrid } from './imagery'
import {
  enabledColorIndices,
  hexToLab,
  matchTerrainCell,
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

/** Long side of the height grid that is actually meshed. Fetch may be larger. */
export const MESH_GRID_MAX = 192

const COLOR_MATCH_MAX = 512

function scaledSize(
  srcCols: number,
  srcRows: number,
  maxLong: number,
  minSide: number,
): { cols: number; rows: number } | null {
  const long = Math.max(srcCols, srcRows)
  if (long <= maxLong) return null
  if (srcCols >= srcRows) {
    return {
      cols: maxLong,
      rows: Math.max(minSide, Math.round((srcRows * maxLong) / srcCols)),
    }
  }
  return {
    rows: maxLong,
    cols: Math.max(minSide, Math.round((srcCols * maxLong) / srcRows)),
  }
}

export function downsampleHeightGrid(height: HeightGrid, maxLong: number): HeightGrid {
  const size = scaledSize(height.cols, height.rows, maxLong, 8)
  if (!size) return height
  const { cols, rows } = size
  const heights = new Float32Array(cols * rows)
  let minH = Infinity
  let maxH = -Infinity
  for (let j = 0; j < rows; j++) {
    const y0 = Math.floor((j * height.rows) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * height.rows) / rows))
    for (let i = 0; i < cols; i++) {
      const x0 = Math.floor((i * height.cols) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * height.cols) / cols))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        const row = y * height.cols
        for (let x = x0; x < x1; x++) {
          sum += height.heights[row + x]
          n++
        }
      }
      const h = sum / n
      heights[j * cols + i] = h
      if (h < minH) minH = h
      if (h > maxH) maxH = h
    }
  }
  return {
    cols,
    rows,
    heights,
    bbox: height.bbox,
    widthM: height.widthM,
    heightM: height.heightM,
    minH,
    maxH,
  }
}

export function downsampleColorGrid(colors: ColorGrid, maxLong: number): ColorGrid {
  const size = scaledSize(colors.cols, colors.rows, maxLong, 2)
  if (!size) return colors
  const { cols, rows } = size
  const rgb = new Uint8Array(cols * rows * 3)
  for (let j = 0; j < rows; j++) {
    const y0 = Math.floor((j * colors.rows) / rows)
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * colors.rows) / rows))
    for (let i = 0; i < cols; i++) {
      const x0 = Math.floor((i * colors.cols) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * colors.cols) / cols))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * colors.cols + x) * 3
          r += colors.rgb[o]
          g += colors.rgb[o + 1]
          b += colors.rgb[o + 2]
          n++
        }
      }
      const o = (j * cols + i) * 3
      rgb[o] = Math.round(r / n)
      rgb[o + 1] = Math.round(g / n)
      rgb[o + 2] = Math.round(b / n)
    }
  }
  return { cols, rows, rgb, label: colors.label }
}

function sampleElev01(
  heights: Float32Array,
  cols: number,
  rows: number,
  minH: number,
  maxH: number,
  u: number,
  v: number,
): number {
  const span = maxH - minH
  if (!(span > 0) || cols < 1 || rows < 1) return 0
  const x = Math.max(0, Math.min(cols - 1, u * Math.max(0, cols - 1)))
  const y = Math.max(0, Math.min(rows - 1, v * Math.max(0, rows - 1)))
  const i0 = Math.min(cols - 1, Math.floor(x))
  const j0 = Math.min(rows - 1, Math.floor(y))
  const i1 = Math.min(cols - 1, i0 + 1)
  const j1 = Math.min(rows - 1, j0 + 1)
  const fx = x - i0
  const fy = y - j0
  const h00 = heights[j0 * cols + i0]
  const h10 = heights[j0 * cols + i1]
  const h01 = heights[j1 * cols + i0]
  const h11 = heights[j1 * cols + i1]
  const h =
    h00 * (1 - fx) * (1 - fy) +
    h10 * fx * (1 - fy) +
    h01 * (1 - fx) * fy +
    h11 * fx * fy
  const elev = (h - minH) / span
  if (elev < 0) return 0
  if (elev > 1) return 1
  return elev
}

export function buildTerrainModel(
  heightIn: HeightGrid,
  colorsIn: ColorGrid,
  palette: Palette,
  track: LatLon[],
  opts: BuildOptions,
): TerrainModel {
  const baseThicknessMm = opts.baseThicknessMm ?? 2.5
  const height = downsampleHeightGrid(heightIn, MESH_GRID_MAX)
  const colors = downsampleColorGrid(colorsIn, COLOR_MATCH_MAX)
  const { cols, rows, heights, widthM, heightM, minH, maxH, bbox } = height

  const longestM = Math.max(widthM, heightM)
  const scale = opts.bedSizeMm / longestM // mm per meter of ground

  const activeIdxs = enabledColorIndices(palette)
  const paletteLabs = activeIdxs.map((i) => hexToLab(palette.colors[i].hex))
  const lands = activeIdxs.map((i) => palette.colors[i].land)

  const qCols = colors.cols
  const qRows = colors.rows
  const matched = new Uint16Array(qCols * qRows)
  for (let j = 0; j < qRows; j++) {
    const v = qRows <= 1 ? 0.5 : j / (qRows - 1)
    for (let i = 0; i < qCols; i++) {
      const u = qCols <= 1 ? 0.5 : i / (qCols - 1)
      const o = (j * qCols + i) * 3
      const local = matchTerrainCell(
        [colors.rgb[o], colors.rgb[o + 1], colors.rgb[o + 2]],
        sampleElev01(heights, cols, rows, minH, maxH, u, v),
        paletteLabs,
        lands,
      )
      matched[j * qCols + i] = activeIdxs[local]
    }
  }

  const cellW = cols - 1
  const cellH = rows - 1
  let cellMat = new Uint16Array(cellW * cellH)
  const histSize = Math.max(1, palette.colors.length)
  const hist = new Uint32Array(histSize)
  const histTouched: number[] = []
  let voteBest = 0
  let voteN = 0
  const beginVote = () => {
    histTouched.length = 0
    voteBest = 0
    voteN = 0
  }
  const addVote = (v: number) => {
    const n = ++hist[v]
    if (n === 1) histTouched.push(v)
    if (n > voteN || (n === voteN && v < voteBest)) {
      voteN = n
      voteBest = v
    }
  }
  const endVote = () => {
    const result = voteBest
    for (let t = 0; t < histTouched.length; t++) hist[histTouched[t]] = 0
    return result
  }
  const colorCoarser = qCols < cols || qRows < rows

  for (let j = 0; j < cellH; j++) {
    const v0 = rows <= 1 ? 0 : j / (rows - 1)
    const v1 = rows <= 1 ? 1 : (j + 1) / (rows - 1)
    let cj0 = Math.floor(v0 * qRows)
    let cj1 = Math.ceil(v1 * qRows)
    if (cj0 < 0) cj0 = 0
    if (cj0 > qRows - 1) cj0 = qRows - 1
    if (cj1 < cj0 + 1) cj1 = cj0 + 1
    if (cj1 > qRows) cj1 = qRows
    for (let i = 0; i < cellW; i++) {
      const u0 = cols <= 1 ? 0 : i / (cols - 1)
      const u1 = cols <= 1 ? 1 : (i + 1) / (cols - 1)
      let ci0 = Math.floor(u0 * qCols)
      let ci1 = Math.ceil(u1 * qCols)
      if (ci0 < 0) ci0 = 0
      if (ci0 > qCols - 1) ci0 = qCols - 1
      if (ci1 < ci0 + 1) ci1 = ci0 + 1
      if (ci1 > qCols) ci1 = qCols
      beginVote()
      for (let cj = cj0; cj < cj1; cj++) {
        const row = cj * qCols
        for (let ci = ci0; ci < ci1; ci++) addVote(matched[row + ci])
      }
      if (colorCoarser) {
        const corners = [u0, v0, u1, v0, u0, v1, u1, v1]
        for (let k = 0; k < 4; k++) {
          let x = Math.round(corners[k * 2] * (qCols - 1))
          let y = Math.round(corners[k * 2 + 1] * (qRows - 1))
          if (x < 0) x = 0
          if (x > qCols - 1) x = qCols - 1
          if (y < 0) y = 0
          if (y > qRows - 1) y = qRows - 1
          addVote(matched[y * qCols + x])
        }
      }
      cellMat[j * cellW + i] = endVote()
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

  const topCount = cols * rows
  const vertCount = topCount * 2
  const gridPos = new Float32Array(vertCount * 3)

  for (let j = 0; j < rows; j++) {
    const v = rows <= 1 ? 0.5 : j / (rows - 1)
    for (let i = 0; i < cols; i++) {
      const u = cols <= 1 ? 0.5 : i / (cols - 1)
      const xm = (u - 0.5) * widthM * scale
      const ym = (v - 0.5) * heightM * scale
      const h = heights[j * cols + i]
      const zm = surfaceZ(xm, ym, h)
      const ti = (j * cols + i) * 3
      gridPos[ti] = xm
      gridPos[ti + 1] = ym
      gridPos[ti + 2] = zm
      const bi = (topCount + j * cols + i) * 3
      gridPos[bi] = xm
      gridPos[bi + 1] = ym
      gridPos[bi + 2] = 0
    }
  }

  let posBuf = new Float32Array(Math.max(1024, vertCount * 3))
  let posLen = 0
  const pushV = (x: number, y: number, z: number) => {
    if (posLen + 3 > posBuf.length) {
      const next = new Float32Array(posBuf.length * 2)
      next.set(posBuf)
      posBuf = next
    }
    const id = posLen / 3
    posBuf[posLen++] = x
    posBuf[posLen++] = y
    posBuf[posLen++] = z
    return id
  }

  let indexCap = Math.max(64, cellW * cellH * 12 + 20_000)
  let indexBuf = new Uint32Array(indexCap * 3)
  let triBuf = new Uint16Array(indexCap)
  let triCount = 0
  const addTri = (a: number, b: number, c: number, mat: number) => {
    const ax = posBuf[a * 3]
    const ay = posBuf[a * 3 + 1]
    const az = posBuf[a * 3 + 2]
    const bx = posBuf[b * 3]
    const by = posBuf[b * 3 + 1]
    const bz = posBuf[b * 3 + 2]
    const cx = posBuf[c * 3]
    const cy = posBuf[c * 3 + 1]
    const cz = posBuf[c * 3 + 2]
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
    if (triCount >= indexCap) {
      indexCap *= 2
      const nextI = new Uint32Array(indexCap * 3)
      nextI.set(indexBuf)
      indexBuf = nextI
      const nextT = new Uint16Array(indexCap)
      nextT.set(triBuf)
      triBuf = nextT
    }
    const o = triCount * 3
    indexBuf[o] = a
    indexBuf[o + 1] = b
    indexBuf[o + 2] = c
    triBuf[triCount] = mat
    triCount++
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
      const neighbors = [ci - 1, cj, ci + 1, cj, ci, cj - 1, ci, cj + 1]
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

  const compCounts = new Uint32Array(compCount)
  for (let k = 0; k < cellComp.length; k++) compCounts[cellComp[k]]++
  const compStart = new Uint32Array(compCount)
  let compFilled = 0
  for (let c = 0; c < compCount; c++) {
    compStart[c] = compFilled
    compFilled += compCounts[c]
  }
  const compCells = new Int32Array(cellComp.length)
  const compCursor = new Uint32Array(compStart)
  for (let k = 0; k < cellComp.length; k++) {
    const c = cellComp[k]
    compCells[compCursor[c]++] = k
  }

  const smoothX = new Float32Array(topCount)
  const smoothY = new Float32Array(topCount)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const vi = j * cols + i
      const o = vi * 3
      smoothX[vi] = gridPos[o]
      smoothY[vi] = gridPos[o + 1]
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

  // 0 means unset. Stored value is vertex id + 1. Cleared per component.
  const remap = new Int32Array(vertCount)
  const touched: number[] = []
  const corner = (gridIndex: number) => {
    const slot = remap[gridIndex]
    if (slot !== 0) return slot - 1
    const column = gridIndex >= topCount ? gridIndex - topCount : gridIndex
    const id = pushV(smoothX[column], smoothY[column], gridPos[gridIndex * 3 + 2])
    remap[gridIndex] = id + 1
    touched.push(gridIndex)
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

  for (let comp = 0; comp < compCount; comp++) {
    const begin = compStart[comp]
    const end = begin + compCounts[comp]
    for (let n = begin; n < end; n++) {
      const cell = compCells[n]
      const j = Math.floor(cell / cellW)
      const i = cell - j * cellW
      const mat = terrainToMat.get(cellMat[cell]) ?? 0
      const a = corner(topOf(i, j))
      const b = corner(topOf(i + 1, j))
      const c = corner(topOf(i, j + 1))
      const d = corner(topOf(i + 1, j + 1))
      const aB = corner(botOf(i, j))
      const bB = corner(botOf(i + 1, j))
      const cB = corner(botOf(i, j + 1))
      const dB = corner(botOf(i + 1, j + 1))

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
    for (let t = 0; t < touched.length; t++) remap[touched[t]] = 0
    touched.length = 0
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
    const zAt = (ci: number, cj: number) => gridPos[(cj * cols + ci) * 3 + 2]
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

  let pts = resamplePolyline(routeRaw, Math.max(1.2, opts.routeWidthMm), 1500)

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
      const p1 = pts[routeClosed ? (i + 1) % nPts : Math.min(nPts - 1, i + 1)]
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
      link(rings[rings.length - 1], rings[0])
    } else {
      const s = rings[0]
      const e = rings[rings.length - 1]
      addTri(s.bl, s.br, s.tr, m)
      addTri(s.bl, s.tr, s.tl, m)
      addTri(e.bl, e.tl, e.tr, m)
      addTri(e.bl, e.tr, e.br, m)
    }
  }

  const usageCounts = materials.map(() => 0)
  for (let t = 0; t < triCount; t++) usageCounts[triBuf[t]]++

  const finalPositions = posBuf.slice(0, posLen)
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
    indices: indexBuf.slice(0, triCount * 3),
    triMaterials: triBuf.slice(0, triCount),
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
      prev + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
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
