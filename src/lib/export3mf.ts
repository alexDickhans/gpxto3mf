import type { TerrainModel } from './mesh'

function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 3MF ST_ColorValue: #RRGGBB or #RRGGBBAA (Bambu/lib3mf prefer 8-digit). */
function displayColor(hex: string): string {
  let h = hex.trim().replace(/^#/, '').toUpperCase()
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (h.length === 6) h = `${h}FF`
  if (!/^[0-9A-F]{8}$/.test(h)) h = '808080FF'
  return `#${h}`
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return (Math.round(n * 10000) / 10000).toFixed(4)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32Update(crc: number, data: Uint8Array) {
  let c = crc >>> 0
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  }
  return c >>> 0
}

const encoder = new TextEncoder()

/** Appends XML in small chunks so a large mesh never becomes one string. */
class XmlSink {
  chunks: Uint8Array[] = []
  pending = ''
  crc = 0xffffffff
  size = 0

  write(text: string) {
    this.pending += text
    if (this.pending.length >= 65536) this.flush()
  }

  flush() {
    if (!this.pending) return
    const bytes = encoder.encode(this.pending)
    this.pending = ''
    this.crc = crc32Update(this.crc, bytes)
    this.size += bytes.length
    this.chunks.push(bytes)
  }

  finish() {
    this.flush()
    return {
      chunks: this.chunks,
      crc: (this.crc ^ 0xffffffff) >>> 0,
      size: this.size,
    }
  }
}

class StoreZip {
  private parts: BlobPart[] = []
  private offset = 0
  private entries: { name: string; crc: number; size: number; offset: number }[] =
    []

  add(name: string, body: { chunks: Uint8Array[]; crc: number; size: number }) {
    const nameBytes = encoder.encode(name)
    const header = new Uint8Array(30 + nameBytes.length)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, 0, true)
    view.setUint16(8, 0, true)
    view.setUint16(10, 0, true)
    view.setUint16(12, 0, true)
    view.setUint32(14, body.crc, true)
    view.setUint32(18, body.size, true)
    view.setUint32(22, body.size, true)
    view.setUint16(26, nameBytes.length, true)
    view.setUint16(28, 0, true)
    header.set(nameBytes, 30)
    this.parts.push(header)
    for (const chunk of body.chunks) this.parts.push(chunk)
    this.entries.push({
      name,
      crc: body.crc,
      size: body.size,
      offset: this.offset,
    })
    this.offset += header.length + body.size
  }

  blob() {
    const central: Uint8Array[] = []
    let centralSize = 0
    for (const entry of this.entries) {
      const nameBytes = encoder.encode(entry.name)
      const rec = new Uint8Array(46 + nameBytes.length)
      const view = new DataView(rec.buffer)
      view.setUint32(0, 0x02014b50, true)
      view.setUint16(4, 20, true)
      view.setUint16(6, 20, true)
      view.setUint16(8, 0, true)
      view.setUint16(10, 0, true)
      view.setUint16(12, 0, true)
      view.setUint16(14, 0, true)
      view.setUint32(16, entry.crc, true)
      view.setUint32(20, entry.size, true)
      view.setUint32(24, entry.size, true)
      view.setUint16(28, nameBytes.length, true)
      view.setUint16(30, 0, true)
      view.setUint16(32, 0, true)
      view.setUint16(34, 0, true)
      view.setUint16(36, 0, true)
      view.setUint32(38, 0, true)
      view.setUint32(42, entry.offset, true)
      rec.set(nameBytes, 46)
      central.push(rec)
      centralSize += rec.length
    }
    const end = new Uint8Array(22)
    const view = new DataView(end.buffer)
    view.setUint32(0, 0x06054b50, true)
    view.setUint16(8, this.entries.length, true)
    view.setUint16(10, this.entries.length, true)
    view.setUint32(12, centralSize, true)
    view.setUint32(16, this.offset, true)
    return new Blob([...this.parts, ...central, end], {
      type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml',
    })
  }
}

function textPart(text: string) {
  const sink = new XmlSink()
  sink.write(text)
  return sink.finish()
}

/**
 * One closed mesh per palette color. Bambu assigns filament per object, so
 * triangle painting on a single shell does not load as separate AMS parts.
 * lib3mf 2.x wants core `<basematerials>` (not the m: namespace) and #RRGGBBAA.
 */
export async function export3mf(
  model: TerrainModel,
  title = 'gpxto3mf',
): Promise<Blob> {
  const { positions, indices, triMaterials, materials } = model
  const vertCount = positions.length / 3
  const triCount = indices.length / 3

  if (vertCount < 3 || triCount < 1) {
    throw new Error('Mesh is empty — nothing to export')
  }
  if (materials.length < 1) {
    throw new Error('Mesh has no materials')
  }

  const counts = new Uint32Array(materials.length)
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3]
    const i1 = indices[t * 3 + 1]
    const i2 = indices[t * 3 + 2]
    if (
      i0 === i1 ||
      i1 === i2 ||
      i0 === i2 ||
      i0 < 0 ||
      i1 < 0 ||
      i2 < 0 ||
      i0 >= vertCount ||
      i1 >= vertCount ||
      i2 >= vertCount
    ) {
      continue
    }
    let mat = triMaterials[t] ?? 0
    if (mat < 0 || mat >= materials.length) mat = 0
    counts[mat]++
  }

  const groups = Array.from(counts, (n) => new Uint32Array(n * 3))
  const cursor = new Uint32Array(materials.length)
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3]
    const i1 = indices[t * 3 + 1]
    const i2 = indices[t * 3 + 2]
    if (
      i0 === i1 ||
      i1 === i2 ||
      i0 === i2 ||
      i0 < 0 ||
      i1 < 0 ||
      i2 < 0 ||
      i0 >= vertCount ||
      i1 >= vertCount ||
      i2 >= vertCount
    ) {
      continue
    }
    let mat = triMaterials[t] ?? 0
    if (mat < 0 || mat >= materials.length) mat = 0
    const at = cursor[mat]
    const group = groups[mat]
    group[at] = i0
    group[at + 1] = i1
    group[at + 2] = i2
    cursor[mat] = at + 3
  }

  const usedNames = new Set<string>()
  const bases = materials
    .map((m, i) => {
      let name = (m.name || `Color ${i + 1}`).trim() || `Color ${i + 1}`
      if (usedNames.has(name)) name = `${name} ${i + 1}`
      usedNames.add(name)
      return { name, hex: m.hex }
    })

  const safeTitle = esc((title || 'gpxto3mf').slice(0, 120))
  const xml = new XmlSink()
  xml.write(`<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Title">${safeTitle}</metadata>
  <metadata name="Application">gpxto3mf</metadata>
  <resources>
    <basematerials id="1">
`)
  for (const base of bases) {
    xml.write(
      `      <base name="${esc(base.name)}" displaycolor="${displayColor(base.hex)}" />\n`,
    )
  }
  xml.write(`    </basematerials>\n`)

  const remap = new Int32Array(vertCount)
  remap.fill(-1)
  const used: number[] = []
  let objectId = 2
  const buildIds: number[] = []

  for (let mat = 0; mat < groups.length; mat++) {
    const group = groups[mat]
    if (group.length < 3) continue
    used.length = 0
    for (let k = 0; k < group.length; k++) {
      const vi = group[k]
      if (remap[vi] < 0) {
        remap[vi] = used.length
        used.push(vi)
      }
    }
    if (used.length < 3) {
      for (const vi of used) remap[vi] = -1
      continue
    }

    const name = esc(bases[mat].name)
    xml.write(`    <object id="${objectId}" type="model" name="${name}" pid="1" pindex="${mat}">
      <mesh>
        <vertices>
`)
    for (const vi of used) {
      const o = vi * 3
      xml.write(
        `          <vertex x="${fmt(positions[o])}" y="${fmt(positions[o + 1])}" z="${fmt(positions[o + 2])}" />\n`,
      )
    }
    xml.write(`        </vertices>
        <triangles>
`)
    for (let k = 0; k < group.length; k += 3) {
      xml.write(
        `          <triangle v1="${remap[group[k]]}" v2="${remap[group[k + 1]]}" v3="${remap[group[k + 2]]}" pid="1" p1="${mat}" />\n`,
      )
    }
    xml.write(`        </triangles>
      </mesh>
    </object>
`)
    buildIds.push(objectId)
    objectId++
    for (const vi of used) remap[vi] = -1
  }

  if (buildIds.length < 1) {
    throw new Error('Mesh has no valid triangles to export')
  }

  xml.write(`  </resources>
  <build>
`)
  for (const id of buildIds) {
    xml.write(`    <item objectid="${id}" />\n`)
  }
  xml.write(`  </build>
</model>
`)

  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
  <Override PartName="/3D/3dmodel.model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml" />
</Types>
`

  const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0"
    Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel" />
</Relationships>
`

  const zip = new StoreZip()
  zip.add('[Content_Types].xml', textPart(contentTypes))
  zip.add('_rels/.rels', textPart(rels))
  zip.add('3D/3dmodel.model', xml.finish())
  return zip.blob()
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
