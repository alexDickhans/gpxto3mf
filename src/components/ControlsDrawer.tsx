import {
  DEFAULTS,
  FETCH_RESOLUTION_MAX,
  FETCH_RESOLUTION_MIN,
} from '../lib/defaults'

export type ControlValues = {
  exaggeration: number
  bedSizeMm: number
  routeHeightMm: number
  routeWidthMm: number
  bboxPadPercent: number
  fetchResolution: number
  minColorRegionMm: number
  colorEdgeSmooth: number
  showNorth: boolean
  showScale: boolean
}

type Props = {
  open: boolean
  onClose: () => void
  values: ControlValues
  onChange: (v: ControlValues) => void
  onRebuild: () => void
  canRebuild: boolean
}

export function ControlsDrawer({
  open,
  onClose,
  values,
  onChange,
  onRebuild,
  canRebuild,
}: Props) {
  const set = <K extends keyof ControlValues>(key: K, val: ControlValues[K]) =>
    onChange({ ...values, [key]: val })

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
            showNorth: DEFAULTS.showNorth,
            showScale: DEFAULTS.showScale,
          })
        }
      >
        Reset climbing defaults
      </button>
    </aside>
  )
}
