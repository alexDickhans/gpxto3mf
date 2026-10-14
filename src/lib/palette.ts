export type Land =
  | 'snow'
  | 'ice'
  | 'rock'
  | 'shadow'
  | 'veg'
  | 'soil'
  | 'water'
  | 'sand'

export type PaletteColor = {
  name: string
  hex: string
  /** When false, skipped for terrain matching (still selectable as route). Default true. */
  enabled?: boolean
  /** Short job for this spool, such as "Sunlit snow". */
  note?: string
  /** Terrain class this spool is meant to win. Absent on route slots and custom palettes. */
  land?: Land
}
export type Palette = { name: string; colors: PaletteColor[] }

export function isColorEnabled(c: PaletteColor): boolean {
  return c.enabled !== false
}

/** Indices into palette.colors that participate in terrain matching */
export function enabledColorIndices(palette: Palette): number[] {
  const idxs = palette.colors
    .map((c, i) => (isColorEnabled(c) ? i : -1))
    .filter((i) => i >= 0)
  if (idxs.length === 0) {
    throw new Error('Enable at least one palette color for terrain matching')
  }
  return idxs
}

function normalizeHex(hex: string): string {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(`Invalid hex color: ${hex}`)
  }
  return `#${h.toUpperCase()}`
}

function parseColorEntry(
  c: string | PaletteColor,
  i: number,
): PaletteColor {
  if (typeof c === 'string') {
    return { name: `Color ${i + 1}`, hex: normalizeHex(c), enabled: true }
  }
  return {
    name: c.name || `Color ${i + 1}`,
    hex: normalizeHex(c.hex),
    enabled: c.enabled !== false,
  }
}

export function parsePaletteText(text: string, filename = 'palette'): Palette {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed) as
      | { name?: string; colors?: Array<string | PaletteColor> }
      | string[]
      | PaletteColor[]

    if (Array.isArray(data)) {
      const colors = data.map((c, i) => parseColorEntry(c, i))
      return { name: filename.replace(/\.[^.]+$/, ''), colors }
    }

    const colors = (data.colors ?? []).map((c, i) => parseColorEntry(c, i))
    if (colors.length === 0) throw new Error('Palette has no colors')
    return { name: data.name || filename.replace(/\.[^.]+$/, ''), colors }
  }

  // CSV / TXT: hex codes, optionally name,hex
  const lines = trimmed.split(/\r?\n|,/).map((l) => l.trim()).filter(Boolean)
  const colors: PaletteColor[] = []
  for (const line of lines) {
    const parts = line.split(/[\s;|]+/).filter(Boolean)
    if (parts.length >= 2 && parts[1].includes('#')) {
      colors.push({ name: parts[0], hex: normalizeHex(parts[1]) })
    } else if (parts[0].startsWith('#') || /^[0-9a-fA-F]{6}$/.test(parts[0])) {
      colors.push({
        name: `Color ${colors.length + 1}`,
        hex: normalizeHex(parts[0]),
      })
    } else if (parts.length >= 2) {
      colors.push({ name: parts[0], hex: normalizeHex(parts[1]) })
    }
  }
  if (colors.length === 0) throw new Error('No hex colors found in palette')
  return { name: filename.replace(/\.[^.]+$/, ''), colors }
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

function srgbToLinear(c: number) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function rgbToXyz(r: number, g: number, b: number) {
  const R = srgbToLinear(r)
  const G = srgbToLinear(g)
  const B = srgbToLinear(b)
  return {
    x: R * 0.4124564 + G * 0.3575761 + B * 0.1804375,
    y: R * 0.2126729 + G * 0.7151522 + B * 0.072175,
    z: R * 0.0193339 + G * 0.119192 + B * 0.9503041,
  }
}

function xyzToLab(x: number, y: number, z: number): [number, number, number] {
  // D65 white
  const Xn = 0.95047
  const Yn = 1.0
  const Zn = 1.08883
  const f = (t: number) =>
    t > 216 / 24389 ? Math.cbrt(t) : ((841 / 108) * t + 4 / 29)
  const fx = f(x / Xn)
  const fy = f(y / Yn)
  const fz = f(z / Zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const { x, y, z } = rgbToXyz(r, g, b)
  return xyzToLab(x, y, z)
}

export function hexToLab(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex)
  return rgbToLab(r, g, b)
}

export function deltaE76(a: [number, number, number], b: [number, number, number]) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

export function nearestPaletteIndex(
  rgb: [number, number, number],
  paletteLabs: [number, number, number][],
): number {
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2])
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < paletteLabs.length; i++) {
    const d = deltaE76(lab, paletteLabs[i])
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * Ice before water before snow. Bright yellows are sand before vegetation
 * so aspen and sulfur are not eaten by a green spool.
 */
function classifyLand(lab: [number, number, number], elev01: number): Land {
  const L = lab[0]
  const a = lab[1]
  const b = lab[2]
  const chroma = Math.hypot(a, b)
  if (elev01 > 0.55 && b < -4 && a < 6 && L > 40 && L < 96) return 'ice'
  if (b < -8 && a < 2 && L < 90 && elev01 < 0.75) return 'water'
  if (elev01 > 0.72 && L > 62 && chroma < 18 && b > -8) return 'snow'
  if (b > 55 && L > 68) return 'sand'
  if (a > 18 && b > 20 && L < 88) return 'soil'
  if (a < -6 && b > -8 && chroma > 8) return 'veg'
  if (L < 20 && chroma < 14) return 'shadow'
  if (b > 18 && L > 70 && a > -10) return 'sand'
  if (a >= 8 && b > 12 && L < 78) return 'soil'
  return 'rock'
}

/**
 * Land-aware terrain match. Spools with no land (custom palettes, DEFAULT_PALETTE)
 * fall back to nearest Lab. When the pixel's class has a spool, only those
 * spools compete, so a closer wrong land cannot steal the pixel.
 */
export function matchTerrainCell(
  rgb: [number, number, number],
  elev01: number,
  paletteLabs: [number, number, number][],
  lands: (Land | undefined)[],
): number {
  let anyLand = false
  for (let i = 0; i < lands.length; i++) {
    if (lands[i] !== undefined) {
      anyLand = true
      break
    }
  }
  if (!anyLand) return nearestPaletteIndex(rgb, paletteLabs)

  const lab = rgbToLab(rgb[0], rgb[1], rgb[2])
  const want = classifyLand(lab, elev01)
  return closestLandScore(lab, paletteLabs, lands, want)
}

function closestLandScore(
  lab: [number, number, number],
  paletteLabs: [number, number, number][],
  lands: (Land | undefined)[],
  want: Land,
): number {
  const Lp = lab[0]
  const ap = lab[1]
  const bp = lab[2]
  let restricted = false
  for (let i = 0; i < lands.length; i++) {
    if (lands[i] === want) {
      restricted = true
      break
    }
  }
  let best = 0
  let bestScore = Infinity
  for (let i = 0; i < paletteLabs.length; i++) {
    if (restricted && lands[i] !== want) continue
    const filament = paletteLabs[i]
    const score =
      Math.abs(Lp - filament[0]) * 1.35 +
      Math.hypot(ap - filament[1], bp - filament[2]) * 0.45
    if (score < bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/** Pick palette color with highest contrast vs average terrain Lab */
export function pickRouteColorIndex(
  palette: Palette,
  terrainAvgRgb: [number, number, number],
): number {
  const terrainLab = rgbToLab(...terrainAvgRgb)
  let best = 0
  let bestD = -1
  palette.colors.forEach((c, i) => {
    const d = deltaE76(hexToLab(c.hex), terrainLab)
    // Prefer names containing "route" if present; prefer enabled slots
    const boost =
      (/route/i.test(c.name) ? 40 : 0) + (isColorEnabled(c) ? 5 : 0)
    if (d + boost > bestD) {
      bestD = d + boost
      best = i
    }
  })
  return best
}

export function setColorEnabled(
  palette: Palette,
  index: number,
  enabled: boolean,
): Palette {
  return {
    ...palette,
    colors: palette.colors.map((c, i) =>
      i === index ? { ...c, enabled } : c,
    ),
  }
}
