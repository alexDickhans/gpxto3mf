import { deltaE76, hexToLab } from '../src/lib/palette'
import {
  BAMBU_FILAMENTS,
  ENVIRONMENT_COMBOS,
  filamentById,
  slotsFor,
  type AmsUnits,
  type ComboRole,
} from '../src/lib/bambuColors'

const TERRAIN_MIN = 12
const ROUTE_MIN = 22

let failed = 0

function fail(message: string) {
  failed += 1
  console.error(`FAIL ${message}`)
}

const ids = new Set<string>()
for (const filament of BAMBU_FILAMENTS) {
  if (ids.has(filament.id)) fail(`duplicate filament id ${filament.id}`)
  ids.add(filament.id)
  if (!/^#[0-9A-F]{6}$/.test(filament.hex)) fail(`bad hex ${filament.id} ${filament.hex}`)
}

const hexOwners = new Map<string, string[]>()
for (const filament of BAMBU_FILAMENTS) {
  const list = hexOwners.get(filament.hex) ?? []
  list.push(filament.id)
  hexOwners.set(filament.hex, list)
}

if (!ENVIRONMENT_COMBOS.some((combo) => combo.id === 'high-alpine' && combo.featured)) {
  fail('high alpine combo missing or not featured')
}

const seenCombo = new Set<string>()
for (const combo of ENVIRONMENT_COMBOS) {
  if (seenCombo.has(combo.id)) fail(`duplicate combo ${combo.id}`)
  seenCombo.add(combo.id)
  if (combo.core.length !== 4) fail(`${combo.id} core has ${combo.core.length} slots`)
  if (combo.extra.length !== 4) fail(`${combo.id} extra has ${combo.extra.length} slots`)
  const routes = combo.core.filter((slot) => slot.route)
  if (routes.length !== 1 || routes[0].terrain) fail(`${combo.id} core route spool`)
  if (combo.extra.some((slot) => slot.route || !slot.terrain)) {
    fail(`${combo.id} extra slots should all be terrain`)
  }

  for (const units of [1, 2] as AmsUnits[]) {
    const slots = slotsFor(combo, units)
    const used = new Set<string>()
    const hexs = new Set<string>()
    for (const slot of slots) {
      if (used.has(slot.filamentId)) fail(`${combo.id} repeats ${slot.filamentId} at ${units} AMS`)
      used.add(slot.filamentId)
      const filament = filamentById(slot.filamentId)
      if (hexs.has(filament.hex)) fail(`${combo.id} repeats hex ${filament.hex}`)
      hexs.add(filament.hex)
    }
    reportSeparation(combo.id, units, slots)
  }
}

function reportSeparation(comboId: string, units: AmsUnits, slots: ComboRole[]) {
  const terrain = slots.filter((slot) => slot.terrain)
  const routeSlot = slots.find((slot) => slot.route)
  let closest = Infinity
  let closestPair = ''
  for (let i = 0; i < terrain.length; i++) {
    for (let j = i + 1; j < terrain.length; j++) {
      const a = filamentById(terrain[i].filamentId)
      const b = filamentById(terrain[j].filamentId)
      const d = deltaE76(hexToLab(a.hex), hexToLab(b.hex))
      if (d < closest) {
        closest = d
        closestPair = `${a.name} / ${b.name}`
      }
      if (d < TERRAIN_MIN) {
        fail(`${comboId} ${units} AMS terrain ΔE ${d.toFixed(1)} ${a.name} vs ${b.name}`)
      }
    }
  }
  if (routeSlot) {
    const routeFilament = filamentById(routeSlot.filamentId)
    for (const slot of terrain) {
      const terrainFilament = filamentById(slot.filamentId)
      const d = deltaE76(hexToLab(routeFilament.hex), hexToLab(terrainFilament.hex))
      if (d < ROUTE_MIN) {
        fail(
          `${comboId} ${units} AMS route ΔE ${d.toFixed(1)} ${routeFilament.name} vs ${terrainFilament.name}`,
        )
      }
    }
  }
  console.log(
    `${comboId} · ${units} AMS · closest terrain ${closestPair} ΔE ${closest.toFixed(1)}`,
  )
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log(`OK · ${ENVIRONMENT_COMBOS.length} environments · ${BAMBU_FILAMENTS.length} spools`)
