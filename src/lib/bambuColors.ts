import type { Land, Palette } from './palette'

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
  /** Terrain class. Route slots leave this unset. */
  land?: Land
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

const terrain = (filamentId: string, role: string, land: Land): ComboRole => ({
  filamentId,
  role,
  terrain: true,
  land,
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
      'The second AMS adds Charcoal for cliff shadow, Dark Chocolate for talus, Marine Blue for tarns, and Dark Green for krummholz. All eight spools are PLA Matte.',
    core: [
      terrain('ivory-white', 'Sunlit snow', 'snow'),
      terrain('ice-blue', 'Glacier ice', 'ice'),
      terrain('ash-gray', 'Granite and scree', 'rock'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('charcoal', 'Cliff shadow', 'shadow'),
      terrain('dark-chocolate', 'Talus', 'soil'),
      terrain('marine-blue', 'Tarns', 'water'),
      terrain('dark-green', 'Krummholz', 'veg'),
    ],
  },
  {
    id: 'tundra',
    name: 'Tundra',
    group: 'High country',
    summary: 'Lichen, moss, and melt ponds on open ground.',
    why: 'Tundra imagery is pale crust, low moss, and standing water. Desert Tan, Dark Green, and Marine Blue hold those three apart. Scarlet Red is the route.',
    whyExtended:
      'A second AMS adds Ash Gray for gravel, Grass Green for wet sedge, Dark Chocolate for dry peat, and Charcoal for rock. The whole load is PLA Matte.',
    core: [
      terrain('desert-tan', 'Lichen ground', 'sand'),
      terrain('dark-green', 'Moss', 'veg'),
      terrain('marine-blue', 'Melt ponds', 'water'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('ash-gray', 'Gravel bars', 'rock'),
      terrain('grass-green', 'Wet sedge', 'veg'),
      terrain('dark-chocolate', 'Dry peat', 'soil'),
      terrain('charcoal', 'Rock and shadow', 'shadow'),
    ],
  },
  {
    id: 'winter-forest',
    name: 'Winter forest',
    group: 'High country',
    summary: 'Snowpack with conifers still in the frame.',
    why: 'A snowed-in valley reads as white, blue shade, and dark spruce. Ivory White, Ice Blue, and Dark Green carry that. Scarlet Red marks the route across the snow.',
    whyExtended:
      'The second AMS adds Charcoal for trunks, Ash Gray for frozen rock, Marine Blue for open water, and Dark Chocolate where the forest floor shows through. All eight spools are PLA Matte.',
    core: [
      terrain('ivory-white', 'Snow cover', 'snow'),
      terrain('ice-blue', 'Shaded snow', 'ice'),
      terrain('dark-green', 'Conifers', 'veg'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('charcoal', 'Trunks and shade', 'shadow'),
      terrain('ash-gray', 'Frozen rock', 'rock'),
      terrain('marine-blue', 'Open water', 'water'),
      terrain('dark-chocolate', 'Forest floor', 'soil'),
    ],
  },
  {
    id: 'montane-forest',
    name: 'Montane forest',
    group: 'Woods',
    summary: 'Closed canopy, meadows, and brown duff.',
    why: 'Forest tiles cluster into dark canopy, bright clearings, and soil. Dark Green, Grass Green, and Dark Chocolate separate those. Scarlet Red is reserved for the raised line.',
    whyExtended:
      'Two AMS units add Lemon Yellow for sunlit leaves, Terracotta for dry grass, Bone White for rock, and Charcoal for deep shade. Every spool is PLA Matte.',
    core: [
      terrain('dark-green', 'Closed canopy', 'veg'),
      terrain('grass-green', 'Meadows', 'veg'),
      terrain('dark-chocolate', 'Duff and soil', 'soil'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('lemon-yellow', 'Sunlit leaves', 'sand'),
      terrain('terracotta', 'Dry grass', 'soil'),
      terrain('bone-white', 'Rock outcrops', 'rock'),
      terrain('charcoal', 'Deep shade', 'shadow'),
    ],
  },
  {
    id: 'autumn-woodland',
    name: 'Autumn woodland',
    group: 'Woods',
    summary: 'Aspen yellow, maple rust, and dark trunks.',
    why: 'Fall canopy is warm, so the route wants a cool spool. Lemon Yellow and Mandarin Orange split the foliage, Dark Chocolate takes trunks and soil, and Cobalt Blue (PLA Basic) prints only the route.',
    whyExtended:
      'The second AMS adds Apple Green for leaves that stay green, Charcoal for deep shade, Dark Green for conifers, and Bone White for birch bark.',
    core: [
      terrain('lemon-yellow', 'Aspen and birch', 'sand'),
      terrain('mandarin-orange', 'Maple and oak', 'soil'),
      terrain('dark-chocolate', 'Trunks and soil', 'soil'),
      route('cobalt-blue'),
    ],
    extra: [
      terrain('apple-green', 'Lingering green', 'veg'),
      terrain('charcoal', 'Deep shade', 'shadow'),
      terrain('dark-green', 'Conifers', 'veg'),
      terrain('bone-white', 'Birch bark', 'rock'),
    ],
  },
  {
    id: 'desert-canyon',
    name: 'Desert canyon',
    group: 'Dry ground',
    summary: 'Sand, red rock, and shadowed walls.',
    why: 'Canyon imagery steps from pale slickrock to red walls to black shade. Desert Tan, Terracotta, and Charcoal follow that ramp. Cobalt Blue is the route, a cool line against the warm stone.',
    whyExtended:
      'A second AMS adds Ash Gray for pale rock, Gold for bench slopes, Dark Chocolate for slot canyons, and Turquoise (PLA Basic) for the river. Gold is PLA Basic as well.',
    core: [
      terrain('desert-tan', 'Sand and slickrock', 'sand'),
      terrain('terracotta', 'Red rock', 'rock'),
      terrain('charcoal', 'Canyon shade', 'shadow'),
      route('cobalt-blue'),
    ],
    extra: [
      terrain('ash-gray', 'Slickrock gray', 'rock'),
      terrain('gold', 'Bench slopes', 'soil'),
      terrain('dark-chocolate', 'Slot shadow', 'shadow'),
      terrain('turquoise', 'River', 'water'),
    ],
  },
  {
    id: 'badlands',
    name: 'Badlands',
    group: 'Dry ground',
    summary: 'Pale strata, gold clay, and iron bands.',
    why: 'Badland bands are lighter and more yellow than a red-rock canyon. Desert Tan and Gold take the sunlit strata, Dark Red takes the iron, and Cobalt Blue is the route.',
    whyExtended:
      'The second AMS fills in Caramel, Ash Gray, Dark Chocolate, and Charcoal so the gulches have a dark end to the ramp.',
    core: [
      terrain('desert-tan', 'Pale strata', 'sand'),
      terrain('gold', 'Sunlit clay', 'soil'),
      terrain('dark-red', 'Iron bands', 'rock'),
      route('cobalt-blue'),
    ],
    extra: [
      terrain('caramel', 'Mid slopes', 'soil'),
      terrain('ash-gray', 'Pale rock', 'rock'),
      terrain('dark-chocolate', 'Gulches', 'shadow'),
      terrain('charcoal', 'Deep shade', 'shadow'),
    ],
  },
  {
    id: 'volcanic',
    name: 'Volcanic',
    group: 'Dry ground',
    summary: 'Basalt, ash, and cinder.',
    why: 'Volcanic ground is dark gray with rust-colored cinder. Charcoal, Nardo Gray, and Terracotta cover that, all matte. Magenta (PLA Basic) is the route, bright against basalt.',
    whyExtended:
      'Two AMS units add Dark Chocolate for old flows, Gold for young lava, Marine Blue for crater lakes, and Caramel for warm clay.',
    core: [
      terrain('charcoal', 'Basalt', 'shadow'),
      terrain('nardo-gray', 'Ash fields', 'rock'),
      terrain('terracotta', 'Cinder', 'soil'),
      route('magenta'),
    ],
    extra: [
      terrain('dark-chocolate', 'Old flows', 'rock'),
      terrain('gold', 'Young lava', 'soil'),
      terrain('marine-blue', 'Crater lakes', 'water'),
      terrain('caramel', 'Warm clay', 'soil'),
    ],
  },
  {
    id: 'coast',
    name: 'Coast',
    group: 'Water',
    summary: 'Sand, shallows, and deep water.',
    why: 'Shore tiles want a light sand and two distinct blues. Desert Tan, Ice Blue, and Marine Blue are that ladder, all PLA Matte. Scarlet Red is the route along the beach and the headlands.',
    whyExtended:
      'The second AMS adds Dark Blue offshore, Dark Chocolate for headland rock, Grass Green for dune grass, and Charcoal for wet stone.',
    core: [
      terrain('desert-tan', 'Sand', 'sand'),
      terrain('ice-blue', 'Shallows', 'water'),
      terrain('marine-blue', 'Deep water', 'water'),
      route('scarlet-red'),
    ],
    extra: [
      terrain('dark-blue', 'Offshore', 'water'),
      terrain('dark-chocolate', 'Headland rock', 'rock'),
      terrain('grass-green', 'Dune grass', 'veg'),
      terrain('charcoal', 'Wet rock', 'shadow'),
    ],
  },
  {
    id: 'tropical',
    name: 'Tropical',
    group: 'Water',
    summary: 'Saturated canopy, turquoise water, and soil.',
    why: 'Tropical imagery is more saturated than a temperate forest. Bambu Green and Turquoise (both PLA Basic) hold canopy and reef water, Dark Chocolate takes soil, and Yellow prints the route.',
    whyExtended:
      'A second AMS adds Dark Green for shaded canopy, Desert Tan for beach, Ash Gray for headland rock, and Charcoal for jungle shade.',
    core: [
      terrain('bambu-green', 'Canopy', 'veg'),
      terrain('turquoise', 'Rivers and reef', 'water'),
      terrain('dark-chocolate', 'Soil', 'soil'),
      route('yellow'),
    ],
    extra: [
      terrain('dark-green', 'Shade canopy', 'veg'),
      terrain('desert-tan', 'Beach', 'sand'),
      terrain('ash-gray', 'Headland rock', 'rock'),
      terrain('charcoal', 'Jungle shade', 'shadow'),
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
      const color: Palette['colors'][number] = {
        name: filament.name,
        hex: filament.hex,
        enabled: slot.terrain,
        note: slot.role,
      }
      if (slot.land) color.land = slot.land
      return color
    }),
  }
}

export function routeIndexFor(combo: EnvironmentCombo, units: AmsUnits): number {
  const index = slotsFor(combo, units).findIndex((slot) => slot.route)
  if (index < 0) throw new Error(`${combo.name} has no route spool`)
  return index
}
