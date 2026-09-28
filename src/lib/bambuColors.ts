import type { Palette } from './palette'

/**
 * Published Bambu Lab spool colors.
 * PLA Basic hex + color codes: Bambu Lab PLA Basic hex table.
 * PLA Matte hex: Bambu Lab PLA Matte hex card.
 * Matte Charcoal and Matte Ivory White publish as #000000 and #FFFFFF.
 */
export type FilamentLine = 'PLA Basic' | 'PLA Matte'

export type BambuFilament = {
  id: string
  name: string
  line: FilamentLine
  hex: string
  /** Spool color code, when Bambu publishes one for that line. */
  code?: string
}

export type ComboRole = {
  filamentId: string
  /** What this spool stands in for on the topo. */
  role: string
  /** False for the route spool, so it is skipped in terrain matching. */
  terrain: boolean
  route?: boolean
}

export type ComboGroup = 'High country' | 'Woods' | 'Dry ground' | 'Water'

export const COMBO_GROUPS: ComboGroup[] = [
  'High country',
  'Woods',
  'Dry ground',
  'Water',
]

export type AmsUnits = 1 | 2

export type EnvironmentCombo = {
  id: string
  name: string
  group: ComboGroup
  /** Shown as a small tag. High alpine is the reference combo. */
  featured?: boolean
  summary: string
  why: string
  /** Extra sentence when the second AMS is in the load. */
  whyExtended: string
  core: ComboRole[]
  extra: ComboRole[]
}

export const BAMBU_FILAMENTS: BambuFilament[] = [
  { id: 'ivory-white', name: 'Ivory White', line: 'PLA Matte', hex: '#FFFFFF' },
  { id: 'bone-white', name: 'Bone White', line: 'PLA Matte', hex: '#CBC6B8' },
  { id: 'desert-tan', name: 'Desert Tan', line: 'PLA Matte', hex: '#E8DBB7' },
  { id: 'latte-brown', name: 'Latte Brown', line: 'PLA Matte', hex: '#D3B7A7' },
  { id: 'caramel', name: 'Caramel', line: 'PLA Matte', hex: '#AE835B' },
  { id: 'terracotta', name: 'Terracotta', line: 'PLA Matte', hex: '#B15533' },
  { id: 'dark-brown', name: 'Dark Brown', line: 'PLA Matte', hex: '#7D6556' },
  { id: 'dark-chocolate', name: 'Dark Chocolate', line: 'PLA Matte', hex: '#4D3324' },
  { id: 'mandarin-orange', name: 'Mandarin Orange', line: 'PLA Matte', hex: '#F99963' },
  { id: 'lemon-yellow', name: 'Lemon Yellow', line: 'PLA Matte', hex: '#F7D959' },
  { id: 'scarlet-red', name: 'Scarlet Red', line: 'PLA Matte', hex: '#DE4343' },
  { id: 'dark-red', name: 'Dark Red', line: 'PLA Matte', hex: '#BB3D43' },
  { id: 'dark-green', name: 'Dark Green', line: 'PLA Matte', hex: '#68724D' },
  { id: 'grass-green', name: 'Grass Green', line: 'PLA Matte', hex: '#61C680' },
  { id: 'apple-green', name: 'Apple Green', line: 'PLA Matte', hex: '#C2E189' },
  { id: 'ice-blue', name: 'Ice Blue', line: 'PLA Matte', hex: '#A3D8E1' },
  { id: 'marine-blue', name: 'Marine Blue', line: 'PLA Matte', hex: '#0078BF' },
  { id: 'dark-blue', name: 'Dark Blue', line: 'PLA Matte', hex: '#042F56' },
  { id: 'ash-gray', name: 'Ash Gray', line: 'PLA Matte', hex: '#9B9EA0' },
  { id: 'nardo-gray', name: 'Nardo Gray', line: 'PLA Matte', hex: '#757575' },
  { id: 'charcoal', name: 'Charcoal', line: 'PLA Matte', hex: '#000000' },
  { id: 'bambu-green', name: 'Bambu Green', line: 'PLA Basic', hex: '#00AE42', code: '10501' },
  { id: 'mistletoe-green', name: 'Mistletoe Green', line: 'PLA Basic', hex: '#3F8E43', code: '10502' },
  { id: 'turquoise', name: 'Turquoise', line: 'PLA Basic', hex: '#00B1B7', code: '10605' },
  { id: 'cobalt-blue', name: 'Cobalt Blue', line: 'PLA Basic', hex: '#0056B8', code: '10604' },
  { id: 'yellow', name: 'Yellow', line: 'PLA Basic', hex: '#F4EE2A', code: '10400' },
  { id: 'gold', name: 'Gold', line: 'PLA Basic', hex: '#E4BD68', code: '10401' },
  { id: 'magenta', name: 'Magenta', line: 'PLA Basic', hex: '#EC008C', code: '10202' },
  { id: 'cocoa-brown', name: 'Cocoa Brown', line: 'PLA Basic', hex: '#6F5034', code: '10802' },
]

const byId = new Map(BAMBU_FILAMENTS.map((f) => [f.id, f]))

export function filamentById(id: string): BambuFilament {
  const filament = byId.get(id)
  if (!filament) throw new Error(`Unknown Bambu filament: ${id}`)
  return filament
}

const terrain = (filamentId: string, role: string): ComboRole => ({
  filamentId,
  role,
  terrain: true,
})

const route = (filamentId: string, role = 'Route line'): ComboRole => ({
  filamentId,
  role,
  terrain: false,
  route: true,
})

export const ENVIRONMENT_COMBOS: EnvironmentCombo[] = [
  {
    id: 'high-alpine',
    name: 'High alpine',
    group: 'High country',
    featured: true,
    summary: 'Snow, glacier ice, and granite above the trees.',
    why: 'Above treeline the imagery splits into sunlit snow, blue glacier ice, and granite. Ivory White, Ice Blue, and Ash Gray are the matte spools on those three. Scarlet Red stays out of terrain matching, so the raised route stays red on snow and on stone.',
    whyExtended:
      'The second AMS adds Charcoal for cliff shadow, Nardo Gray for mid-tone rock, Dark Blue for tarns, and Dark Green for krummholz. All eight spools are PLA Matte.',
    core: [
      terrain('ivory-white', 'Sunlit snow'),
      terrain('ice-blue', 'Glaciers and tarns'),
      terrain('ash-gray', 'Granite and scree'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('charcoal', 'Cliff shadow'),
      terrain('nardo-gray', 'Mid-tone rock'),
      terrain('dark-blue', 'Deep lakes'),
      terrain('dark-green', 'Krummholz'),
    ],
  },
  {
    id: 'tundra',
    name: 'Tundra',
    group: 'High country',
    summary: 'Lichen, moss, and melt ponds on open ground.',
    why: 'Tundra imagery is pale crust, low moss, and standing water. Desert Tan, Dark Green, and Ice Blue hold those three apart. Scarlet Red is the route.',
    whyExtended:
      'A second AMS adds Ash Gray for gravel, Grass Green for wet sedge, Latte Brown for dry peat, and Charcoal for rock. The whole load is PLA Matte.',
    core: [
      terrain('desert-tan', 'Lichen ground'),
      terrain('dark-green', 'Moss'),
      terrain('ice-blue', 'Melt ponds'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('ash-gray', 'Gravel bars'),
      terrain('grass-green', 'Wet sedge'),
      terrain('latte-brown', 'Dry peat'),
      terrain('charcoal', 'Rock and shadow'),
    ],
  },
  {
    id: 'winter-forest',
    name: 'Winter forest',
    group: 'High country',
    summary: 'Snowpack with conifers still in the frame.',
    why: 'A snowed-in valley reads as white, blue shade, and dark spruce. Ivory White, Ice Blue, and Dark Green carry that. Scarlet Red marks the route across the snow.',
    whyExtended:
      'The second AMS adds Charcoal for trunks, Ash Gray for frozen rock, Marine Blue for open water, and Dark Chocolate where the forest floor shows through. All eight are PLA Matte.',
    core: [
      terrain('ivory-white', 'Snow cover'),
      terrain('ice-blue', 'Shaded snow'),
      terrain('dark-green', 'Conifers'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('charcoal', 'Trunks and shade'),
      terrain('ash-gray', 'Frozen rock'),
      terrain('marine-blue', 'Open water'),
      terrain('dark-chocolate', 'Forest floor'),
    ],
  },
  {
    id: 'montane-forest',
    name: 'Montane forest',
    group: 'Woods',
    summary: 'Closed canopy, meadows, and brown duff.',
    why: 'Forest tiles cluster into dark canopy, bright clearings, and soil. Dark Green, Grass Green, and Dark Chocolate separate those. Scarlet Red is reserved for the raised line.',
    whyExtended:
      'Two AMS units add Apple Green for sunlit leaves, Caramel for dry grass, Bone White for rock, and Charcoal for deep shade. Every spool is PLA Matte.',
    core: [
      terrain('dark-green', 'Closed canopy'),
      terrain('grass-green', 'Meadows'),
      terrain('dark-chocolate', 'Duff and soil'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('apple-green', 'Sunlit leaves'),
      terrain('caramel', 'Dry grass'),
      terrain('bone-white', 'Rock outcrops'),
      terrain('charcoal', 'Deep shade'),
    ],
  },
  {
    id: 'autumn-woodland',
    name: 'Autumn woodland',
    group: 'Woods',
    summary: 'Aspen yellow, maple rust, and dark trunks.',
    why: 'Fall canopy is warm, so the route wants a cool spool. Lemon Yellow and Terracotta split the foliage, Dark Chocolate takes trunks and soil, and Cobalt Blue (PLA Basic) prints only the route.',
    whyExtended:
      'The second AMS adds Mandarin Orange, Dark Red, Dark Green for conifers that stay green, and Bone White for birch bark.',
    core: [
      terrain('lemon-yellow', 'Aspen and birch'),
      terrain('terracotta', 'Oak and maple'),
      terrain('dark-chocolate', 'Trunks and soil'),
      route('cobalt-blue'),
    ],
    extra: [
      terrain('mandarin-orange', 'Mid-fall canopy'),
      terrain('dark-red', 'Late maple'),
      terrain('dark-green', 'Conifers'),
      terrain('bone-white', 'Birch bark'),
    ],
  },
  {
    id: 'desert-canyon',
    name: 'Desert canyon',
    group: 'Dry ground',
    summary: 'Sand, red rock, and shadowed walls.',
    why: 'Canyon imagery steps from pale slickrock to red walls to brown shade. Desert Tan, Terracotta, and Dark Brown follow that ramp. Cobalt Blue is the route, a cool line against the warm stone.',
    whyExtended:
      'A second AMS adds Latte Brown, Caramel, Dark Chocolate for slot canyons, and Turquoise (PLA Basic) for the river.',
    core: [
      terrain('desert-tan', 'Sand and slickrock'),
      terrain('terracotta', 'Red rock'),
      terrain('dark-brown', 'Canyon shade'),
      route('cobalt-blue'),
    ],
    extra: [
      terrain('latte-brown', 'Pale sandstone'),
      terrain('caramel', 'Bench slopes'),
      terrain('dark-chocolate', 'Slot shadow'),
      terrain('turquoise', 'River'),
    ],
  },
  {
    id: 'badlands',
    name: 'Badlands',
    group: 'Dry ground',
    summary: 'Pale strata, gold clay, and iron bands.',
    why: 'Badland bands are lighter and more yellow than a red-rock canyon. Desert Tan and Gold take the sunlit strata, Terracotta takes the iron, and Cobalt Blue is the route.',
    whyExtended:
      'The second AMS fills in Caramel, Dark Brown, Dark Chocolate, and Charcoal so the gulches have a dark end to the ramp.',
    core: [
      terrain('desert-tan', 'Pale strata'),
      terrain('gold', 'Sunlit clay'),
      terrain('terracotta', 'Iron bands'),
      route('cobalt-blue'),
    ],
    extra: [
      terrain('caramel', 'Mid slopes'),
      terrain('dark-brown', 'Mudstone'),
      terrain('dark-chocolate', 'Gulches'),
      terrain('charcoal', 'Deep shade'),
    ],
  },
  {
    id: 'volcanic',
    name: 'Volcanic',
    group: 'Dry ground',
    summary: 'Basalt, ash, and cinder.',
    why: 'Volcanic ground is dark gray with rust-colored cinder. Charcoal, Nardo Gray, and Terracotta cover that, all matte. Magenta (PLA Basic) is the route, bright against basalt.',
    whyExtended:
      'Two AMS units add Dark Chocolate, Mandarin Orange for young flows, Ash Gray for pumice, and Dark Brown for weathered rock.',
    core: [
      terrain('charcoal', 'Basalt'),
      terrain('nardo-gray', 'Ash fields'),
      terrain('terracotta', 'Cinder'),
      route('magenta'),
    ],
    extra: [
      terrain('dark-chocolate', 'Old flows'),
      terrain('mandarin-orange', 'Young lava'),
      terrain('ash-gray', 'Pumice'),
      terrain('dark-brown', 'Weathered rock'),
    ],
  },
  {
    id: 'coast',
    name: 'Coast',
    group: 'Water',
    summary: 'Sand, shallows, and deep water.',
    why: 'Shore tiles want a light sand and two distinct blues. Bone White, Ice Blue, and Marine Blue are that ladder, all PLA Matte. Scarlet Red is the route along the beach and the headlands.',
    whyExtended:
      'The second AMS adds Dark Blue offshore, Ash Gray for rock, Grass Green for dune grass, and Charcoal for wet stone.',
    core: [
      terrain('bone-white', 'Sand'),
      terrain('ice-blue', 'Shallows'),
      terrain('marine-blue', 'Deep water'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('dark-blue', 'Offshore'),
      terrain('ash-gray', 'Headland rock'),
      terrain('grass-green', 'Dune grass'),
      terrain('charcoal', 'Wet rock'),
    ],
  },
  {
    id: 'tropical',
    name: 'Tropical',
    group: 'Water',
    summary: 'Saturated canopy, turquoise water, and soil.',
    why: 'Tropical imagery is more saturated than a temperate forest. Bambu Green and Turquoise (both PLA Basic) hold canopy and reef water, Cocoa Brown takes soil, and Yellow prints the route.',
    whyExtended:
      'A second AMS adds Mistletoe Green for shaded canopy, Grass Green for clearings, Desert Tan for beach, and Marine Blue for deep water.',
    core: [
      terrain('bambu-green', 'Canopy'),
      terrain('turquoise', 'Rivers and reef'),
      terrain('cocoa-brown', 'Soil'),
      route('yellow'),
    ],
    extra: [
      terrain('mistletoe-green', 'Shaded canopy'),
      terrain('grass-green', 'Clearings'),
      terrain('desert-tan', 'Beach'),
      terrain('marine-blue', 'Deep water'),
    ],
  },
]

export function slotsFor(combo: EnvironmentCombo, units: AmsUnits): ComboRole[] {
  return units === 1 ? combo.core : [...combo.core, ...combo.extra]
}

export function comboById(id: string): EnvironmentCombo {
  const combo = ENVIRONMENT_COMBOS.find((c) => c.id === id)
  if (!combo) throw new Error(`Unknown environment combo: ${id}`)
  return combo
}

export function comboToPalette(combo: EnvironmentCombo, units: AmsUnits): Palette {
  const slots = slotsFor(combo, units)
  return {
    name: `${combo.name} · Bambu`,
    colors: slots.map((slot) => {
      const filament = filamentById(slot.filamentId)
      return {
        name: filament.name,
        hex: filament.hex,
        enabled: slot.terrain,
      }
    }),
  }
}

export function routeIndexFor(combo: EnvironmentCombo, units: AmsUnits): number {
  const index = slotsFor(combo, units).findIndex((slot) => slot.route)
  if (index < 0) throw new Error(`${combo.name} has no route spool`)
  return index
}
