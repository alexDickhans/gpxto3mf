import type { CSSProperties } from 'react'
import { isColorEnabled, type Palette } from '../lib/palette'

type Props = {
  palette: Palette
  usageCounts: number[] | null
  materials: { name: string; hex: string }[] | null
  routeColorIndex: number
  onRouteColorChange: (i: number) => void
  onToggleEnabled: (i: number, enabled: boolean) => void
}

export function PaletteStrip({
  palette,
  usageCounts,
  materials,
  routeColorIndex,
  onRouteColorChange,
  onToggleEnabled,
}: Props) {
  const enabledCount = palette.colors.filter(isColorEnabled).length

  return (
    <div className="palette-strip" role="list" aria-label="AMS palette slots">
      {palette.colors.map((c, i) => {
        const used = materials?.find(
          (m) => m.hex.toUpperCase() === c.hex.toUpperCase(),
        )
        const countIdx = used
          ? materials!.findIndex(
              (m) => m.hex.toUpperCase() === c.hex.toUpperCase(),
            )
          : -1
        const count = countIdx >= 0 && usageCounts ? usageCounts[countIdx] : 0
        const isRoute = i === routeColorIndex
        const on = isColorEnabled(c)
        return (
          <div
            key={`${c.name}-${c.hex}`}
            role="listitem"
            className={`swatch ${on ? 'enabled' : 'disabled'} ${used || !materials ? 'used' : 'unused'} ${isRoute ? 'route' : ''}`}
            style={{ '--swatch': c.hex } as CSSProperties}
          >
            <button
              type="button"
              className="swatch-main"
              title={`${c.name} ${c.hex}${isRoute ? ' (route)' : ''} — click to set route`}
              onClick={() => onRouteColorChange(i)}
            >
              <span className="swatch-chip" />
              <span className="swatch-meta">
                <span className="swatch-name">{c.name}</span>
                <span className="swatch-count">
                  {materials ? (count > 0 ? count.toLocaleString() : '—') : 'AMS'}
                </span>
              </span>
            </button>
            <label className="swatch-toggle" title={on ? 'Disable for terrain' : 'Enable for terrain'}>
              <input
                type="checkbox"
                checked={on}
                disabled={on && enabledCount <= 1}
                onChange={(e) => onToggleEnabled(i, e.target.checked)}
                aria-label={`${on ? 'Disable' : 'Enable'} ${c.name}`}
              />
            </label>
          </div>
        )
      })}
      <p className="palette-hint">
        Click a swatch for route filament · checkbox enables terrain matching ({enabledCount} on)
      </p>
    </div>
  )
}
