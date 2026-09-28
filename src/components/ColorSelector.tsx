import { useEffect, useId, useState } from 'react'
import {
  COMBO_GROUPS,
  ENVIRONMENT_COMBOS,
  filamentById,
  type AmsUnits,
  type EnvironmentCombo,
} from '../lib/bambuColors'

export type LoadedCombo = { id: string; units: AmsUnits }

type Props = {
  open: boolean
  onClose: () => void
  loaded: LoadedCombo | null
  onLoad: (id: string, units: AmsUnits) => void
}

export function ColorSelector({ open, onClose, loaded, onLoad }: Props) {
  const titleId = useId()
  const [units, setUnits] = useState<AmsUnits>(loaded?.units ?? 1)
  const [draftId, setDraftId] = useState(loaded?.id ?? 'high-alpine')
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) {
      setUnits(loaded?.units ?? 1)
      setDraftId(loaded?.id ?? 'high-alpine')
    }
  }

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const draft = ENVIRONMENT_COMBOS.find((combo) => combo.id === draftId) ?? ENVIRONMENT_COMBOS[0]
  const loadedMatch = loaded?.id === draft.id && loaded.units === units

  return (
    <>
      {open ? (
        <button
          type="button"
          className="combo-backdrop"
          aria-label="Close color selector"
          onClick={onClose}
        />
      ) : null}
      <aside
        className={`combo-panel ${open ? 'open' : ''}`}
        role="dialog"
        aria-modal={open}
        aria-hidden={!open}
        aria-labelledby={titleId}
        inert={!open}
      >
        <div className="combo-head">
          <div>
            <p className="combo-kicker">Bambu Lab PLA</p>
            <h2 id={titleId}>Color selector</h2>
          </div>
          <button type="button" className="ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="combo-lede">
          Spool sets matched to the ground in the imagery. Hex codes are the ones Bambu
          publishes for these colors. Matte is used wherever that line stocks the hue.
        </p>

        <div className="combo-units" role="group" aria-label="AMS size">
          <button
            type="button"
            className={units === 1 ? 'on' : ''}
            aria-pressed={units === 1}
            onClick={() => setUnits(1)}
          >
            1 AMS · 4 spools
          </button>
          <button
            type="button"
            className={units === 2 ? 'on' : ''}
            aria-pressed={units === 2}
            onClick={() => setUnits(2)}
          >
            2 AMS · 8 spools
          </button>
        </div>
        <p className="combo-units-note">
          The route spool is turned off for terrain matching, so it prints only the raised line.
        </p>

        <div className="combo-scroll">
          {COMBO_GROUPS.map((group) => (
            <section key={group} className="combo-group">
              <h3>{group}</h3>
              <div role="radiogroup" aria-label={group}>
                {ENVIRONMENT_COMBOS.filter((combo) => combo.group === group).map((combo) => (
                  <ComboCard
                    key={combo.id}
                    combo={combo}
                    units={units}
                    selected={combo.id === draft.id}
                    onSelect={() => setDraftId(combo.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>

        <footer className="combo-foot">
          <button
            type="button"
            className="btn primary"
            disabled={loadedMatch}
            onClick={() => onLoad(draft.id, units)}
          >
            {loadedMatch ? `Loaded · ${draft.name}` : `Load ${draft.name}`}
          </button>
          <p>
            {units === 1 ? 'Four spools in one AMS' : 'Eight spools across two AMS units'}
            {' · '}
            route {routeName(draft)}
          </p>
        </footer>
      </aside>
    </>
  )
}

function routeName(combo: EnvironmentCombo): string {
  const slot = combo.core.find((entry) => entry.route)
  return slot ? filamentById(slot.filamentId).name : 'route'
}

function ComboCard({
  combo,
  units,
  selected,
  onSelect,
}: {
  combo: EnvironmentCombo
  units: AmsUnits
  selected: boolean
  onSelect: () => void
}) {
  const core = combo.core
  const extra = units === 2 ? combo.extra : []

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      className={`combo-card ${selected ? 'selected' : ''} ${combo.featured ? 'featured' : ''}`}
      onClick={onSelect}
    >
      <span className="combo-card-top">
        <span className="combo-card-name">{combo.name}</span>
        {combo.featured ? <span className="combo-tag">Above treeline</span> : null}
      </span>
      <span className="combo-card-summary">{combo.summary}</span>
      <SpoolGrid label="First AMS" slots={core} />
      {extra.length > 0 ? <SpoolGrid label="Second AMS" slots={extra} /> : null}
      <span className="combo-why">{combo.why}</span>
      {units === 2 ? <span className="combo-why extended">{combo.whyExtended}</span> : null}
    </button>
  )
}

function SpoolGrid({
  label,
  slots,
}: {
  label: string
  slots: EnvironmentCombo['core']
}) {
  return (
    <span className="combo-ams-block">
      <span className="combo-ams-label">{label}</span>
      <span className="combo-spools">
        {slots.map((slot) => {
          const filament = filamentById(slot.filamentId)
          const code = filament.code ? ` · ${filament.code}` : ''
          return (
            <span
              key={`${slot.filamentId}-${slot.role}`}
              className={`combo-spool ${slot.route ? 'route' : ''}`}
              title={`${filament.name} · ${filament.line}${code} · ${filament.hex} · ${slot.role}`}
            >
              <span className="combo-chip" style={{ background: filament.hex }} />
              <span className="combo-spool-name">{filament.name}</span>
              <span className="combo-spool-meta">
                {filament.line.replace('PLA ', '')}
                {slot.route ? ' · route' : ` · ${slot.role}`}
              </span>
            </span>
          )
        })}
      </span>
    </span>
  )
}
