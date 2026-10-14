import {
  deltaE76,
  enabledColorIndices,
  hexToLab,
  hexToRgb,
  matchTerrainCell,
  rgbToLab,
} from '../src/lib/palette'
import {
  BAMBU_FILAMENTS,
  ENVIRONMENT_COMBOS,
  comboById,
  comboToPalette,
  filamentById,
  slotsFor,
  type AmsUnits,
  type ComboRole,
} from '../src/lib/bambuColors'

const TERRAIN_MIN = 24
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

function labToRgb(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200
  const finv = (t: number) => {
    const t3 = t * t * t
    return t3 > 216 / 24389 ? t3 : (t - 4 / 29) * (108 / 841)
  }
  const x = finv(fx) * 0.95047
  const y = finv(fy)
  const z = finv(fz) * 1.08883
  const rl = x * 3.2404542 + y * -1.5371385 + z * -0.4985314
  const gl = x * -0.969266 + y * 1.8760108 + z * 0.041556
  const bl = x * 0.0556434 + y * -0.2040259 + z * 1.0572252
  const toSrgb = (c: number) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.max(0, Math.min(255, Math.round(v * 255)))
  }
  return [toSrgb(rl), toSrgb(gl), toSrgb(bl)]
}

function expectMatch(
  comboId: string,
  units: AmsUnits,
  rgb: [number, number, number],
  elev01: number,
  filamentId: string,
  label: string,
) {
  const palette = comboToPalette(comboById(comboId), units)
  const idxs = enabledColorIndices(palette)
  const labs = idxs.map((i) => hexToLab(palette.colors[i].hex))
  const lands = idxs.map((i) => palette.colors[i].land)
  const local = matchTerrainCell(rgb, elev01, labs, lands)
  const got = palette.colors[idxs[local]].name
  const want = filamentById(filamentId).name
  if (got !== want) fail(`${label}: got ${got}, want ${want}`)
  else console.log(`match ${label} → ${got}`)
}

const spool = (id: string) => hexToRgb(filamentById(id).hex)

expectMatch('high-alpine', 2, labToRgb(87, -5, -6), 0.85, 'ice-blue', 'pale glacier')
expectMatch('high-alpine', 2, spool('ivory-white'), 0.9, 'ivory-white', 'sunlit snow')
expectMatch('high-alpine', 2, labToRgb(41, 8, 22), 0.4, 'dark-chocolate', 'talus')
expectMatch('high-alpine', 2, labToRgb(66, -16, -23), 0.2, 'marine-blue', 'tarn')
expectMatch('high-alpine', 2, spool('dark-green'), 0.5, 'dark-green', 'krummholz')
expectMatch('winter-forest', 2, labToRgb(76, -1, -6), 0.8, 'ice-blue', 'shaded snow')
expectMatch('autumn-woodland', 2, spool('lemon-yellow'), 0.4, 'lemon-yellow', 'lemon spool')
expectMatch('autumn-woodland', 2, labToRgb(85, -4, 66), 0.4, 'lemon-yellow', 'aspen')
expectMatch('autumn-woodland', 2, spool('mandarin-orange'), 0.4, 'mandarin-orange', 'maple')
expectMatch('tropical', 2, labToRgb(21, -12, 14), 0.3, 'dark-green', 'dark moss')
expectMatch('tropical', 2, spool('ash-gray'), 0.4, 'ash-gray', 'granite')
expectMatch('volcanic', 2, labToRgb(75, 0, 6), 0.4, 'nardo-gray', 'volcanic ash')
expectMatch('coast', 2, spool('ice-blue'), 0.05, 'ice-blue', 'shallows')

// Guard the Lab→RGB round trip so a bad inverse cannot fake a pass.
const glacier = labToRgb(87, -5, -6)
const glacierLab = rgbToLab(glacier[0], glacier[1], glacier[2])
if (Math.abs(glacierLab[0] - 87) > 2 || Math.abs(glacierLab[2] + 6) > 2) {
  fail(`lab inverse drifted (${glacierLab.map((n) => n.toFixed(1)).join(', ')})`)
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`)
  process.exit(1)
}
console.log(`OK · ${ENVIRONMENT_COMBOS.length} environments · ${BAMBU_FILAMENTS.length} spools`)
