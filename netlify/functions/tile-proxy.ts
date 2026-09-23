import type { Config, Context } from '@netlify/functions'

const DEM_BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
const IMAGERY_BASE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'
const IMAGERY_EXPORT =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'

function corsHeaders(extra: Record<string, string> = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    ...extra,
  }
}

function tileUrl(kind: string, path: string): string | null {
  const clean = path.replace(/^\/+/, '').replace(/\.\./g, '')
  if (!/^\d+\/\d+\/\d+(\.png)?$/i.test(clean)) return null

  if (kind === 'dem') {
    const withExt = clean.toLowerCase().endsWith('.png') ? clean : `${clean}.png`
    return `${DEM_BASE}/${withExt}`
  }
  if (kind === 'imagery') {
    const [z, x, y] = clean.replace(/\.png$/i, '').split('/')
    return `${IMAGERY_BASE}/${z}/${y}/${x}`
  }
  return null
}

function exportUpstream(url: URL): string | null {
  const bbox = url.searchParams.get('bbox')
  const size = url.searchParams.get('size')
  if (!bbox || !size) return null
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bbox)) {
    return null
  }
  if (!/^\d{1,4},\d{1,4}$/.test(size)) return null
  const [w, h] = size.split(',').map(Number)
  if (w < 1 || h < 1 || w > 4096 || h > 4096) return null

  const target = new URL(IMAGERY_EXPORT)
  target.searchParams.set('bbox', bbox)
  target.searchParams.set('bboxSR', url.searchParams.get('bboxSR') || '4326')
  target.searchParams.set('imageSR', url.searchParams.get('imageSR') || '4326')
  target.searchParams.set('size', size)
  target.searchParams.set('format', url.searchParams.get('format') || 'png')
  target.searchParams.set('transparent', 'false')
  target.searchParams.set('f', 'image')
  return target.toString()
}

export default async (req: Request, _context: Context) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  const url = new URL(req.url)

  // Single-image export for the whole bbox
  if (url.pathname === '/api/imagery-export' || url.pathname.endsWith('/imagery-export')) {
    const upstream = exportUpstream(url)
    if (!upstream) {
      return new Response('Bad export params', { status: 400, headers: corsHeaders() })
    }
    try {
      const res = await fetch(upstream, {
        headers: { 'User-Agent': 'gpxto3mf/1.0 (Netlify)' },
      })
      if (!res.ok) {
        return new Response(`Upstream ${res.status}`, {
          status: res.status,
          headers: corsHeaders(),
        })
      }
      const buf = await res.arrayBuffer()
      const ct = res.headers.get('content-type') || 'image/png'
      return new Response(buf, {
        status: 200,
        headers: corsHeaders({
          'Content-Type': ct,
          'Cache-Control': 'public, max-age=86400',
        }),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'fetch failed'
      return new Response(msg, { status: 502, headers: corsHeaders() })
    }
  }

  const m = url.pathname.match(/\/api\/(dem|imagery)\/(.+)$/)
  const kind = m?.[1] ?? url.searchParams.get('kind')
  const path = m?.[2] ?? url.searchParams.get('path')
  if (!kind || !path) {
    return new Response('Bad tile path', { status: 400, headers: corsHeaders() })
  }

  const upstream = tileUrl(kind, path)
  if (!upstream) {
    return new Response('Bad tile path', { status: 400, headers: corsHeaders() })
  }

  try {
    const res = await fetch(upstream, {
      headers: { 'User-Agent': 'gpxto3mf/1.0 (Netlify)' },
    })
    if (!res.ok) {
      return new Response(`Upstream ${res.status}`, {
        status: res.status,
        headers: corsHeaders(),
      })
    }
    const buf = await res.arrayBuffer()
    const ct = res.headers.get('content-type') || 'image/png'
    return new Response(buf, {
      status: 200,
      headers: corsHeaders({
        'Content-Type': ct,
        'Cache-Control': 'public, max-age=86400',
      }),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'fetch failed'
    return new Response(msg, { status: 502, headers: corsHeaders() })
  }
}

export const config: Config = {
  path: ['/api/dem/*', '/api/imagery/*', '/api/imagery-export'],
}
