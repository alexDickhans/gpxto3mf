import {
  BASE_THICKNESS_MIN_MM,
  COLOR_MODES,
  DEFAULTS,
  estimateTriangleCount,
  FETCH_RESOLUTION_MAX,
  FETCH_RESOLUTION_MIN,
  MESH_RESOLUTION_PREVIEW_MAX,
  type ColorMode,
} from '../lib/defaults'
import { IMAGERY_SEASONS, type ImagerySeason } from '../lib/sentinelSeason'

export type ControlValues = {
  exaggeration: number
  bedSizeMm: number
  routeHeightMm: number
  routeWidthMm: number
  bboxPadPercent: number
  fetchResolution: number
  minColorRegionMm: number
  colorEdgeSmooth: number
  baseThicknessMm: number
  maxReliefMm: number
  colorShellMm: number
  colorMode: ColorMode
  showNorth: boolean
  showScale: boolean
  imagerySeason: ImagerySeason
}

function triangleNote(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

type Props = {
  open: boolean
  onClose: () => void
  values: ControlValues
  onChange: (v: ControlValues) => void
  onRebuild: () => void
  canRebuild: boolean
  busy: boolean
}

export function ControlsDrawer({
  open,
  onClose,
  values,
  onChange,
  onRebuild,
  canRebuild,
  busy,
}: Props) {
  const set = <K extends keyof ControlValues>(key: K, val: ControlValues[K]) =>
    onChange({ ...values, [key]: val })

  const previewRes = Math.min(values.fetchResolution, MESH_RESOLUTION_PREVIEW_MAX)
  const previewTris = estimateTriangleCount(previewRes, values.colorShellMm)
  const exportTris = estimateTriangleCount(
    values.fetchResolution,
    values.colorShellMm,
  )

  return (
    <aside className={`drawer ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="drawer-head">
        <h2>Print controls</h2>
        <button type="button" className="ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <label className="field">
        <span>
          Imagery
          <em className="field-sub"> northern months · Default is the Esri mosaic</em>
        </span>
        <select
          value={values.imagerySeason}
          disabled={busy}
          aria-label="Imagery season"
          onChange={(e) => set('imagerySeason', e.target.value as ImagerySeason)}
        >
          {IMAGERY_SEASONS.map((season) => (
            <option key={season.id} value={season.id}>
              {season.label} · {season.detail}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>
          Terrain colors
          <em className="field-sub">
            {' '}
            {COLOR_MODES.find((m) => m.id === values.colorMode)?.hint}
          </em>
        </span>
        <select
          value={values.colorMode}
          aria-label="Terrain color mode"
          onChange={(e) => set('colorMode', e.target.value as ColorMode)}
        >
          {COLOR_MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>
          Fetch resolution · {values.fetchResolution}²
          <em className="field-sub">
            {' '}
            (balanced {FETCH_RESOLUTION_MIN} → max {FETCH_RESOLUTION_MAX})
          </em>
        </span>
        <input
          type="range"
          min={FETCH_RESOLUTION_MIN}
          max={FETCH_RESOLUTION_MAX}
          step={16}
          value={values.fetchResolution}
          onChange={(e) => set('fetchResolution', parseInt(e.target.value, 10))}
        />
        <em className="field-sub">
          Preview meshes at {previewRes}² (~{triangleNote(previewTris)} tris);
          the 3MF exports at {values.fetchResolution}² (~
          {triangleNote(exportTris)} tris).
          {exportTris > 3e6
            ? ' That export is heavy — Bambu Studio may refuse it.'
            : ''}{' '}
          Changing this needs a refetch: press Rebuild topo.
        </em>
      </label>

      <label className="field">
        <span>
          Min color patch · {values.minColorRegionMm.toFixed(1)} mm
          <em className="field-sub"> (merge smaller speckles for AMS)</em>
        </span>
        <input
          type="range"
          min={0}
          max={12}
          step={0.5}
          value={values.minColorRegionMm}
          onChange={(e) => set('minColorRegionMm', parseFloat(e.target.value))}
        />
      </label>

      <label className="field">
        <span>
          Color edge smooth · {Math.round(values.colorEdgeSmooth * 100)}%
          <em className="field-sub"> (round stair-stepped color borders)</em>
        </span>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(values.colorEdgeSmooth * 100)}
          onChange={(e) =>
            set('colorEdgeSmooth', parseInt(e.target.value, 10) / 100)
          }
        />
      </label>

      <label className="field">
        <span>
          Color shell · {values.colorShellMm.toFixed(1)} mm
          <em className="field-sub">
            {values.colorShellMm > 0.05
              ? ' (only the top layers swap filament)'
              : ' (0 = every color runs floor to summit)'}
          </em>
        </span>
        <input
          type="range"
          min={0}
          max={4}
          step={0.2}
          value={values.colorShellMm}
          onChange={(e) => set('colorShellMm', parseFloat(e.target.value))}
        />
      </label>

      <label className="field">
        <span>
          Base thickness · {values.baseThicknessMm.toFixed(1)} mm
          <em className="field-sub"> (single-color slab under the shell)</em>
        </span>
        <input
          type="range"
          min={BASE_THICKNESS_MIN_MM}
          max={6}
          step={0.2}
          value={values.baseThicknessMm}
          onChange={(e) => set('baseThicknessMm', parseFloat(e.target.value))}
        />
      </label>

      <label className="field">
        <span>
          Max relief · {values.maxReliefMm} mm
          <em className="field-sub">
            {' '}
            (caps the vertical so steep bboxes stay on the plate)
          </em>
        </span>
        <input
          type="range"
          min={10}
          max={150}
          step={5}
          value={values.maxReliefMm}
          onChange={(e) => set('maxReliefMm', parseInt(e.target.value, 10))}
        />
      </label>

      <label className="field">
        <span>Vertical exaggeration · {values.exaggeration.toFixed(1)}×</span>
        <input
          type="range"
          min={1}
          max={3}
          step={0.1}
          value={values.exaggeration}
          onChange={(e) => set('exaggeration', parseFloat(e.target.value))}
        />
      </label>

      <label className="field">
        <span>Bed fit · {values.bedSizeMm} mm</span>
        <input
          type="range"
          min={80}
          max={300}
          step={5}
          value={values.bedSizeMm}
          onChange={(e) => set('bedSizeMm', parseInt(e.target.value, 10))}
        />
      </label>

      <label className="field">
        <span>Route height · {values.routeHeightMm.toFixed(1)} mm</span>
        <input
          type="range"
          min={0.4}
          max={3}
          step={0.1}
          value={values.routeHeightMm}
          onChange={(e) => set('routeHeightMm', parseFloat(e.target.value))}
        />
      </label>

      <label className="field">
        <span>Route width · {values.routeWidthMm.toFixed(1)} mm</span>
        <input
          type="range"
          min={0.6}
          max={4}
          step={0.1}
          value={values.routeWidthMm}
          onChange={(e) => set('routeWidthMm', parseFloat(e.target.value))}
        />
      </label>

      <label className="field">
        <span>Bbox pad · {values.bboxPadPercent}%</span>
        <input
          type="range"
          min={0}
          max={30}
          step={1}
          value={values.bboxPadPercent}
          onChange={(e) => set('bboxPadPercent', parseInt(e.target.value, 10))}
        />
      </label>

      <label className="check">
        <input
          type="checkbox"
          checked={values.showNorth}
          onChange={(e) => set('showNorth', e.target.checked)}
        />
        North mark
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={values.showScale}
          onChange={(e) => set('showScale', e.target.checked)}
        />
        Scale bar
      </label>

      <button
        type="button"
        className="btn primary drawer-apply"
        disabled={!canRebuild}
        onClick={onRebuild}
      >
        Rebuild topo
      </button>
      <button
        type="button"
        className="ghost reset"
        onClick={() =>
          onChange({
            exaggeration: DEFAULTS.exaggeration,
            bedSizeMm: DEFAULTS.bedSizeMm,
            routeHeightMm: DEFAULTS.routeHeightMm,
            routeWidthMm: DEFAULTS.routeWidthMm,
            bboxPadPercent: DEFAULTS.bboxPadPercent,
            fetchResolution: DEFAULTS.fetchResolution,
            minColorRegionMm: DEFAULTS.minColorRegionMm,
            colorEdgeSmooth: DEFAULTS.colorEdgeSmooth,
            baseThicknessMm: DEFAULTS.baseThicknessMm,
            maxReliefMm: DEFAULTS.maxReliefMm,
            colorShellMm: DEFAULTS.colorShellMm,
            colorMode: DEFAULTS.colorMode,
            showNorth: DEFAULTS.showNorth,
            showScale: DEFAULTS.showScale,
            imagerySeason: DEFAULTS.imagerySeason,
          })
        }
      >
        Reset climbing defaults
      </button>
    </aside>
  )
}
