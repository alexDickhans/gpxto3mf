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
