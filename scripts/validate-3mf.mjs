#!/usr/bin/env node
/**
 * Validate a 3MF package and mesh topology.
 *
 * Package structure is checked against the OPC / 3MF core layout. Mesh checks
 * (index bounds, degenerate and duplicate faces, winding, boundary and
 * non-manifold edges, watertight components) run in hashed chunks on a
 * worker_threads pool. A serial path uses the same functions so fixture
 * results can be compared.
 *
 *   node scripts/validate-3mf.mjs --self-test model.3mf
 *   node scripts/validate-3mf.mjs model.3mf
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import JSZip from 'jszip'
import { linkComponents, processBucket, processChunk } from './mesh-checks.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COUNT_KEYS = [
  'badIndex',
  'degenerate',
  'duplicateFaces',
  'boundaryEdges',
  'nonManifoldEdges',
  'inconsistentWinding',
  'watertightComponents',
  'openComponents',
]

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
  <Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
`

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0"
    Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
`

function createPool(n) {
  const workers = []
  let seq = 0
  const pending = new Map()
  for (let i = 0; i < n; i++) {
    const worker = new Worker(new URL('./mesh-check-worker.mjs', import.meta.url))
    worker.on('message', (msg) => {
      const job = pending.get(msg.id)
      if (!job) return
      pending.delete(msg.id)
      if (msg.error) job.reject(new Error(msg.error))
      else job.resolve(msg.result)
    })
    worker.on('error', (err) => {
      for (const job of pending.values()) job.reject(err)
      pending.clear()
    })
    workers.push(worker)
  }

  async function call(workerIndex, task) {
    const id = ++seq
    const transfers = []
    for (const arr of task.edgeBuffers || []) transfers.push(arr.buffer)
    for (const arr of task.faceBuffers || []) transfers.push(arr.buffer)
    return new Promise((resolvePromise, reject) => {
      pending.set(id, { resolve: resolvePromise, reject })
      workers[workerIndex].postMessage({ id, ...task }, transfers)
    })
  }

  async function batch(tasks) {
    const results = new Array(tasks.length)
    let cursor = 0
    async function drain(workerIndex) {
      while (cursor < tasks.length) {
        const job = cursor++
        results[job] = await call(workerIndex, tasks[job])
      }
    }
    await Promise.all(workers.map((_, workerIndex) => drain(workerIndex)))
    return results
  }

  async function close() {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }

  return { size: n, batch, close }
}

function ranges(count, parts) {
  if (count <= 0) return []
  const n = Math.max(1, Math.min(parts, count))
  const size = Math.ceil(count / n)
  const out = []
  for (let start = 0; start < count; start += size) {
    out.push([start, Math.min(count, start + size)])
  }
  return out
}

function sum(list, key) {
  let total = 0
  for (const item of list) total += item[key] || 0
  return total
}

/**
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {{ workers: number, pool: Awaited<ReturnType<typeof createPool>> | null }} options
 */
export async function checkMesh(positions, indices, options) {
  const t0 = performance.now()
  const mark = () => performance.now()
  let tFill = t0
  let tEdges = t0
  let tComp = t0
  const triCount = indices.length / 3
  const workerCount = Math.max(1, options.workers || 1)
  if (triCount < 1 || positions.length < 9) {
    return {
      vertices: positions.length / 3,
      triangles: triCount,
      badIndex: 0,
      degenerate: 0,
      duplicateFaces: 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentWinding: 0,
      watertightComponents: 0,
      openComponents: 0,
      components: 0,
      volume: 0,
      workers: workerCount,
      ms: performance.now() - t0,
    }
  }

  const usePool = workerCount > 1 && options.pool
  const buckets = usePool ? workerCount : 1
  const validSab = new SharedArrayBuffer(triCount)
  let posArg = positions
  let idxArg = indices
  if (usePool) {
    const posSab = new SharedArrayBuffer(positions.byteLength)
    const idxSab = new SharedArrayBuffer(indices.byteLength)
    new Float32Array(posSab).set(positions)
    new Uint32Array(idxSab).set(indices)
    posArg = posSab
    idxArg = idxSab
  }

  const chunkTasks = ranges(triCount, buckets).map(([triStart, triEnd]) => ({
    type: 'chunk',
    positions: posArg,
    indices: idxArg,
    valid: validSab,
    triStart,
    triEnd,
    bucketCount: buckets,
  }))

  const chunkResults = usePool
    ? await options.pool.batch(chunkTasks)
    : chunkTasks.map((task) => processChunk(task))
  tFill = mark()

  const edgeGroups = Array.from({ length: buckets }, () => [])
  const faceGroups = Array.from({ length: buckets }, () => [])
  for (const part of chunkResults) {
    part.edgeBuckets.forEach((arr, i) => edgeGroups[i].push(arr))
    part.faceBuckets.forEach((arr, i) => faceGroups[i].push(arr))
  }

  const bucketTasks = edgeGroups.map((edgeBuffers, i) => ({
    type: 'bucket',
    edgeBuffers,
    faceBuffers: faceGroups[i],
  }))
  const bucketResults = usePool
    ? await options.pool.batch(bucketTasks)
    : bucketTasks.map((task) => processBucket(task))
  tEdges = mark()

  const linked = linkComponents(triCount, bucketResults, validSab)
  tComp = mark()
  const watertightComponents = linked.watertightComponents
  const openComponents = linked.openComponents
  return {
    vertices: positions.length / 3,
    triangles: triCount,
    badIndex: sum(chunkResults, 'badIndex'),
    degenerate: sum(chunkResults, 'degenerate'),
    duplicateFaces: sum(bucketResults, 'duplicateFaces'),
    boundaryEdges: sum(bucketResults, 'boundaryEdges'),
    nonManifoldEdges: sum(bucketResults, 'nonManifoldEdges'),
    inconsistentWinding: sum(bucketResults, 'inconsistentWinding'),
    watertightComponents,
    openComponents,
    components: watertightComponents + openComponents,
    volume: sum(chunkResults, 'volume'),
    badExamples: chunkResults.flatMap((part) => part.badExamples || []).slice(0, 8),
    degExamples: chunkResults.flatMap((part) => part.degExamples || []).slice(0, 8),
    boundaryExamples: bucketResults
      .flatMap((part) => part.boundaryExamples || [])
      .slice(0, 8),
    workers: usePool ? workerCount : 1,
    ms: performance.now() - t0,
    fillMs: tFill - t0,
    edgeMs: tEdges - tFill,
    componentMs: tComp - tEdges,
    chunkCpuMs: Math.max(...chunkResults.map((part) => part.cpuMs || 0)),
  }
}

export function meshIsSolid(report) {
  return (
    report.badIndex === 0 &&
    report.degenerate === 0 &&
    report.duplicateFaces === 0 &&
    report.boundaryEdges === 0 &&
    report.nonManifoldEdges === 0 &&
    report.inconsistentWinding === 0 &&
    report.watertightComponents >= 1 &&
    report.openComponents === 0 &&
    report.volume > 0
  )
}

function sameDefects(a, b) {
  return COUNT_KEYS.every((key) => a[key] === b[key])
}

function countBetween(xml, start, end, token) {
  let n = 0
  let i = start
  while (i < end) {
    const j = xml.indexOf(token, i)
    if (j < 0 || j >= end) break
    n++
    i = j + token.length
  }
  return n
}

function readNumber(xml, i) {
  let sign = 1
  const c0 = xml.charCodeAt(i)
  if (c0 === 45) {
    sign = -1
    i++
  } else if (c0 === 43) i++
  let intPart = 0
  let saw = false
  while (i < xml.length) {
    const c = xml.charCodeAt(i)
    if (c < 48 || c > 57) break
    intPart = intPart * 10 + (c - 48)
    i++
    saw = true
  }
  let frac = 0
  let div = 1
  if (xml.charCodeAt(i) === 46) {
    i++
    while (i < xml.length) {
      const c = xml.charCodeAt(i)
      if (c < 48 || c > 57) break
      frac = frac * 10 + (c - 48)
      div *= 10
      i++
      saw = true
    }
  }
  if (!saw) return { value: NaN, i }
  return { value: sign * (intPart + frac / div), i }
}

function readInt(xml, i) {
  const parsed = readNumber(xml, i)
  return { value: parsed.value, i: parsed.i }
}

function attrPos(xml, start, end, name) {
  const key = `${name}="`
  const at = xml.indexOf(key, start)
  if (at < 0 || at >= end) return -1
  return at + key.length
}

function meshSpans(xml) {
  const spans = []
  let i = 0
  while (i < xml.length) {
    const start = xml.indexOf('<mesh', i)
    if (start < 0) break
    const end = xml.indexOf('</mesh>', start)
    if (end < 0) break
    spans.push([start, end + 7])
    i = end + 7
  }
  return spans
}

function parseMeshRegion(xml, start, end, baseCount) {
  const vertToken = '<vertex '
  const triToken = '<triangle '
  const vertCount = countBetween(xml, start, end, vertToken)
  const triCount = countBetween(xml, start, end, triToken)
  const positions = new Float32Array(vertCount * 3)
  const indices = new Uint32Array(triCount * 3)
  let v = 0
  let i = start
  while (v < vertCount) {
    const tag = xml.indexOf(vertToken, i)
    if (tag < 0 || tag >= end) break
    const close = xml.indexOf('>', tag)
    const xAt = attrPos(xml, tag, close, 'x')
    const yAt = attrPos(xml, tag, close, 'y')
    const zAt = attrPos(xml, tag, close, 'z')
    const x = readNumber(xml, xAt)
    const y = readNumber(xml, yAt)
    const z = readNumber(xml, zAt)
    positions[v * 3] = x.value
    positions[v * 3 + 1] = y.value
    positions[v * 3 + 2] = z.value
    v++
    i = close + 1
  }
  let t = 0
  let badPid = 0
  i = start
  while (t < triCount) {
    const tag = xml.indexOf(triToken, i)
    if (tag < 0 || tag >= end) break
    const close = xml.indexOf('>', tag)
    const aAt = attrPos(xml, tag, close, 'v1')
    const bAt = attrPos(xml, tag, close, 'v2')
    const cAt = attrPos(xml, tag, close, 'v3')
    const a = readInt(xml, aAt)
    const b = readInt(xml, bAt)
    const c = readInt(xml, cAt)
    if (
      !Number.isFinite(a.value) ||
      !Number.isFinite(b.value) ||
      !Number.isFinite(c.value)
    ) {
      badPid++
      indices[t * 3] = 0
      indices[t * 3 + 1] = 0
      indices[t * 3 + 2] = 0
    } else {
      indices[t * 3] = a.value
      indices[t * 3 + 1] = b.value
      indices[t * 3 + 2] = c.value
    }
    if (baseCount > 0) {
      const pAt = attrPos(xml, tag, close, 'p1')
      const pidAt = attrPos(xml, tag, close, 'pid')
      if (pAt < 0 || pidAt < 0) badPid++
      else {
        const p1 = readInt(xml, pAt)
        if (!Number.isInteger(p1.value) || p1.value < 0 || p1.value >= baseCount) {
          badPid++
        }
      }
    }
    t++
    i = close + 1
  }
  return { positions, indices, badPid }
}

function packageErrors(entries, modelXml) {
  const errors = []
  if (!entries.has('[Content_Types].xml')) {
    errors.push('missing [Content_Types].xml')
  }
  if (!entries.has('_rels/.rels')) errors.push('missing _rels/.rels')
  if (!entries.has('3D/3dmodel.model')) errors.push('missing 3D/3dmodel.model')
  const types = entries.get('[Content_Types].xml') || ''
  if (
    types &&
    !types.includes('application/vnd.ms-package.3dmanufacturing-3dmodel+xml')
  ) {
    errors.push('content type is not a 3D manufacturing model')
  }
  const rels = entries.get('_rels/.rels') || ''
  if (rels && !rels.includes('3dmodel.model')) {
    errors.push('package relationships do not point at a 3dmodel')
  }
  if (
    rels &&
    !rels.includes('http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel')
  ) {
    errors.push('relationship type is not the 3MF 3dmodel type')
  }
  if (!modelXml.includes('http://schemas.microsoft.com/3dmanufacturing/core/2015/02')) {
    errors.push('model is missing the 3MF core namespace')
  }
  if (!modelXml.includes('unit="millimeter"')) {
    errors.push('model unit must be millimeter')
  }
  if (!modelXml.includes('<build') || !modelXml.includes('objectid=')) {
    errors.push('model has no build item')
  }
  if (modelXml.includes('<m:basematerials') || modelXml.includes('<m:base ')) {
    errors.push(
      'basematerials use the m: namespace; lib3mf/Bambu reject that and expect core <basematerials>',
    )
  }
  const usesMaterials = modelXml.includes('<basematerials')
  if (usesMaterials) {
    const colors = modelXml.matchAll(/displaycolor="([^"]*)"/g)
    for (const color of colors) {
      if (!/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(color[1])) {
        errors.push(`displaycolor ${color[1]} is not #RRGGBB or #RRGGBBAA`)
        break
      }
    }
  }
  if (meshSpans(modelXml).length < 1) errors.push('model has no mesh')
  return errors
}

function baseMaterialCount(xml) {
  return countBetween(xml, 0, xml.length, '<m:base ') +
    countBetween(xml, 0, xml.length, '<base ')
}

export async function load3mf(buf) {
  const errors = []
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    return { errors: ['not a ZIP / 3MF package'], meshes: [] }
  }
  let zip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch (err) {
    return {
      errors: [`zip read failed: ${err instanceof Error ? err.message : err}`],
      meshes: [],
    }
  }
  const entries = new Map()
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir)
  await Promise.all(
    names.map(async (name) => {
      entries.set(name, await zip.files[name].async('string'))
    }),
  )
  const modelXml = entries.get('3D/3dmodel.model') || ''
  errors.push(...packageErrors(entries, modelXml))
  if (!modelXml) return { errors, meshes: [], modelXml }
  const baseCount = baseMaterialCount(modelXml)
  const meshes = []
  for (const [start, end] of meshSpans(modelXml)) {
    const mesh = parseMeshRegion(modelXml, start, end, baseCount)
    if (mesh.badPid > 0) {
      errors.push(`${mesh.badPid} triangles reference a missing material`)
    }
    let nonFinite = 0
    for (let i = 0; i < mesh.positions.length; i++) {
      if (!Number.isFinite(mesh.positions[i])) nonFinite++
    }
    if (nonFinite > 0) errors.push(`${nonFinite} non-finite vertex coordinates`)
    meshes.push(mesh)
  }
  return { errors, meshes, modelXml }
}

function printReport(label, report) {
  console.log(`\n== ${label} ==`)
  if (report.packageErrors) {
    console.log(`package: ${report.packageErrors.length ? 'FAIL' : 'OK'}`)
    for (const error of report.packageErrors) console.log(`  ${error}`)
  }
  console.log(
    `vertices ${report.vertices}  triangles ${report.triangles}  workers ${report.workers}`,
  )
  console.log(
    `badIndex ${report.badIndex}  degenerate ${report.degenerate}  duplicateFaces ${report.duplicateFaces}`,
  )
  console.log(
    `boundaryEdges ${report.boundaryEdges}  nonManifoldEdges ${report.nonManifoldEdges}  inconsistentWinding ${report.inconsistentWinding}`,
  )
  console.log(
    `components ${report.components}  watertight ${report.watertightComponents}  open ${report.openComponents}`,
  )
  console.log(`signedVolume_mm3 ${report.volume.toFixed(3)}`)
  console.log(`wall_clock_ms ${report.ms.toFixed(1)}`)
  if (report.badExamples?.length) {
    console.log(`badIndex triangles ${report.badExamples.join(',')}`)
  }
  if (report.degExamples?.length) {
    console.log(`degenerate triangles ${report.degExamples.join(',')}`)
  }
  if (report.boundaryExamples?.length) {
    console.log(
      `boundary edges ${report.boundaryExamples.map((e) => e.join('-')).join(',')}`,
    )
  }
  console.log(report.ok ? 'RESULT PASS' : 'RESULT FAIL')
}

async function checkFile(buf, pool, workers) {
  const t0 = performance.now()
  const loaded = await load3mf(buf)
  const parseMs = performance.now() - t0
  if (!loaded.meshes.length) {
    return {
      ok: false,
      packageErrors: loaded.errors,
      vertices: 0,
      triangles: 0,
      badIndex: 0,
      degenerate: 0,
      duplicateFaces: 0,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
      inconsistentWinding: 0,
      watertightComponents: 0,
      openComponents: 0,
      components: 0,
      volume: 0,
      workers,
      ms: performance.now() - t0,
      parseMs,
    }
  }
  const merged = {
    vertices: 0,
    triangles: 0,
    badIndex: 0,
    degenerate: 0,
    duplicateFaces: 0,
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    inconsistentWinding: 0,
    watertightComponents: 0,
    openComponents: 0,
    components: 0,
    volume: 0,
    badExamples: [],
    degExamples: [],
    boundaryExamples: [],
    workers,
    ms: 0,
  }
  for (const mesh of loaded.meshes) {
    const report = await checkMesh(mesh.positions, mesh.indices, {
      workers,
      pool,
    })
    for (const key of COUNT_KEYS) merged[key] += report[key]
    merged.vertices += report.vertices
    merged.triangles += report.triangles
    merged.volume += report.volume
    merged.ms += report.ms
    merged.badExamples.push(...(report.badExamples || []))
    merged.degExamples.push(...(report.degExamples || []))
    merged.boundaryExamples.push(...(report.boundaryExamples || []))
  }
  merged.components = merged.watertightComponents + merged.openComponents
  merged.packageErrors = loaded.errors
  merged.parseMs = parseMs
  merged.ok = loaded.errors.length === 0 && meshIsSolid(merged)
  merged.ms = performance.now() - t0
  return merged
}

function cubeMesh() {
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ])
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0,
    4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ])
  return { positions, indices }
}

function buildClosedGrid(n) {
  const cols = n
  const rows = n
  const topCount = cols * rows
  const positions = new Float32Array(topCount * 2 * 3)
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const z =
        3 +
        2 *
          Math.sin((i / (cols - 1)) * Math.PI) *
          Math.sin((j / (rows - 1)) * Math.PI)
      const ti = (j * cols + i) * 3
      positions[ti] = i
      positions[ti + 1] = j
      positions[ti + 2] = z
      const bi = (topCount + j * cols + i) * 3
      positions[bi] = i
      positions[bi + 1] = j
      positions[bi + 2] = 0
    }
  }
  const quads = (cols - 1) * (rows - 1)
  const triCount = quads * 4 + (cols - 1) * 4 + (rows - 1) * 4
  const indices = new Uint32Array(triCount * 3)
  let p = 0
  const push = (a, b, c) => {
    indices[p++] = a
    indices[p++] = b
    indices[p++] = c
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      push(a, b, d)
      push(a, d, c)
    }
  }
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = topCount + j * cols + i
      const b = a + 1
      const c = a + cols
      const d = c + 1
      push(a, d, b)
      push(a, c, d)
    }
  }
  for (let i = 0; i < cols - 1; i++) {
    const t0 = i
    const t1 = i + 1
    push(t0, topCount + i, topCount + i + 1)
    push(t0, topCount + i + 1, t1)
    const n0 = (rows - 1) * cols + i
    const n1 = n0 + 1
    push(n0, topCount + n1, topCount + n0)
    push(n0, n1, topCount + n1)
  }
  for (let j = 0; j < rows - 1; j++) {
    const t0 = j * cols
    const t1 = (j + 1) * cols
    push(t0, topCount + t1, topCount + t0)
    push(t0, t1, topCount + t1)
    const e0 = j * cols + (cols - 1)
    const e1 = (j + 1) * cols + (cols - 1)
    push(e0, topCount + e0, topCount + e1)
    push(e0, topCount + e1, e1)
  }
  if (p !== indices.length) {
    throw new Error(`grid index fill ${p} != ${indices.length}`)
  }
  return { positions, indices }
}

function meshXml(positions, indices) {
  const verts = []
  for (let i = 0; i < positions.length; i += 3) {
    verts.push(
      `<vertex x="${positions[i]}" y="${positions[i + 1]}" z="${positions[i + 2]}" />`,
    )
  }
  const tris = []
  for (let i = 0; i < indices.length; i += 3) {
    tris.push(
      `<triangle v1="${indices[i]}" v2="${indices[i + 1]}" v3="${indices[i + 2]}" />`,
    )
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="2" type="model">
      <mesh>
        <vertices>
          ${verts.join('\n')}
        </vertices>
        <triangles>
          ${tris.join('\n')}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="2" /></build>
</model>
`
}

async function pack3mf(modelXml) {
  const zip = new JSZip()
  zip.file('[Content_Types].xml', CONTENT_TYPES)
  zip.folder('_rels').file('.rels', RELS)
  zip.folder('3D').file('3dmodel.model', modelXml)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected} got ${actual}`)
  }
}

async function selfTest(pool, workers) {
  const failures = []
  const check = async (name, positions, indices, expectFn) => {
    const serial = await checkMesh(positions, indices, { workers: 1, pool: null })
    const parallel = await checkMesh(positions, indices, { workers, pool })
    const again = await checkMesh(positions, indices, { workers, pool })
    if (!sameDefects(serial, parallel) || !sameDefects(parallel, again)) {
      failures.push(
        `${name} serial/parallel mismatch ${JSON.stringify({ serial, parallel, again })}`,
      )
      return
    }
    try {
      expectFn(parallel)
      console.log(
        `fixture ${name}: ok  serial ${serial.ms.toFixed(1)} ms  parallel ${parallel.ms.toFixed(1)} ms`,
      )
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : err}`)
    }
  }

  const cube = cubeMesh()
  await check('closed-cube', cube.positions, cube.indices, (report) => {
    assertEqual(report.boundaryEdges, 0, 'boundary')
    assertEqual(report.nonManifoldEdges, 0, 'nonManifold')
    assertEqual(report.inconsistentWinding, 0, 'winding')
    assertEqual(report.duplicateFaces, 0, 'duplicates')
    assertEqual(report.degenerate, 0, 'degenerate')
    assertEqual(report.badIndex, 0, 'badIndex')
    assertEqual(report.watertightComponents, 1, 'watertight')
    assertEqual(report.openComponents, 0, 'open')
    if (!(report.volume > 0.9 && report.volume < 1.1)) {
      throw new Error(`volume ${report.volume}`)
    }
  })

  const openIdx = cube.indices.slice(6)
  await check('open-box', cube.positions, openIdx, (report) => {
    assertEqual(report.boundaryEdges, 4, 'boundary')
    assertEqual(report.watertightComponents, 0, 'watertight')
    assertEqual(report.openComponents, 1, 'open')
    assertEqual(report.inconsistentWinding, 0, 'winding')
  })

  const flipped = new Uint32Array(cube.indices)
  const swap = flipped[6]
  flipped[6] = flipped[7]
  flipped[7] = swap
  await check('flipped-face', cube.positions, flipped, (report) => {
    if (report.inconsistentWinding < 1) {
      throw new Error(`expected winding defects, got ${report.inconsistentWinding}`)
    }
    assertEqual(report.watertightComponents, 0, 'watertight')
  })

  const degenerate = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  await check(
    'degenerate',
    degenerate,
    new Uint32Array([0, 0, 1]),
    (report) => {
      assertEqual(report.degenerate, 1, 'degenerate')
      assertEqual(report.watertightComponents, 0, 'watertight')
    },
  )

  const bad = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
  await check('bad-index', bad, new Uint32Array([0, 1, 99]), (report) => {
    assertEqual(report.badIndex, 1, 'badIndex')
    assertEqual(report.watertightComponents, 0, 'watertight')
  })

  const duplicated = new Uint32Array(cube.indices.length + 3)
  duplicated.set(cube.indices)
  duplicated.set(cube.indices.subarray(0, 3), cube.indices.length)
  await check('duplicate-face', cube.positions, duplicated, (report) => {
    if (report.duplicateFaces < 1) {
      throw new Error(`expected duplicate, got ${report.duplicateFaces}`)
    }
    if (report.nonManifoldEdges < 1) {
      throw new Error(`expected non-manifold, got ${report.nonManifoldEdges}`)
    }
  })

  const finPos = new Float32Array(cube.positions.length + 3)
  finPos.set(cube.positions)
  finPos.set([0.5, -1, 0.5], cube.positions.length)
  const finIdx = new Uint32Array(cube.indices.length + 3)
  finIdx.set(cube.indices)
  finIdx.set([0, 1, 8], cube.indices.length)
  await check('nonmanifold-fin', finPos, finIdx, (report) => {
    if (report.nonManifoldEdges < 1) {
      throw new Error(`expected non-manifold edge, got ${report.nonManifoldEdges}`)
    }
    assertEqual(report.watertightComponents, 0, 'watertight')
  })

  const twoPos = new Float32Array(cube.positions.length * 2)
  twoPos.set(cube.positions, 0)
  for (let i = 0; i < cube.positions.length; i += 3) {
    twoPos[cube.positions.length + i] = cube.positions[i] + 3
    twoPos[cube.positions.length + i + 1] = cube.positions[i + 1]
    twoPos[cube.positions.length + i + 2] = cube.positions[i + 2]
  }
  const twoIdx = new Uint32Array(cube.indices.length * 2)
  twoIdx.set(cube.indices)
  for (let i = 0; i < cube.indices.length; i++) {
    twoIdx[cube.indices.length + i] = cube.indices[i] + 8
  }
  await check('two-cubes', twoPos, twoIdx, (report) => {
    assertEqual(report.watertightComponents, 2, 'watertight')
    assertEqual(report.openComponents, 0, 'open')
    assertEqual(report.boundaryEdges, 0, 'boundary')
  })

  const closedBuf = await pack3mf(meshXml(cube.positions, cube.indices))
  const openBuf = await pack3mf(meshXml(cube.positions, openIdx))
  const fixtureDir = join(root, 'scripts', 'fixtures')
  mkdirSync(fixtureDir, { recursive: true })
  const closedPath = join(fixtureDir, 'closed-cube.3mf')
  const openPath = join(fixtureDir, 'open-boundary.3mf')
  if (process.argv.includes('--write-fixtures')) {
    writeFileSync(closedPath, closedBuf)
    writeFileSync(openPath, openBuf)
    console.log(`wrote ${closedPath}`)
    console.log(`wrote ${openPath}`)
  }

  const closedFile = await checkFile(
    existsSync(closedPath) ? readFileSync(closedPath) : closedBuf,
    pool,
    workers,
  )
  const openFile = await checkFile(
    existsSync(openPath) ? readFileSync(openPath) : openBuf,
    pool,
    workers,
  )
  if (!closedFile.ok) failures.push(`closed-cube.3mf did not pass: ${JSON.stringify(closedFile.packageErrors)}`)
  if (openFile.ok || openFile.boundaryEdges !== 4) {
    failures.push(
      `open-boundary.3mf expected 4 boundary edges, got ${openFile.boundaryEdges} ok=${openFile.ok}`,
    )
  } else {
    console.log(
      `fixture file closed-cube.3mf PASS ${closedFile.ms.toFixed(1)} ms; open-boundary.3mf FAIL as expected`,
    )
  }

  const junk = await checkFile(Buffer.from('not a 3mf'), pool, workers)
  if (junk.ok || !junk.packageErrors?.length) {
    failures.push('plain text was accepted as a 3MF')
  }

  const small = buildClosedGrid(12)
  const smallReport = await checkMesh(small.positions, small.indices, {
    workers: 1,
    pool: null,
  })
  if (!meshIsSolid(smallReport)) {
    failures.push(`12x12 grid is not solid ${JSON.stringify(smallReport)}`)
  }

  if (!process.argv.includes('--no-stress')) {
    const stressN = 420
    console.log(`\nstress grid ${stressN}x${stressN} (serial vs ${workers} workers)`)
    const grid = buildClosedGrid(stressN)
    const serial = await checkMesh(grid.positions, grid.indices, {
      workers: 1,
      pool: null,
    })
    const parallel = await checkMesh(grid.positions, grid.indices, {
      workers,
      pool,
    })
    console.log(
      `triangles ${parallel.triangles}  serial_wall_ms ${serial.ms.toFixed(1)}  parallel_wall_ms ${parallel.ms.toFixed(1)}  speedup ${(serial.ms / parallel.ms).toFixed(2)}x`,
    )
    console.log(
      `serial fill ${serial.fillMs.toFixed(1)} edges ${serial.edgeMs.toFixed(1)} components ${serial.componentMs.toFixed(1)}`,
    )
    console.log(
      `parallel fill ${parallel.fillMs.toFixed(1)} edges ${parallel.edgeMs.toFixed(1)} components ${parallel.componentMs.toFixed(1)} chunkCpu ${parallel.chunkCpuMs.toFixed(1)}`,
    )
    if (!sameDefects(serial, parallel)) {
      failures.push('stress grid serial/parallel defect mismatch')
    }
    if (!meshIsSolid(parallel)) {
      failures.push(`stress grid is not solid ${JSON.stringify(parallel)}`)
    } else {
      console.log('stress grid RESULT PASS')
    }
  }

  if (failures.length) {
    console.error('\nSELF-TEST FAILED')
    for (const failure of failures) console.error(failure)
    return false
  }
  console.log('\nSELF-TEST PASS')
  return true
}

function lib3mfCheck(file) {
  const py = `
import lib3mf, sys
path = sys.argv[1]
w = lib3mf.Wrapper()
model = w.CreateModel()
reader = model.QueryReader("3mf")
reader.SetStrictModeActive(True)
reader.ReadFromFile(path)
it = model.GetMeshObjects()
parts = []
while it.MoveNext():
    mesh = it.GetCurrentMeshObject()
    parts.append(1 if mesh.IsManifoldAndOriented() else 0)
ok = bool(parts) and all(parts)
print(("PASS" if ok else "FAIL") + " meshes=" + str(len(parts)) + " manifold=" + str(parts) + " warnings=" + str(reader.GetWarningCount()))
sys.exit(0 if ok else 2)
`
  return new Promise((resolvePromise) => {
    const child = spawn('python3', ['-c', py, file], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', () => resolvePromise({ status: 'skip', detail: 'python3 missing' }))
    child.on('close', (code) => {
      if (err.includes('ModuleNotFoundError') || err.includes('No module named')) {
        resolvePromise({ status: 'skip', detail: 'lib3mf not installed' })
        return
      }
      const line = (out || err).trim().split('\n').pop() || ''
      if (code === 0) resolvePromise({ status: 'pass', detail: line })
      else resolvePromise({ status: 'fail', detail: line || err.trim() })
    })
  })
}

function printHelp() {
  console.log(`Usage: node scripts/validate-3mf.mjs [--self-test] [--workers=N] [--no-stress] [file.3mf ...]

Checks 3MF package structure and mesh topology (manifold edges, winding,
watertight components). Large meshes are split across worker threads.`)
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    printHelp()
    return
  }
  const workerArg = args.find((arg) => arg.startsWith('--workers='))
  const workers = Math.max(
    1,
    workerArg ? Number(workerArg.split('=')[1]) : Math.min(cpus().length, 8),
  )
  const files = args.filter((arg) => !arg.startsWith('--'))
  const poolT0 = performance.now()
  const pool = workers > 1 ? createPool(workers) : null
  const poolMs = performance.now() - poolT0
  if (pool) console.log(`worker_pool ${workers}  init_ms ${poolMs.toFixed(1)}`)

  let ok = true
  try {
    if (args.includes('--self-test') || files.length === 0) {
      ok = (await selfTest(pool, workers)) && ok
    }
    for (const file of files) {
      const buf = readFileSync(resolve(file))
      const serial =
        buf.length < 80_000_000
          ? await checkFile(buf, null, 1)
          : null
      const parallel = await checkFile(buf, pool, workers)
      printReport(file, parallel)
      if (serial) {
        console.log(
          `serial_wall_ms ${serial.ms.toFixed(1)}  parallel_wall_ms ${parallel.ms.toFixed(1)}  speedup ${(serial.ms / Math.max(parallel.ms, 0.001)).toFixed(2)}x`,
        )
        if (!sameDefects(serial, parallel)) {
          console.error('serial and parallel defect counts differ')
          ok = false
        }
      }
      if (!parallel.ok) ok = false
      const lib = await lib3mfCheck(resolve(file))
      if (lib.status === 'skip') {
        console.log(`lib3mf: skipped (${lib.detail})`)
      } else {
        console.log(`lib3mf strict: ${lib.detail}`)
        if (lib.status !== 'pass') ok = false
      }
    }
  } finally {
    await pool?.close()
  }
  if (!ok) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
}
