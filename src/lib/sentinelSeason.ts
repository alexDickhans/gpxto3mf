/** Local copy so this module stays free of other imports (Vite's node tsconfig). */
type BBox = {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

/** Northern-hemisphere meteorological seasons. `default` is Esri World Imagery. */
export type ImagerySeason = 'default' | 'spring' | 'summer' | 'fall' | 'winter'

export type NamedSeason = Exclude<ImagerySeason, 'default'>

export const IMAGERY_SEASONS: {
  id: ImagerySeason
  label: string
  /** Month span, northern calendar */
  detail: string
}[] = [
  { id: 'default', label: 'Default', detail: 'Esri mosaic' },
  { id: 'spring', label: 'Spring', detail: 'Mar–May' },
  { id: 'summer', label: 'Summer', detail: 'Jun–Aug' },
  { id: 'fall', label: 'Fall', detail: 'Sep–Nov' },
  { id: 'winter', label: 'Winter', detail: 'Dec–Feb' },
]

const SENTINEL =
  'https://sentinel.arcgis.com/arcgis/rest/services/Sentinel2/ImageServer'

/** ImageServer exportImage rejects edges above this. */
const SENTINEL_MAX_PX = 4000

/** Prefer a recent season whose clearest scene is at least this clear (0–1). */
const CLEAR_CLOUD = 0.2

const YEARS_BACK = 4

/** Skip a season that has barely started — the previous year is the useful view. */
const MIN_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

const START_MONTH: Record<NamedSeason, number> = {
  spring: 3,
  summer: 6,
  fall: 9,
  winter: 12,
}

export function isNamedSeason(value: string | null): value is NamedSeason {
  return value === 'spring' || value === 'summer' || value === 'fall' || value === 'winter'
}

export function parseBBoxParam(bbox: string): BBox | null {
  if (!/^-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(bbox)) {
    return null
  }
  const [minLon, minLat, maxLon, maxLat] = bbox.split(',').map(Number)
  if (
    minLon >= maxLon ||
    minLat >= maxLat ||
    minLat < -90 ||
    maxLat > 90 ||
    minLon < -180 ||
    maxLon > 180
  ) {
    return null
  }
  return { minLon, minLat, maxLon, maxLat }
}

/** Square export edge, 2–4096. Sentinel itself caps at 4000. */
export function parseSizeParam(size: string): number | null {
  if (!/^\d{1,4},\d{1,4}$/.test(size)) return null
  const [w, h] = size.split(',').map(Number)
  if (w !== h || w < 2 || w > 4096) return null
  return w
}

type SeasonWindow = { start: number; end: number; label: string }

function utcMs(year: number, month: number, day: number) {
  return Date.UTC(year, month - 1, day)
}

/** Most recent window first. In-progress seasons are clipped to `now`. */
export function seasonWindows(season: NamedSeason, now = new Date()): SeasonWindow[] {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth() + 1
  const startMonth = START_MONTH[season]
  const latest =
    season === 'winter' ? (month >= 12 ? year : year - 1) : month >= startMonth ? year : year - 1
  const nowMs = now.getTime()
  const windows: SeasonWindow[] = []

  for (let i = 0; i < YEARS_BACK; i++) {
    const startYear = latest - i
    const start = utcMs(startYear, startMonth, 1)
    const end =
      season === 'winter' ? utcMs(startYear + 1, 3, 1) : utcMs(startYear, startMonth + 3, 1)
    if (start >= nowMs) continue
    const clipped = Math.min(end, nowMs)
    if (clipped - start < MIN_WINDOW_MS) continue
    const name = season.charAt(0).toUpperCase() + season.slice(1)
    const label =
      season === 'winter'
        ? `${name} ${startYear}–${String(startYear + 1).slice(2)}`
        : `${name} ${startYear}`
    windows.push({ start, end: clipped, label })
  }

  return windows
}

function envelope(bbox: BBox) {
  return JSON.stringify({
    xmin: bbox.minLon,
    ymin: bbox.minLat,
    xmax: bbox.maxLon,
    ymax: bbox.maxLat,
    spatialReference: { wkid: 4326 },
  })
}

/** Lowest scene cloud fraction in the window, or null when nothing was acquired. */
async function minCloud(bbox: BBox, start: number, end: number): Promise<number | null> {
  const params = new URLSearchParams({
    where: 'category = 1',
    geometry: envelope(bbox),
    geometryType: 'esriGeometryEnvelope',
    spatialRel: 'esriSpatialRelIntersects',
    time: `${start},${end}`,
    outStatistics: JSON.stringify([
      {
        statisticType: 'min',
        onStatisticField: 'cloudcover',
        outStatisticFieldName: 'minCloud',
      },
      {
        statisticType: 'count',
        onStatisticField: 'objectid',
        outStatisticFieldName: 'sceneCount',
      },
    ]),
    returnGeometry: 'false',
    f: 'json',
  })
  const res = await fetch(`${SENTINEL}/query?${params}`, { credentials: 'omit' })
  if (!res.ok) throw new Error(`Sentinel query failed: ${res.status}`)
  const data = (await res.json()) as {
    error?: { message?: string }
    features?: { attributes?: Record<string, unknown> }[]
  }
  if (data.error) throw new Error(data.error.message || 'Sentinel query failed')
  const attrs = data.features?.[0]?.attributes
  if (!attrs) return null
  const count = Number(attrs.sceneCount ?? attrs.scenecount ?? 0)
  if (!Number.isFinite(count) || count <= 0) return null
  const cloud = Number(attrs.minCloud ?? attrs.mincloud)
  return Number.isFinite(cloud) ? cloud : null
}

async function pickWindow(
  bbox: BBox,
  season: NamedSeason,
  onProgress?: (msg: string) => void,
): Promise<SeasonWindow> {
  const windows = seasonWindows(season)
  if (!windows.length) throw new Error(`No ${season} dates to search`)

  let clearest: { window: SeasonWindow; cloud: number } | null = null
  for (const window of windows) {
    onProgress?.(`${window.label} · checking clouds…`)
    const cloud = await minCloud(bbox, window.start, window.end)
    if (cloud == null) continue
    if (!clearest || cloud < clearest.cloud) clearest = { window, cloud }
    if (cloud <= CLEAR_CLOUD) return window
  }
  if (!clearest) {
    throw new Error(`No ${season} Sentinel-2 scene covers this map`)
  }
  return clearest.window
}

function exportUrl(bbox: BBox, side: number, window: SeasonWindow): string {
  const params = new URLSearchParams({
    bbox: `${bbox.minLon},${bbox.minLat},${bbox.maxLon},${bbox.maxLat}`,
    bboxSR: '4326',
    imageSR: '4326',
    size: `${side},${side}`,
    format: 'png',
    interpolation: 'RSP_BilinearInterpolation',
    time: `${window.start},${window.end}`,
    renderingRule: JSON.stringify({ rasterFunction: 'Natural Color' }),
    mosaicRule: JSON.stringify({
      mosaicMethod: 'esriMosaicAttribute',
      sortField: 'cloudcover',
      sortValue: 0,
      ascending: true,
      where: 'category = 1 AND cloudcover >= 0',
    }),
    f: 'image',
  })
  return `${SENTINEL}/exportImage?${params}`
}

/**
 * Clearest Sentinel-2 natural-color view of `bbox` inside the season.
 * Tries the latest years first and keeps the first window under 20% cloud.
 */
export async function fetchSentinelSeasonBlob(
  bbox: BBox,
  px: number,
  season: NamedSeason,
  onProgress?: (msg: string) => void,
): Promise<{ blob: Blob; label: string }> {
  const side = Math.max(2, Math.min(SENTINEL_MAX_PX, Math.round(px)))
  const window = await pickWindow(bbox, season, onProgress)
  onProgress?.(`${window.label} · fetching Sentinel-2…`)
  const res = await fetch(exportUrl(bbox, side, window), {
    credentials: 'omit',
    mode: 'cors',
  })
  if (!res.ok) throw new Error(`Sentinel export failed: ${res.status}`)
  const type = res.headers.get('content-type') || ''
  if (!type.startsWith('image/')) {
    throw new Error('Sentinel export was not an image')
  }
  return { blob: await res.blob(), label: window.label }
}
