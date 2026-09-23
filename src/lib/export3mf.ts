import JSZip from 'jszip'
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
  // Avoid scientific notation; 4 decimals is enough for mm print
  return (Math.round(n * 10000) / 10000).toFixed(4)
}

/**
 * Write a Core 3MF + Materials Extension package that Bambu Studio / lib3mf accept.
 * Previous export put basematerials in the core xmlns (invalid) and used 6-digit colors.
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

  // Sanitize + validate geometry (NaN/OOB breaks lib3mf → “invalid 3MF”)
  const verts: string[] = []
  for (let i = 0; i < positions.length; i += 3) {
    verts.push(
      `<vertex x="${fmt(positions[i])}" y="${fmt(positions[i + 1])}" z="${fmt(positions[i + 2])}" />`,
    )
  }

  const tris: string[] = []
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
    tris.push(
      `<triangle v1="${i0}" v2="${i1}" v3="${i2}" pid="1" p1="${mat}" />`,
    )
  }

  if (tris.length < 1) {
    throw new Error('Mesh has no valid triangles to export')
  }

  // Unique material names (spec SHOULD; some loaders are picky)
  const usedNames = new Set<string>()
  const bases = materials
    .map((m, i) => {
      let name = (m.name || `Color ${i + 1}`).trim() || `Color ${i + 1}`
      if (usedNames.has(name)) name = `${name} ${i + 1}`
      usedNames.add(name)
      return `<m:base name="${esc(name)}" displaycolor="${displayColor(m.hex)}" />`
    })
    .join('\n      ')

  const safeTitle = esc((title || 'gpxto3mf').slice(0, 120))

  // Materials MUST live in the materials namespace with requiredextensions="m"
  const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" requiredextensions="m"
  xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"
  xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <metadata name="Title">${safeTitle}</metadata>
  <metadata name="Application">gpxto3mf</metadata>
  <resources>
    <m:basematerials id="1">
      ${bases}
    </m:basematerials>
    <object id="2" type="model" name="${safeTitle}" pid="1" pindex="0">
      <mesh>
        <vertices>
          ${verts.join('\n          ')}
        </vertices>
        <triangles>
          ${tris.join('\n          ')}
        </triangles>
      </mesh>
    </object>
  </resources>
  <build>
    <item objectid="2" />
  </build>
</model>
`

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

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.folder('_rels')!.file('.rels', rels)
  zip.folder('3D')!.file('3dmodel.model', modelXml)

  return zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
