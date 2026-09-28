import type { HeightGrid } from './dem'
import type { ColorGrid } from './imagery'
import {
  enabledColorIndices,
  hexToLab,
  nearestLabIndex,
  rgbToLab,
  type Palette,
} from './palette'
import { toLocalMeters, type LatLon } from './geo'
import { smoothCellMaterials, smoothColorBoundary } from './colorSmooth'
import type { ColorMode } from './defaults'

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
  /** Signed volume of every solid, mm³ (solid — before slicer infill) */
  volumeMm3: number
  /** Samples on a side actually meshed (grids may be denser) */
  meshResolution: number
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
  /**
   * Depth of the per-color shell in mm. Below it the model is one solid in the
   * dominant color, so AMS swaps are confined to the top layers. 0 = color the
   * full depth (one closed solid per color, floor to summit).
   */
  colorShellMm?: number
  /** How cell colors are chosen (imagery hue, elevation bands, or a mix) */
  colorMode?: ColorMode
  /** Mesh at most this many samples on a side; grids are resampled down to it. */
  meshResolution?: number
  /** Inset distance over which the top surface rolls down to the base. */
  skirtMm?: number
}

/**
 * Box-average index ranges mapping a `target`-sample axis onto a `src`-sample
 * axis. Averaging (not point sampling) keeps a 4096² fetch from aliasing into
 * a 384² preview mesh.
 */
function boxRanges(src: number, target: number): Int32Array {
  const ranges = new Int32Array(target * 2)
  const step = (src - 1) / Math.max(1, target - 1)
  const half = step / 2
  for (let i = 0; i < target; i++) {
    const center = i * step
    ranges[i * 2] = Math.max(0, Math.round(center - half))
    ranges[i * 2 + 1] = Math.min(src - 1, Math.round(center + half))
  }
  return ranges
}

export function resampleHeightGrid(grid: HeightGrid, n: number): HeightGrid {
  if (n >= grid.cols || n >= grid.rows || n < 2) return grid
  const xs = boxRanges(grid.cols, n)
  const ys = boxRanges(grid.rows, n)
  const heights = new Float32Array(n * n)
  let minH = Infinity
  let maxH = -Infinity
  for (let j = 0; j < n; j++) {
    const j0 = ys[j * 2]
    const j1 = ys[j * 2 + 1]
    for (let i = 0; i < n; i++) {
      const i0 = xs[i * 2]
      const i1 = xs[i * 2 + 1]
      let sum = 0
      let count = 0
      for (let jj = j0; jj <= j1; jj++) {
        const row = jj * grid.cols
        for (let ii = i0; ii <= i1; ii++) {
          sum += grid.heights[row + ii]
          count++
        }
      }
      const h = count > 0 ? sum / count : 0
      heights[j * n + i] = h
      if (h < minH) minH = h
      if (h > maxH) maxH = h
    }
  }
  return { ...grid, cols: n, rows: n, heights, minH, maxH }
}

export function resampleColorGrid(grid: ColorGrid, n: number): ColorGrid {
  if (n >= grid.cols || n >= grid.rows || n < 2) return grid
  const xs = boxRanges(grid.cols, n)
  const ys = boxRanges(grid.rows, n)
  const rgb = new Uint8Array(n * n * 3)
  for (let j = 0; j < n; j++) {
    const j0 = ys[j * 2]
    const j1 = ys[j * 2 + 1]
    for (let i = 0; i < n; i++) {
      const i0 = xs[i * 2]
      const i1 = xs[i * 2 + 1]
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let jj = j0; jj <= j1; jj++) {
        const row = jj * grid.cols
        for (let ii = i0; ii <= i1; ii++) {
          const o = (row + ii) * 3
          r += grid.rgb[o]
          g += grid.rgb[o + 1]
          b += grid.rgb[o + 2]
          count++
        }
      }
      const o = (j * n + i) * 3
      rgb[o] = r / count
      rgb[o + 1] = g / count
      rgb[o + 2] = b / count
    }
  }
  return { ...grid, cols: n, rows: n, rgb }
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

/** Elevation quantile band (0 … bandCount-1) for every cell, via a histogram. */
function elevationBands(
  cellHeights: Float32Array,
  bandCount: number,
): Uint8Array {
  const bands = new Uint8Array(cellHeights.length)
  if (bandCount <= 1 || cellHeights.length === 0) return bands
  let minH = Infinity
  let maxH = -Infinity
  for (let k = 0; k < cellHeights.length; k++) {
    const h = cellHeights[k]
    if (h < minH) minH = h
    if (h > maxH) maxH = h
  }
  const span = maxH - minH
  if (!(span > 1e-6)) return bands

  const BINS = 2048
  const hist = new Int32Array(BINS)
  const binOf = (h: number) =>
    Math.max(0, Math.min(BINS - 1, ((h - minH) / span) * (BINS - 1)) | 0)
  for (let k = 0; k < cellHeights.length; k++) hist[binOf(cellHeights[k])]++

  const perBand = cellHeights.length / bandCount
  const binBand = new Uint8Array(BINS)
  let acc = 0
  for (let b = 0; b < BINS; b++) {
    const mid = acc + hist[b] / 2
    binBand[b] = Math.min(bandCount - 1, Math.floor(mid / perBand))
    acc += hist[b]
  }
  for (let k = 0; k < cellHeights.length; k++) {
    bands[k] = binBand[binOf(cellHeights[k])]
  }
  return bands
}

export function buildTerrainModel(
  heightGrid: HeightGrid,
  colorGrid: ColorGrid,
  palette: Palette,
  track: LatLon[],
  opts: BuildOptions,
): TerrainModel {
  const baseThicknessMm = Math.max(0.6, opts.baseThicknessMm ?? 1.6)
  const meshRes = opts.meshResolution ?? 0
  const height =
    meshRes >= 8 ? resampleHeightGrid(heightGrid, meshRes) : heightGrid
  const colors =
    meshRes >= 8 ? resampleColorGrid(colorGrid, meshRes) : colorGrid
  const { cols, rows, heights, widthM, heightM, minH, bbox } = height

  const longestM = Math.max(widthM, heightM)
  const scale = opts.bedSizeMm / longestM // mm per meter of ground

  const activeIdxs = enabledColorIndices(palette, opts.routeColorIndex)
  const paletteLabs = activeIdxs.map((i) => hexToLab(palette.colors[i].hex))
  const colorMode: ColorMode = opts.colorMode ?? 'blend'

  // Cell material from colors resampled onto this mesh grid
  const cellW = cols - 1
  const cellH = rows - 1
  const cellHeights = new Float32Array(cellW * cellH)
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      cellHeights[j * cellW + i] =
        (heights[j * cols + i] +
          heights[j * cols + i + 1] +
          heights[(j + 1) * cols + i] +
          heights[(j + 1) * cols + i + 1]) /
        4
    }
  }

  // Low → high maps onto dark → light so the bands read as relief whatever
  // hues the palette holds.
  const bandOrder = paletteLabs
    .map((_, i) => i)
    .sort((a, b) => paletteLabs[a][0] - paletteLabs[b][0])
  const bands =
    colorMode === 'imagery'
      ? null
      : elevationBands(cellHeights, paletteLabs.length)
  const BLEND_W = 0.45

  let cellMat = new Uint16Array(cellW * cellH)
  for (let j = 0; j < cellH; j++) {
    for (let i = 0; i < cellW; i++) {
      const k = j * cellW + i
      const band = bands ? bandOrder[bands[k]] : -1
      let local: number
      if (colorMode === 'elevation') {
        local = band
      } else {
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
        const lab = rgbToLab(r / 4, g / 4, b / 4)
        if (band >= 0) {
          const bandLab = paletteLabs[band]
          lab[0] += (bandLab[0] - lab[0]) * BLEND_W
          lab[1] += (bandLab[1] - lab[1]) * BLEND_W
          lab[2] += (bandLab[2] - lab[2]) * BLEND_W
        }
        local = nearestLabIndex(lab, paletteLabs)
      }
      cellMat[k] = activeIdxs[local]
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

  const terrainCounts = new Map<number, number>()
  for (const m of cellMat) terrainCounts.set(m, (terrainCounts.get(m) ?? 0) + 1)

  const materials: { name: string; hex: string }[] = []
  const terrainToMat = new Map<number, number>()
  for (const idx of [...terrainCounts.keys()].sort((a, b) => a - b)) {
    terrainToMat.set(idx, materials.length)
    const { name, hex } = palette.colors[idx]
    materials.push({ name, hex })
  }

  // The single-color slab under the shell takes whichever color covers the
  // most ground, so the shell is the only thing that forces a filament swap.
  let baseTerrainIdx = cellMat[0] ?? 0
  let baseTerrainCount = -1
  for (const [idx, n] of terrainCounts) {
    if (n > baseTerrainCount) {
      baseTerrainCount = n
      baseTerrainIdx = idx
    }
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

  /**
   * Colored shell over a single-color slab. Each cell's color solid only
   * spans [shellBottom, surface]; everything below belongs to one base solid,
   * so the AMS swaps filament in the top millimetre instead of every layer.
   */
  const shellMm = Math.max(0, opts.colorShellMm ?? 0)
  const shellEnabled = shellMm > 0.05
  const shellFloorZ = Math.max(0.3, Math.min(0.8, baseThicknessMm * 0.4))

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
      positions[bi + 2] = shellEnabled ? Math.max(shellFloorZ, zm - shellMm) : 0
    }
  }

  // Expandable typed buffers (terrain first, base slab and route appended)
  const cellCount = Math.max(1, cellW * cellH)
  let posArr = new Float32Array(Math.max(vertCount * 3 * 2, 3072))
  posArr.set(positions)
  let posLen = positions.length
  let idxArr = new Uint32Array(Math.max(cellCount * 18, 3072))
  let idxLen = 0
  let matArr = new Uint16Array(Math.max(cellCount * 6, 1024))
  let matLen = 0

  const growPos = (need: number) => {
    let cap = posArr.length
    while (cap < posLen + need) cap *= 2
    const next = new Float32Array(cap)
    next.set(posArr.subarray(0, posLen))
    posArr = next
  }

  const growTris = () => {
    const nextIdx = new Uint32Array(idxArr.length * 2)
    nextIdx.set(idxArr)
    idxArr = nextIdx
    const nextMat = new Uint16Array(matArr.length * 2)
    nextMat.set(matArr)
    matArr = nextMat
  }

  const addTri = (a: number, b: number, c: number, mat: number) => {
    const ax = posArr[a * 3]
    const ay = posArr[a * 3 + 1]
    const az = posArr[a * 3 + 2]
    const bx = posArr[b * 3]
    const by = posArr[b * 3 + 1]
    const bz = posArr[b * 3 + 2]
    const cx = posArr[c * 3]
    const cy = posArr[c * 3 + 1]
    const cz = posArr[c * 3 + 2]
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
    if (idxLen + 3 > idxArr.length || matLen + 1 > matArr.length) growTris()
    idxArr[idxLen++] = a
    idxArr[idxLen++] = b
    idxArr[idxLen++] = c
    matArr[matLen++] = mat
  }

  const pushV = (x: number, y: number, z: number) => {
    if (posLen + 3 > posArr.length) growPos(3)
    const i = posLen / 3
    posArr[posLen++] = x
    posArr[posLen++] = y
    posArr[posLen++] = z
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
    const id = pushV(smoothX[column], smoothY[column], posArr[o + 2])
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

  // Base slab: one closed solid in the dominant color from z=0 up to the
  // shell underside. Its top matches the shell bottom vertex-for-vertex; the
  // flat underside is a fan from the center so it costs ~1 triangle per rim
  // vertex instead of two per cell.
  if (shellEnabled && cols > 1 && rows > 1) {
    const baseMat = terrainToMat.get(baseTerrainIdx) ?? 0
    const baseTopV = new Int32Array(topCount)
    for (let vi = 0; vi < topCount; vi++) {
      baseTopV[vi] = pushV(
        smoothX[vi],
        smoothY[vi],
        posArr[(topCount + vi) * 3 + 2],
      )
    }

    for (let j = 0; j < cellH; j++) {
      for (let i = 0; i < cellW; i++) {
        const a = baseTopV[topOf(i, j)]
        const b = baseTopV[topOf(i + 1, j)]
        const c = baseTopV[topOf(i, j + 1)]
        const d = baseTopV[topOf(i + 1, j + 1)]
        addTri(a, b, d, baseMat)
        addTri(a, d, c, baseMat)
      }
    }

    // Rim walk with the interior on the left so wall() faces outward.
    const rim: number[] = []
    for (let i = 0; i < cols; i++) rim.push(topOf(i, 0))
    for (let j = 1; j < rows; j++) rim.push(topOf(cols - 1, j))
    for (let i = cols - 2; i >= 0; i--) rim.push(topOf(i, rows - 1))
    for (let j = rows - 2; j >= 1; j--) rim.push(topOf(0, j))

    const rimBottom = rim.map((vi) => pushV(smoothX[vi], smoothY[vi], 0))
    const centerV = pushV(0, 0, 0)
    for (let k = 0; k < rim.length; k++) {
      const k1 = (k + 1) % rim.length
      const t0 = baseTopV[rim[k]]
      const t1 = baseTopV[rim[k1]]
      const b0 = rimBottom[k]
      const b1 = rimBottom[k1]
      addTri(t0, b0, b1, baseMat)
      addTri(t0, b1, t1, baseMat)
      addTri(centerV, b1, b0, baseMat)
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
  for (let t = 0; t < matLen; t++) usageCounts[matArr[t]]++

  const finalPositions = posArr.slice(0, posLen)
  const finalIndices = idxArr.slice(0, idxLen)
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

  let volume6 = 0
  for (let t = 0; t < finalIndices.length; t += 3) {
    const a = finalIndices[t] * 3
    const b = finalIndices[t + 1] * 3
    const c = finalIndices[t + 2] * 3
    volume6 +=
      finalPositions[a] *
        (finalPositions[b + 1] * finalPositions[c + 2] -
          finalPositions[b + 2] * finalPositions[c + 1]) -
      finalPositions[a + 1] *
        (finalPositions[b] * finalPositions[c + 2] -
          finalPositions[b + 2] * finalPositions[c]) +
      finalPositions[a + 2] *
        (finalPositions[b] * finalPositions[c + 1] -
          finalPositions[b + 1] * finalPositions[c])
  }

  return {
    positions: finalPositions,
    indices: finalIndices,
    triMaterials: matArr.slice(0, matLen),
    materials,
    usageCounts,
    extentMm: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    scaleMmPerM: scale,
    northAngle: 0,
    volumeMm3: Math.abs(volume6) / 6,
    meshResolution: cols,
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
