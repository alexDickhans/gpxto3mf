/**
 * Topology checks shared by the serial path and worker threads.
 * Triangle chunks and edge buckets run independently. Component labels are
 * linked from those bucket results so workers never contend on one root.
 */

function mix(h) {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  return (h ^ (h >>> 16)) >>> 0
}

export function nextPow2(n) {
  let p = 1
  while (p < n) {
    p <<= 1
    if (p <= 0) throw new Error('hash table too large')
  }
  return p
}

export function hash2(a, b) {
  const lo = a < b ? a : b
  const hi = a < b ? b : a
  return (Math.imul(lo, 0x9e3779b1) ^ Math.imul(hi, 0x85ebca6b)) >>> 0
}

export function hash3(a, b, c) {
  return (
    Math.imul(a, 0x9e3779b1) ^
    Math.imul(b, 0x85ebca6b) ^
    Math.imul(c, 0xc2b2ae35)
  ) >>> 0
}

function bucketOf(h, bucketCount) {
  return bucketCount <= 1 ? 0 : h % bucketCount
}

function asFloat32(buf) {
  return buf instanceof Float32Array ? buf : new Float32Array(buf)
}
function asUint32(buf) {
  return buf instanceof Uint32Array ? buf : new Uint32Array(buf)
}
function asUint8(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf)
}

function bag() {
  return { data: new Uint32Array(192), n: 0 }
}

function pushN(slot, values) {
  const need = values.length
  if (slot.n + need > slot.data.length) {
    let cap = slot.data.length
    while (cap < slot.n + need) cap *= 2
    const next = new Uint32Array(cap)
    next.set(slot.data, 0)
    slot.data = next
  }
  for (let i = 0; i < need; i++) slot.data[slot.n++] = values[i]
}

function trim(slot) {
  return slot.n === slot.data.length ? slot.data : slot.data.slice(0, slot.n)
}

function sort3(i0, i1, i2) {
  let a = i0
  let b = i1
  let c = i2
  if (a > b) {
    const tmp = a
    a = b
    b = tmp
  }
  if (b > c) {
    const tmp = b
    b = c
    c = tmp
  }
  if (a > b) {
    const tmp = a
    a = b
    b = tmp
  }
  return [a, b, c]
}

/**
 * One pass over a triangle range. Writes validity and hash-partitioned
 * edge / canonical-face records.
 */
export function processChunk({
  positions,
  indices,
  valid,
  triStart,
  triEnd,
  bucketCount,
}) {
  const cpu0 = performance.now()
  const pos = asFloat32(positions)
  const idx = asUint32(indices)
  const validView = asUint8(valid)
  const vertCount = pos.length / 3
  const buckets = bucketCount > 0 ? bucketCount : 1
  const edgeBags = Array.from({ length: buckets }, bag)
  const faceBags = Array.from({ length: buckets }, bag)

  let badIndex = 0
  let degenerate = 0
  let volume6 = 0
  const badExamples = []
  const degExamples = []

  for (let t = triStart; t < triEnd; t++) {
    const o = t * 3
    const i0 = idx[o]
    const i1 = idx[o + 1]
    const i2 = idx[o + 2]
    if (i0 >= vertCount || i1 >= vertCount || i2 >= vertCount) {
      badIndex++
      if (badExamples.length < 5) badExamples.push(t)
      validView[t] = 0
      continue
    }
    if (i0 === i1 || i1 === i2 || i0 === i2) {
      degenerate++
      if (degExamples.length < 5) degExamples.push(t)
      validView[t] = 0
      continue
    }
    const a0 = i0 * 3
    const a1 = i1 * 3
    const a2 = i2 * 3
    const ax = pos[a0]
    const ay = pos[a0 + 1]
    const az = pos[a0 + 2]
    const bx = pos[a1] - ax
    const by = pos[a1 + 1] - ay
    const bz = pos[a1 + 2] - az
    const cx = pos[a2] - ax
    const cy = pos[a2 + 1] - ay
    const cz = pos[a2 + 2] - az
    const nx = by * cz - bz * cy
    const ny = bz * cx - bx * cz
    const nz = bx * cy - by * cx
    if (nx * nx + ny * ny + nz * nz < 1e-18) {
      degenerate++
      if (degExamples.length < 5) degExamples.push(t)
      validView[t] = 0
      continue
    }
    volume6 +=
      ax * (pos[a1 + 1] * pos[a2 + 2] - pos[a1 + 2] * pos[a2 + 1]) -
      ay * (pos[a1] * pos[a2 + 2] - pos[a1 + 2] * pos[a2]) +
      az * (pos[a1] * pos[a2 + 1] - pos[a1 + 1] * pos[a2])
    validView[t] = 1
    pushN(edgeBags[bucketOf(hash2(i0, i1), buckets)], [i0, i1, t])
    pushN(edgeBags[bucketOf(hash2(i1, i2), buckets)], [i1, i2, t])
    pushN(edgeBags[bucketOf(hash2(i2, i0), buckets)], [i2, i0, t])
    const [fa, fb, fc] = sort3(i0, i1, i2)
    pushN(faceBags[bucketOf(hash3(fa, fb, fc), buckets)], [fa, fb, fc])
  }

  const edgeBuckets = edgeBags.map(trim)
  const faceBuckets = faceBags.map(trim)
  const transfers = []
  for (const arr of edgeBuckets) transfers.push(arr.buffer)
  for (const arr of faceBuckets) transfers.push(arr.buffer)
  return {
    badIndex,
    degenerate,
    volume: volume6 / 6,
    badExamples,
    degExamples,
    edgeBuckets,
    faceBuckets,
    transfers,
    cpuMs: performance.now() - cpu0,
  }
}

export function processBucket({ edgeBuffers, faceBuffers }) {
  const edges = edgeBuffers.map((buf) => asUint32(buf))
  const faces = faceBuffers.map((buf) => asUint32(buf))
  const edgeStats = classifyEdges(edges)
  const duplicateFaces = countDuplicates(faces)
  return {
    ...edgeStats,
    duplicateFaces,
    transfers: [edgeStats.pairs.buffer, edgeStats.openFaces.buffer],
  }
}

function classifyEdges(buffers) {
  let total = 0
  for (const buf of buffers) total += buf.length / 3
  const cap = nextPow2(Math.max(16, total * 2))
  const mask = cap - 1
  const lo = new Uint32Array(cap)
  const hi = new Uint32Array(cap)
  const count = new Uint32Array(cap)
  const dir = new Int32Array(cap)
  const f0 = new Uint32Array(cap)
  const f1 = new Uint32Array(cap)
  const used = new Uint8Array(cap)
  const pairs = bag()
  const opens = bag()

  let boundaryEdges = 0
  let nonManifoldEdges = 0
  let inconsistentWinding = 0
  const boundaryExamples = []

  const locate = (loV, hiV) => {
    let slot = mix(hash2(loV, hiV)) & mask
    let guard = 0
    while (used[slot]) {
      if (lo[slot] === loV && hi[slot] === hiV) return slot
      slot = (slot + 1) & mask
      if (++guard > mask) throw new Error('edge hash table full')
    }
    return slot
  }

  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i += 3) {
      const a = buf[i]
      const b = buf[i + 1]
      const face = buf[i + 2]
      const loV = a < b ? a : b
      const hiV = a < b ? b : a
      const sign = a < b ? 1 : -1
      const slot = locate(loV, hiV)
      if (!used[slot]) {
        used[slot] = 1
        lo[slot] = loV
        hi[slot] = hiV
        count[slot] = 1
        dir[slot] = sign
        f0[slot] = face
        f1[slot] = 0xffffffff
      } else {
        const c = ++count[slot]
        dir[slot] += sign
        if (c === 2) f1[slot] = face
        else {
          pushN(opens, [face, f0[slot]])
          if (f1[slot] !== 0xffffffff) pushN(opens, [f1[slot]])
        }
      }
    }
  }

  for (let slot = 0; slot < cap; slot++) {
    if (!used[slot]) continue
    const c = count[slot]
    if (c === 1) {
      boundaryEdges++
      pushN(opens, [f0[slot]])
      if (boundaryExamples.length < 5) boundaryExamples.push([lo[slot], hi[slot]])
    } else if (c === 2 && dir[slot] === 0) {
      pushN(pairs, [f0[slot], f1[slot]])
    } else if (c === 2) {
      inconsistentWinding++
      pushN(opens, [f0[slot], f1[slot]])
    } else {
      nonManifoldEdges++
    }
  }

  return {
    boundaryEdges,
    nonManifoldEdges,
    inconsistentWinding,
    boundaryExamples,
    pairs: trim(pairs),
    openFaces: trim(opens),
  }
}

function countDuplicates(buffers) {
  let total = 0
  for (const buf of buffers) total += buf.length / 3
  if (total === 0) return 0
  const cap = nextPow2(Math.max(16, total * 2))
  const mask = cap - 1
  const A = new Uint32Array(cap)
  const B = new Uint32Array(cap)
  const C = new Uint32Array(cap)
  const used = new Uint8Array(cap)
  let duplicates = 0
  for (const buf of buffers) {
    for (let i = 0; i < buf.length; i += 3) {
      const a = buf[i]
      const b = buf[i + 1]
      const c = buf[i + 2]
      let slot = mix(hash3(a, b, c)) & mask
      let guard = 0
      for (;;) {
        if (!used[slot]) {
          used[slot] = 1
          A[slot] = a
          B[slot] = b
          C[slot] = c
          break
        }
        if (A[slot] === a && B[slot] === b && C[slot] === c) {
          duplicates++
          break
        }
        slot = (slot + 1) & mask
        if (++guard > mask) throw new Error('face hash table full')
      }
    }
  }
  return duplicates
}

function findPlain(parent, x) {
  let r = x
  while (parent[r] !== r) r = parent[r]
  while (parent[x] !== r) {
    const next = parent[x]
    parent[x] = r
    x = next
  }
  return r
}

/** Link manifold edge pairs, then count watertight vs open components. */
export function linkComponents(triCount, bucketResults, valid) {
  const validView = asUint8(valid)
  const parent = new Int32Array(triCount)
  const open = new Uint8Array(triCount)
  for (let i = 0; i < triCount; i++) parent[i] = i
  for (const part of bucketResults) {
    const faces = part.openFaces
    for (let i = 0; i < faces.length; i++) open[faces[i]] = 1
    const pairs = part.pairs
    for (let i = 0; i < pairs.length; i += 2) {
      let ra = findPlain(parent, pairs[i])
      let rb = findPlain(parent, pairs[i + 1])
      if (ra === rb) continue
      if (ra < rb) parent[rb] = ra
      else parent[ra] = rb
    }
  }
  for (let i = 0; i < triCount; i++) {
    if (validView[i] && open[i]) open[findPlain(parent, i)] = 1
  }
  let watertightComponents = 0
  let openComponents = 0
  for (let i = 0; i < triCount; i++) {
    if (!validView[i]) continue
    if (findPlain(parent, i) !== i) continue
    if (open[i]) openComponents++
    else watertightComponents++
  }
  return { watertightComponents, openComponents }
}
