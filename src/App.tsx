import { useCallback, useRef, useState, startTransition } from 'react'
import { Preview } from './components/Preview'
import { PaletteStrip } from './components/PaletteStrip'
import { ControlsDrawer, type ControlValues } from './components/ControlsDrawer'
import {
  DEFAULT_PALETTE,
  DEFAULTS,
  parsePaletteText,
  runPipeline,
  type Palette,
  type TerrainModel,
} from './lib/pipeline'
import {
  FETCH_RESOLUTION_MAX,
  FETCH_RESOLUTION_MIN,
} from './lib/defaults'
import { setColorEnabled } from './lib/palette'
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
  showNorth: DEFAULTS.showNorth,
  showScale: DEFAULTS.showScale,
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
  const gpxTextRef = useRef<string | null>(null)
  const gpxInputRef = useRef<HTMLInputElement>(null)
  const paletteInputRef = useRef<HTMLInputElement>(null)

  const build = useCallback(
    async (gpxText: string, pal: Palette, routeIdx: number | null) => {
      setBusy(true)
      try {
        const result = await runPipeline(
          gpxText,
          pal,
          {
            exaggeration: controls.exaggeration,
            bedSizeMm: controls.bedSizeMm,
            routeHeightMm: controls.routeHeightMm,
            routeWidthMm: controls.routeWidthMm,
            bboxPadPercent: controls.bboxPadPercent,
            fetchResolution: controls.fetchResolution,
            minColorRegionMm: controls.minColorRegionMm,
            colorEdgeSmooth: controls.colorEdgeSmooth,
            routeColorIndex: routeIdx,
          },
          (msg) => setStatus(msg),
        )
        startTransition(() => {
          setModel(result.model)
          setTrackName(result.track.name)
          setRouteColorIndex(result.routeColorIndex)
          setStatus(
            `${result.track.name} · ${result.model.materials.length} color meshes · ${result.model.extentMm.x.toFixed(0)}×${result.model.extentMm.y.toFixed(0)} mm`,
          )
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Build failed'
        setStatus(msg)
        console.error(err)
      } finally {
        setBusy(false)
      }
    },
    [controls],
  )

  const onGpx = async (file: File) => {
    const text = await file.text()
    gpxTextRef.current = text
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
    const triCount = model.indices.length / 3
    setStatus(
      triCount > 1_500_000
        ? `Writing large 3MF (${Math.round(triCount / 1e6)}M tris) — lower Fetch if Bambu rejects it…`
        : 'Writing 3MF…',
    )
    try {
      const blob = await export3mf(model, trackName || 'gpxto3mf')
      const safe = (trackName || 'topo').replace(/[^\w.-]+/g, '_')
      downloadBlob(blob, `${safe}.3mf`)
      setStatus(
        `Downloaded ${safe}.3mf — ${model.materials.length} objects, one per color. In Bambu use File → Import.`,
      )
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(false)
    }
  }

  const onRouteColorChange = (i: number) => {
    setRouteColorIndex(i)
    if (gpxTextRef.current) {
      void build(gpxTextRef.current, palette, i)
    }
  }

  const onToggleEnabled = (i: number, enabled: boolean) => {
    const next = setColorEnabled(palette, i, enabled)
    setPalette(next)
    const onCount = next.colors.filter((c) => c.enabled !== false).length
    setStatus(
      `${enabled ? 'Enabled' : 'Disabled'} “${next.colors[i].name}” · ${onCount} terrain colors`,
    )
    if (gpxTextRef.current) {
      void build(gpxTextRef.current, next, routeColorIndex)
    }
  }

  return (
    <div className="app">
      <div className="atmosphere" aria-hidden />
      <Preview
        model={model}
        showNorth={controls.showNorth}
        showScale={controls.showScale}
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
        onChange={setControls}
        canRebuild={!!gpxTextRef.current && !busy}
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
