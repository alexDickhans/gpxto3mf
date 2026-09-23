import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Dev-time tile/export proxy so DEM/imagery work without CORS. */
function tileProxyPlugin(): Plugin {
  const DEM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium'
  const IMG =
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile'
  const IMG_EXPORT =
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export'

  const cache = new Map<string, { buf: Buffer; ct: string }>()
  const MAX_CACHE = 400

  function sendCached(
    res: import('http').ServerResponse,
    key: string,
    fetchTarget: string,
  ) {
    return (async () => {
      const hit = cache.get(key)
      if (hit) {
        res.setHeader('Content-Type', hit.ct)
        res.setHeader('Cache-Control', 'public, max-age=86400')
        res.setHeader('X-Tile-Cache', 'HIT')
        res.end(hit.buf)
        return
      }
      const upstream = await fetch(fetchTarget, {
        headers: { 'User-Agent': 'gpxto3mf/1.0' },
      })
      if (!upstream.ok) {
        res.statusCode = upstream.status
        res.end(`Upstream ${upstream.status}`)
        return
      }
      const buf = Buffer.from(await upstream.arrayBuffer())
      const ct = upstream.headers.get('content-type') || 'image/png'
      if (cache.size >= MAX_CACHE) {
        const first = cache.keys().next().value
        if (first) cache.delete(first)
      }
      cache.set(key, { buf, ct })
      res.setHeader('Content-Type', ct)
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.setHeader('X-Tile-Cache', 'MISS')
      res.end(buf)
    })()
  }

  return {
    name: 'gpxto3mf-tile-proxy',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const raw = req.url || ''
        const pathOnly = raw.split('?')[0]

        // Single-image MapServer export for the whole bbox
        if (pathOnly === '/api/imagery-export') {
          try {
            const u = new URL(raw, 'http://localhost')
            const bbox = u.searchParams.get('bbox')
            const size = u.searchParams.get('size')
            const bboxSR = u.searchParams.get('bboxSR') || '4326'
            const imageSR = u.searchParams.get('imageSR') || '4326'
            const format = u.searchParams.get('format') || 'png'
            if (!bbox || !size || !/^-?\d/.test(bbox) || !/^\d+,\d+$/.test(size)) {
              res.statusCode = 400
              res.end('Bad export params')
              return
            }
            const target = new URL(IMG_EXPORT)
            target.searchParams.set('bbox', bbox)
            target.searchParams.set('bboxSR', bboxSR)
            target.searchParams.set('imageSR', imageSR)
            target.searchParams.set('size', size)
            target.searchParams.set('format', format)
            target.searchParams.set('transparent', 'false')
            target.searchParams.set('f', 'image')
            await sendCached(res, `export:${bbox}:${size}`, target.toString())
          } catch (err) {
            res.statusCode = 502
            res.end(err instanceof Error ? err.message : 'proxy error')
          }
          return
        }

        const dem = pathOnly.match(/^\/api\/dem\/(\d+)\/(\d+)\/(\d+)(?:\.png)?$/)
        const img = pathOnly.match(
          /^\/api\/imagery\/(\d+)\/(\d+)\/(\d+)(?:\.png)?$/,
        )
        const match = dem || img
        if (!match) return next()

        const [, z, x, y] = match
        const cacheKey = dem ? `dem:${z}/${x}/${y}` : `img:${z}/${x}/${y}`
        const target = dem
          ? `${DEM}/${z}/${x}/${y}.png`
          : `${IMG}/${z}/${y}/${x}`

        try {
          await sendCached(res, cacheKey, target)
        } catch (err) {
          res.statusCode = 502
          res.end(err instanceof Error ? err.message : 'proxy error')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tileProxyPlugin()],
})
