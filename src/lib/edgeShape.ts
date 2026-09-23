/** Silhouette of the printable topo slab */
export type EdgeShape =
  | 'rect'
  | 'rounded'
  | 'circle'
  | 'hexagon'
  | 'octagon'
  | 'track'

export const EDGE_SHAPE_OPTIONS: {
  id: EdgeShape
  label: string
  hint: string
}[] = [
  { id: 'rect', label: 'Rectangle', hint: 'Full padded bounding box' },
  { id: 'rounded', label: 'Rounded rect', hint: 'Soft corners, same footprint' },
  { id: 'circle', label: 'Circle', hint: 'Inscribed circular coaster' },
  { id: 'hexagon', label: 'Hexagon', hint: 'Flat-top hex tile' },
  { id: 'octagon', label: 'Octagon', hint: 'Clipped square' },
  { id: 'track', label: 'Route buffer', hint: 'Follows the GPX corridor' },
]

export type EdgeShapeContext = {
  /** Half-width of terrain extent in mm (centered) */
  halfW: number
  /** Half-height of terrain extent in mm (centered) */
  halfH: number
  /** Optional route polyline in mm (centered), for track shape */
  routeMm?: { x: number; y: number }[]
  /** Inset from the outer silhouette (mm) */
  insetMm: number
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v))
}

/** Smooth 0→1 hermite */
export function smoothstep(edge0: number, edge1: number, x: number) {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Signed distance: positive inside, negative outside */
function sdBox(x: number, y: number, hx: number, hy: number) {
  const dx = Math.abs(x) - hx
  const dy = Math.abs(y) - hy
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  const inside = Math.min(Math.max(dx, dy), 0)
  return -(outside + inside)
}

function sdRoundedBox(
  x: number,
  y: number,
  hx: number,
  hy: number,
  r: number,
) {
  const rr = Math.min(r, hx, hy)
  return sdBox(x, y, hx - rr, hy - rr) + rr
}

function sdCircle(x: number, y: number, r: number) {
  return r - Math.hypot(x, y)
}

/** Regular n-gon, flat-top for even n when angle0 = 0 for hex with flat top */
function sdNgon(
  x: number,
  y: number,
  radius: number,
  sides: number,
  angle0 = 0,
) {
  // Convert to polar; distance to edge of regular polygon
  const ang = Math.atan2(y, x) - angle0
  const a = (Math.PI * 2) / sides
  // Snap to nearest sector
  const sector = Math.floor((ang + Math.PI) / a)
  const local = ang - sector * a - a / 2 + Math.PI
  // Inradius / circumradius relationship
  const r = radius * Math.cos(Math.PI / sides)
  const d = Math.hypot(x, y) * Math.cos(local - Math.PI)
  return r - d
}

function distToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  const abx = bx - ax
  const aby = by - ay
  const len2 = abx * abx + aby * aby || 1e-12
  const t = clamp(((px - ax) * abx + (py - ay) * aby) / len2, 0, 1)
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t))
}

function sdTrackBuffer(
  x: number,
  y: number,
  route: { x: number; y: number }[],
  radius: number,
) {
  if (route.length < 2) return sdCircle(x, y, radius)
  let minD = Infinity
  for (let i = 0; i < route.length - 1; i++) {
    const d = distToSegment(
      x,
      y,
      route[i].x,
      route[i].y,
      route[i + 1].x,
      route[i + 1].y,
    )
    if (d < minD) minD = d
  }
  return radius - minD
}

function trackRadius(ctx: EdgeShapeContext): number {
  const route = ctx.routeMm
  if (!route || route.length < 2) {
    return Math.min(ctx.halfW, ctx.halfH) * 0.45
  }
  // Radius from densest corridor: cover ~35% of shorter axis, at least max
  // distance of points from a thin buffer so the whole route is enclosed.
  let maxDistFromLine = 0
  // Use length-weighted sample: distance of each point to itself is 0;
  // instead take a fraction of half-extent so the buffer is generous.
  const base = Math.min(ctx.halfW, ctx.halfH) * 0.28
  for (const p of route) {
    maxDistFromLine = Math.max(maxDistFromLine, Math.hypot(p.x, p.y) * 0.02)
  }
  return Math.max(base, 8) + maxDistFromLine
}

/** Signed distance to the chosen silhouette (positive = inside), after inset */
export function edgeSignedDistance(
  x: number,
  y: number,
  shape: EdgeShape,
  ctx: EdgeShapeContext,
): number {
  const hx = Math.max(0.5, ctx.halfW - ctx.insetMm)
  const hy = Math.max(0.5, ctx.halfH - ctx.insetMm)
  const r = Math.min(hx, hy)

  let sd: number
  switch (shape) {
    case 'circle':
      sd = sdCircle(x, y, r)
      break
    case 'hexagon':
      // Flat-top hex: rotate so flats are horizontal
      sd = sdNgon(x, y, r, 6, 0)
      break
    case 'octagon':
      sd = sdNgon(x, y, r, 8, Math.PI / 8)
      break
    case 'rounded': {
      const corner = Math.min(hx, hy) * 0.22
      sd = sdRoundedBox(x, y, hx, hy, corner)
      break
    }
    case 'track':
      sd = sdTrackBuffer(x, y, ctx.routeMm ?? [], trackRadius(ctx) - ctx.insetMm)
      break
    case 'rect':
    default:
      sd = sdBox(x, y, hx, hy)
      break
  }
  return sd
}

/**
 * Edge mask 0..1 for a vertex.
 * softMm: distance inside the silhouette over which height ramps (0 = hard cut).
 */
export function edgeMask(
  x: number,
  y: number,
  shape: EdgeShape,
  ctx: EdgeShapeContext,
  softMm: number,
): number {
  const sd = edgeSignedDistance(x, y, shape, ctx)
  if (softMm <= 0.05) return sd >= 0 ? 1 : 0
  return smoothstep(0, softMm, sd)
}
