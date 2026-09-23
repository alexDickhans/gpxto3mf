/**
 * Print-oriented cleanup of a quantized AMS cell grid:
 * majority filter (smooth speckles) + dissolve regions smaller than minCells.
 */

function cellIndex(i: number, j: number, cols: number) {
  return j * cols + i
}

/** Odd kernel majority vote — favors contiguous contours over noisy pixels. */
export function majorityFilter(
  cells: Uint16Array,
  cols: number,
  rows: number,
  radius: number,
): Uint16Array {
  if (radius <= 0) return cells
  const out = new Uint16Array(cells.length)
  const r = Math.max(1, Math.floor(radius))

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const counts = new Map<number, number>()
      let best = cells[cellIndex(i, j, cols)]
      let bestN = 0
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const ni = i + di
          const nj = j + dj
          if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue
          const v = cells[cellIndex(ni, nj, cols)]
          const n = (counts.get(v) ?? 0) + 1
          counts.set(v, n)
          if (n > bestN || (n === bestN && v < best)) {
            bestN = n
            best = v
          }
        }
      }
      out[cellIndex(i, j, cols)] = best
    }
  }
  return out
}

/**
 * Flood-fill connected components (4-connected). Regions with fewer than
 * minCells are reassigned to the most common bordering material.
 */
export function dissolveSmallRegions(
  cells: Uint16Array,
  cols: number,
  rows: number,
  minCells: number,
): Uint16Array {
  if (minCells <= 1) return cells
  const out = new Uint16Array(cells)
  const visited = new Uint8Array(cells.length)
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const start = cellIndex(i, j, cols)
      if (visited[start]) continue
      const label = out[start]
      const stack = [start]
      visited[start] = 1
      const region: number[] = []
      const borderCounts = new Map<number, number>()

      while (stack.length) {
        const idx = stack.pop()!
        region.push(idx)
        const x = idx % cols
        const y = (idx / cols) | 0
        for (const [dx, dy] of dirs) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue
          const nidx = cellIndex(nx, ny, cols)
          const nv = out[nidx]
          if (nv !== label) {
            borderCounts.set(nv, (borderCounts.get(nv) ?? 0) + 1)
            continue
          }
          if (visited[nidx]) continue
          visited[nidx] = 1
          stack.push(nidx)
        }
      }

      if (region.length >= minCells) continue

      let replacement = label
      let best = -1
      for (const [mat, n] of borderCounts) {
        if (n > best) {
          best = n
          replacement = mat
        }
      }
      if (best < 0) continue
      for (const idx of region) out[idx] = replacement
    }
  }

  return out
}

/**
 * @param minRegionMm  Minimum printable color patch size (mm on the bed).
 *                     Small islands below this are merged into neighbors.
 */
export function smoothCellMaterials(
  cells: Uint16Array,
  cols: number,
  rows: number,
  bedSizeMm: number,
  minRegionMm: number,
): Uint16Array {
  if (minRegionMm <= 0.05) return cells

  const cellMm = bedSizeMm / Math.max(cols, rows, 1)
  // Area threshold in cells (square of feature size)
  const minCells = Math.max(
    1,
    Math.round((minRegionMm / Math.max(cellMm, 1e-6)) ** 2),
  )
  // Majority radius ~ half the feature size in cells
  const radius = Math.max(
    0,
    Math.min(6, Math.floor(minRegionMm / Math.max(cellMm, 1e-6) / 2)),
  )

  let out = cells
  if (radius > 0) {
    out = majorityFilter(out, cols, rows, radius)
    // Second light pass helps close thin gaps between same-color blobs
    if (radius >= 2) out = majorityFilter(out, cols, rows, 1)
  }
  out = dissolveSmallRegions(out, cols, rows, minCells)
  return out
}

/**
 * Pull stair-stepped color borders toward a smooth contour.
 * `xs`/`ys` are vertex-grid coordinates (cols = cellCols+1). Only vertices that
 * sit on a color change move; the outer rectangle stays put. Displacement is
 * capped to just under half a cell so adjacent quads cannot flip.
 * `strength` is 0 (pixel edges) … 1 (fully rounded).
 */
export function smoothColorBoundary(
  xs: Float32Array,
  ys: Float32Array,
  cells: Uint16Array,
  cols: number,
  rows: number,
  strength: number,
): void {
  if (strength <= 0.001 || cols < 3 || rows < 3) return
  const cellW = cols - 1
  const cellH = rows - 1
  const t = Math.max(0, Math.min(1, strength))

  const colorAt = (ci: number, cj: number) => {
    if (ci < 0 || cj < 0 || ci >= cellW || cj >= cellH) return -1
    return cells[cj * cellW + ci]
  }

  const boundaryEdge = (i0: number, j0: number, i1: number, j1: number) => {
    if (j0 === j1) {
      const i = Math.min(i0, i1)
      const north = colorAt(i, j0)
      const south = colorAt(i, j0 - 1)
      return north >= 0 && south >= 0 && north !== south
    }
    const j = Math.min(j0, j1)
    const east = colorAt(i0, j)
    const west = colorAt(i0 - 1, j)
    return east >= 0 && west >= 0 && east !== west
  }

  const count = cols * rows
  const contour = new Uint8Array(count)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const here = j * cols + i
      if (i + 1 < cols && boundaryEdge(i, j, i + 1, j)) {
        contour[here] = 1
        contour[here + 1] = 1
      }
      if (j + 1 < rows && boundaryEdge(i, j, i, j + 1)) {
        contour[here] = 1
        contour[here + cols] = 1
      }
    }
  }

  const movers: number[] = []
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const idx = j * cols + i
      if (contour[idx]) movers.push(idx)
    }
  }
  if (movers.length === 0) return

  let cellX = Infinity
  let cellY = Infinity
  for (let i = 0; i < cols - 1; i++) {
    cellX = Math.min(cellX, Math.abs(xs[i + 1] - xs[i]))
  }
  for (let j = 0; j < rows - 1; j++) {
    const a = j * cols
    const b = (j + 1) * cols
    cellY = Math.min(cellY, Math.abs(ys[b] - ys[a]))
  }
  if (!Number.isFinite(cellX) || !Number.isFinite(cellY)) return
  const maxDx = cellX * 0.48
  const maxDy = cellY * 0.48

  const origX = xs.slice()
  const origY = ys.slice()
  const nextX = new Float32Array(count)
  const nextY = new Float32Array(count)
  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const

  const iterations = 24
  const lambda = 0.55
  for (let iter = 0; iter < iterations; iter++) {
    for (const vi of movers) {
      const i = vi % cols
      const j = (vi / cols) | 0
      let sx = 0
      let sy = 0
      let n = 0
      for (const [di, dj] of dirs) {
        const ni = i + di
        const nj = j + dj
        if (!boundaryEdge(i, j, ni, nj)) continue
        const nk = nj * cols + ni
        sx += xs[nk]
        sy += ys[nk]
        n++
      }
      if (n === 0) {
        nextX[vi] = xs[vi]
        nextY[vi] = ys[vi]
        continue
      }
      let x = xs[vi] + (sx / n - xs[vi]) * lambda
      let y = ys[vi] + (sy / n - ys[vi]) * lambda
      const dx = x - origX[vi]
      const dy = y - origY[vi]
      if (dx > maxDx) x = origX[vi] + maxDx
      else if (dx < -maxDx) x = origX[vi] - maxDx
      if (dy > maxDy) y = origY[vi] + maxDy
      else if (dy < -maxDy) y = origY[vi] - maxDy
      nextX[vi] = x
      nextY[vi] = y
    }
    for (const vi of movers) {
      xs[vi] = nextX[vi]
      ys[vi] = nextY[vi]
    }
  }

  for (const vi of movers) {
    xs[vi] = origX[vi] + (xs[vi] - origX[vi]) * t
    ys[vi] = origY[vi] + (ys[vi] - origY[vi]) * t
  }
}
