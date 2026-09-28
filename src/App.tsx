import { useCallback, useEffect, useRef, useState, startTransition } from 'react'
import { Preview } from './components/Preview'
import { PaletteStrip } from './components/PaletteStrip'
import { ControlsDrawer, type ControlValues } from './components/ControlsDrawer'
import {
  DEFAULT_PALETTE,
  DEFAULTS,
  fetchTerrainGrids,
  gridsCacheKey,
  meshBuildOptions,
  parsePaletteText,
  type FetchSettings,
  type MeshSettings,
  type Palette,
  type TerrainGrids,
  type TerrainModel,
} from './lib/pipeline'
import {
  FETCH_RESOLUTION_MAX,
  FETCH_RESOLUTION_MIN,
  MESH_RESOLUTION_PREVIEW_MAX,
} from './lib/defaults'
import { IMAGERY_SEASONS, type ImagerySeason } from './lib/sentinelSeason'
import { pickRouteColorIndex, setColorEnabled } from './lib/palette'
import { buildMesh } from './lib/meshClient'
import { downloadBlob, export3mf } from './lib/export3mf'
import './App.css'

const initialControls: ControlValues = {
  exaggeration: DEFAULTS.exaggeration,
  bedSizeMm: DEFAULTS.bedSizeMm,
  routeHeightMm: DEFAULTS.routeHeightMm,
  routeWidthMm: DEFAULTS.routeWidthMm,
  bboxPadPercent: DEFAULTS.bboxPadPercent,
  fetchResolution: DEFAULTS.fetchResolution,
  minColorRegionMm: DEFAULTS.minColorRegionMm,
  colorEdgeSmooth: DEFAULTS.colorEdgeSmooth,
  baseThicknessMm: DEFAULTS.baseThicknessMm,
  colorShellMm: DEFAULTS.colorShellMm,
  colorMode: DEFAULTS.colorMode,
  showNorth: DEFAULTS.showNorth,
  showScale: DEFAULTS.showScale,
  imagerySeason: DEFAULTS.imagerySeason,
}

/** Settings that decide which pixels are downloaded — changing these refetches. */
function fetchSettingsOf(c: ControlValues): FetchSettings {
  return {
    bboxPadPercent: c.bboxPadPercent,
    fetchResolution: c.fetchResolution,
    imagerySeason: c.imagerySeason,
  }
}

function meshSettingsOf(
  c: ControlValues,
  routeColorIndex: number,
  meshResolution: number,
): MeshSettings {
  return {
    exaggeration: c.exaggeration,
    bedSizeMm: c.bedSizeMm,
    routeHeightMm: c.routeHeightMm,
    routeWidthMm: c.routeWidthMm,
    minColorRegionMm: c.minColorRegionMm,
    colorEdgeSmooth: c.colorEdgeSmooth,
    routeColorIndex,
    baseThicknessMm: c.baseThicknessMm,
    colorShellMm: c.colorShellMm,
    colorMode: c.colorMode,
    meshResolution,
  }
}

/** True when the two control sets need a new download rather than a remesh. */
function needsRefetch(a: ControlValues, b: ControlValues): boolean {
  return (
    a.bboxPadPercent !== b.bboxPadPercent ||
    a.fetchResolution !== b.fetchResolution ||
    a.imagerySeason !== b.imagerySeason
  )
}

/** Settings that reshape the mesh from grids already in memory. */
function needsRemesh(a: ControlValues, b: ControlValues): boolean {
  return (
    a.exaggeration !== b.exaggeration ||
    a.bedSizeMm !== b.bedSizeMm ||
    a.routeHeightMm !== b.routeHeightMm ||
    a.routeWidthMm !== b.routeWidthMm ||
    a.minColorRegionMm !== b.minColorRegionMm ||
    a.colorEdgeSmooth !== b.colorEdgeSmooth ||
    a.baseThicknessMm !== b.baseThicknessMm ||
    a.colorShellMm !== b.colorShellMm ||
    a.colorMode !== b.colorMode
  )
}

const PLA_G_PER_CM3 = 1.24

function describeModel(
  name: string,
  model: TerrainModel,
  fetchResolution: number,
  imageryLabel?: string,
): string {
  const cm3 = model.volumeMm3 / 1000
  const grams = cm3 * PLA_G_PER_CM3
  const season = imageryLabel ? ` · ${imageryLabel}` : ''
  const preview =
    model.meshResolution < fetchResolution
      ? ` · preview ${model.meshResolution}², exports at ${fetchResolution}²`
      : ''
  return (
    `${name} · ${model.materials.length} AMS colors · ` +
    `${model.extentMm.x.toFixed(0)}×${model.extentMm.y.toFixed(0)} mm · ` +
    `~${cm3.toFixed(0)} cm³ (${grams.toFixed(0)} g PLA if printed solid)` +
    `${season}${preview}`
  )
}

function App() {
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE)
  const [model, setModel] = useState<TerrainModel | null>(null)
  const [routeColorIndex, setRouteColorIndex] = useState(
    () => DEFAULT_PALETTE.colors.findIndex((c) => /route/i.test(c.name)) || 0,
  )
  const [controls, setControls] = useState<ControlValues>(initialControls)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [status, setStatus] = useState('Upload a GPX to raise a topo')
  const [busy, setBusy] = useState(false)
  const [trackName, setTrackName] = useState<string | null>(null)
  const [fitKey, setFitKey] = useState(0)
  const gpxTextRef = useRef<string | null>(null)
  const gridsRef = useRef<{ key: string; grids: TerrainGrids } | null>(null)
  /** Results from anything older than this id are dropped. */
  const buildIdRef = useRef(0)
  const debounceRef = useRef<number | null>(null)
  const gpxInputRef = useRef<HTMLInputElement>(null)
  const paletteInputRef = useRef<HTMLInputElement>(null)

  useEffect(
    () => () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    },
    [],
  )

  const build = useCallback(
    async (
      gpxText: string,
      pal: Palette,
      routeIdx: number | null,
      controlOverride?: ControlValues,
    ) => {
      const c = controlOverride ?? controls
      const id = ++buildIdRef.current
      const report = (msg: string) => {
        if (id === buildIdRef.current) setStatus(msg)
      }
      setBusy(true)
      try {
        const key = gridsCacheKey(gpxText, fetchSettingsOf(c))
        let entry = gridsRef.current
        if (!entry || entry.key !== key) {
          const grids = await fetchTerrainGrids(
            gpxText,
            fetchSettingsOf(c),
            report,
          )
          if (id !== buildIdRef.current) return
          entry = { key, grids }
          gridsRef.current = entry
        }

        report('Building mesh…')
        const resolvedRoute =
          routeIdx ?? pickRouteColorIndex(pal, entry.grids.averageRgb)
        const meshResolution = Math.min(
          c.fetchResolution,
          MESH_RESOLUTION_PREVIEW_MAX,
        )
        const built = await buildMesh(
          key,
          {
            track: entry.grids.track.points,
            height: entry.grids.height,
            colors: entry.grids.colors,
          },
          pal,
          meshBuildOptions(
            meshSettingsOf(c, resolvedRoute, meshResolution),
            resolvedRoute,
          ),
        )
        if (id !== buildIdRef.current) return

        const name = entry.grids.track.name
        const label = entry.grids.imageryLabel
        const gridRes = entry.grids.height.cols
        startTransition(() => {
          setModel(built)
          setTrackName(name)
          setRouteColorIndex(resolvedRoute)
          setStatus(describeModel(name, built, gridRes, label))
        })
      } catch (err) {
        if (id !== buildIdRef.current) return
        setStatus(err instanceof Error ? err.message : 'Build failed')
        console.error(err)
      } finally {
        if (id === buildIdRef.current) setBusy(false)
      }
    },
    [controls],
  )

  /** Coalesce bursts of toggles/sliders into one rebuild. */
  const scheduleBuild = useCallback(
    (pal: Palette, routeIdx: number | null, next?: ControlValues) => {
      if (!gpxTextRef.current) return
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null
        if (gpxTextRef.current) void build(gpxTextRef.current, pal, routeIdx, next)
      }, 250)
    },
    [build],
  )

  const onGpx = async (file: File) => {
    const text = await file.text()
    gpxTextRef.current = text
    gridsRef.current = null
    setFitKey((n) => n + 1)
    await build(text, palette, routeColorIndex)
  }

  const onPalette = async (file: File) => {
    const text = await file.text()
    try {
      const pal = parsePaletteText(text, file.name)
      setPalette(pal)
      setStatus(`Palette “${pal.name}” · ${pal.colors.length} colors`)
      if (gpxTextRef.current) {
        await build(gpxTextRef.current, pal, null)
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Palette parse failed')
    }
  }

  const onDownload = async () => {
    if (!model) return
    setBusy(true)
    try {
      let out = model
      const entry = gridsRef.current
      const fullRes = entry?.grids.height.cols ?? 0
      if (entry && model.meshResolution < fullRes) {
        setStatus(`Re-meshing at ${fullRes}² for export…`)
        out = await buildMesh(
          entry.key,
          {
            track: entry.grids.track.points,
            height: entry.grids.height,
            colors: entry.grids.colors,
          },
          palette,
          meshBuildOptions(
            meshSettingsOf(controls, routeColorIndex, fullRes),
            routeColorIndex,
          ),
        )
      }
      const triCount = out.indices.length / 3
      setStatus(
        triCount > 1_500_000
          ? `Writing large 3MF (${Math.round(triCount / 1e6)}M tris) — lower Fetch if Bambu rejects it…`
          : 'Writing 3MF…',
      )
      const blob = await export3mf(out, trackName || 'gpxto3mf')
      const safe = (trackName || 'topo').replace(/[^\w.-]+/g, '_')
      downloadBlob(blob, `${safe}.3mf`)
      setStatus(
        `Downloaded ${safe}.3mf — ${out.materials.length} objects, one per color. In Bambu use File → Import.`,
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const onRouteColorChange = (i: number) => {
    setRouteColorIndex(i)
    scheduleBuild(palette, i)
  }

  const onToggleEnabled = (i: number, enabled: boolean) => {
    const next = setColorEnabled(palette, i, enabled)
    setPalette(next)
    const onCount = next.colors.filter(
      (c, idx) => c.enabled !== false && idx !== routeColorIndex,
    ).length
    setStatus(
      `${enabled ? 'Enabled' : 'Disabled'} “${next.colors[i].name}” · ${onCount} terrain colors`,
    )
    scheduleBuild(next, routeColorIndex)
  }

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden />
      <Preview
        model={model}
        showNorth={controls.showNorth}
        showScale={controls.showScale}
        fitKey={fitKey}
      />

      <header className="hero">
        <p className="brand">gpxto3mf</p>
        <h1>Raise your line in AMS color</h1>
        <p className="lede">
          GPX in, multicolor topo out — terrain from real map hues, route as a
          raised filament line.
        </p>
        <div className="cta-row">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={() => gpxInputRef.current?.click()}
          >
            Upload GPX
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => paletteInputRef.current?.click()}
          >
            Import palette
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || !model}
            onClick={() => void onDownload()}
          >
            Download 3MF
          </button>
          <button
            type="button"
            className="btn ghost-btn"
            onClick={() => setDrawerOpen(true)}
          >
            Controls
          </button>
          <label className="season-select">
            <span className="quality-inline-label">Season</span>
            <select
              value={controls.imagerySeason}
              disabled={busy}
              aria-label="Imagery season"
              title="Northern-hemisphere months. Default keeps the Esri imagery mosaic."
              onChange={(e) => {
                const imagerySeason = e.target.value as ImagerySeason
                const next = { ...controls, imagerySeason }
                setControls(next)
                if (gpxTextRef.current) {
                  void build(gpxTextRef.current, palette, routeColorIndex, next)
                }
              }}
            >
              {IMAGERY_SEASONS.map((season) => (
                <option key={season.id} value={season.id}>
                  {season.label} · {season.detail}
                </option>
              ))}
            </select>
          </label>
          <label className="quality-inline fetch-slider">
            <span className="quality-inline-label">
              Fetch {controls.fetchResolution}²
            </span>
            <input
              type="range"
              min={FETCH_RESOLUTION_MIN}
              max={FETCH_RESOLUTION_MAX}
              step={16}
              value={controls.fetchResolution}
              disabled={busy}
              onChange={(e) =>
                setControls({
                  ...controls,
                  fetchResolution: parseInt(e.target.value, 10),
                })
              }
              aria-label="Fetch resolution"
            />
          </label>
        </div>
        <p className={`status ${busy ? 'busy' : ''}`}>{status}</p>
      </header>

      <footer className="chrome-bottom">
        <PaletteStrip
          palette={palette}
          usageCounts={model?.usageCounts ?? null}
          materials={model?.materials ?? null}
          routeColorIndex={routeColorIndex}
          onRouteColorChange={onRouteColorChange}
          onToggleEnabled={onToggleEnabled}
        />
      </footer>

      <ControlsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        values={controls}
        onChange={(next) => {
          const prev = controls
          setControls(next)
          if (!gpxTextRef.current) return
          if (next.imagerySeason !== prev.imagerySeason) {
            void build(gpxTextRef.current, palette, routeColorIndex, next)
            return
          }
          // Fetch-bound settings wait for the explicit rebuild; everything
          // else remeshes from the cached grids with no network round trip.
          if (!needsRefetch(prev, next) && needsRemesh(prev, next)) {
            scheduleBuild(palette, routeColorIndex, next)
          }
        }}
        canRebuild={!!gpxTextRef.current && !busy}
        busy={busy}
        onRebuild={() => {
          if (gpxTextRef.current) {
            void build(gpxTextRef.current, palette, routeColorIndex)
            setDrawerOpen(false)
          }
        }}
      />

      <input
        ref={gpxInputRef}
        type="file"
        accept=".gpx,application/gpx+xml,text/xml"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onGpx(f)
          e.target.value = ''
        }}
      />
      <input
        ref={paletteInputRef}
        type="file"
        accept=".json,.txt,.csv,application/json,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void onPalette(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export default App
