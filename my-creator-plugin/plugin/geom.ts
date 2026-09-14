/**
 * Geometry helpers: matrices, bezier flattening, ring <-> PathData conversion,
 * simplification, and convex hulls.
 */

import type { Cubic } from './fit';
import type { MultiPoly, Pt, Ring } from './martinez';

/** Maximum deviation, in scene units, allowed when flattening a bezier to a polyline. */
export const FLATTEN_TOLERANCE = 0.05;
/** Coordinates are snapped to this grid before clipping, to tame degeneracies. */
const SNAP = 1e4;

export interface Mat {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Mat = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** Applies `m` first, then `n`. */
export function multiply(n: Mat, m: Mat): Mat {
  return {
    a: n.a * m.a + n.c * m.b,
    b: n.b * m.a + n.d * m.b,
    c: n.a * m.c + n.c * m.d,
    d: n.b * m.c + n.d * m.d,
    e: n.a * m.e + n.c * m.f + n.e,
    f: n.b * m.e + n.d * m.f + n.f,
  };
}

export function invert(m: Mat): Mat {
  const det = m.a * m.d - m.b * m.c;

  if (det === 0 || !isFinite(det)) return IDENTITY;

  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function apply(m: Mat, x: number, y: number): Pt {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

function snap(p: Pt): Pt {
  return [Math.round(p[0] * SNAP) / SNAP, Math.round(p[1] * SNAP) / SNAP];
}

/**
 * Appends a flattened cubic bezier (excluding `p0`) to `out`.
 *
 * The segment count comes from the standard bound on the distance between a
 * cubic and its control polygon, so straight segments cost a single line.
 */
function flattenCubic(out: Pt[], p0: Pt, c1: Pt, c2: Pt, p3: Pt, tolerance: number): void {
  const ax = p0[0] - 2 * c1[0] + c2[0];
  const ay = p0[1] - 2 * c1[1] + c2[1];
  const bx = c1[0] - 2 * c2[0] + p3[0];
  const by = c1[1] - 2 * c2[1] + p3[1];
  const m = Math.max(Math.sqrt(ax * ax + ay * ay), Math.sqrt(bx * bx + by * by));
  const n = Math.max(1, Math.min(160, Math.ceil(Math.sqrt((0.75 * m) / tolerance))));

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;

    out.push([
      w0 * p0[0] + w1 * c1[0] + w2 * c2[0] + w3 * p3[0],
      w0 * p0[1] + w1 * c1[1] + w2 * c2[1] + w3 * p3[1],
    ]);
  }
}

export interface PathPointLike {
  vertex: { x: number; y: number };
  inTan: { x: number; y: number };
  outTan: { x: number; y: number };
}

export interface PathDataLike {
  points: ReadonlyArray<PathPointLike>;
  closed: boolean;
}

/**
 * Flattens path data into a closed ring, transformed by `m`.
 *
 * Tangents are treated as offsets relative to their vertex (the Lottie
 * convention). Open paths are implicitly closed — boolean operations are only
 * meaningful on filled regions.
 */
export function pathDataToRing(pd: PathDataLike, m: Mat, tolerance = FLATTEN_TOLERANCE): Ring {
  const pts = pd.points;

  if (!pts || pts.length < 2) return [];

  const vertex = (i: number): Pt => apply(m, pts[i]!.vertex.x, pts[i]!.vertex.y);
  const outCtl = (i: number): Pt => apply(m, pts[i]!.vertex.x + pts[i]!.outTan.x, pts[i]!.vertex.y + pts[i]!.outTan.y);
  const inCtl = (i: number): Pt => apply(m, pts[i]!.vertex.x + pts[i]!.inTan.x, pts[i]!.vertex.y + pts[i]!.inTan.y);

  const ring: Pt[] = [vertex(0)];

  for (let i = 0; i < pts.length; i++) {
    const j = i + 1;

    if (j === pts.length) break;
    flattenCubic(ring, vertex(i), outCtl(i), inCtl(j), vertex(j), tolerance);
  }

  // Close the loop back to the first vertex.
  const last = pts.length - 1;

  flattenCubic(ring, vertex(last), outCtl(last), inCtl(0), vertex(0), tolerance);

  const snapped = ring.map(snap);
  const deduped: Pt[] = [];

  for (const p of snapped) {
    const prev = deduped[deduped.length - 1];

    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) deduped.push(p);
  }

  if (deduped.length < 3) return [];

  const first = deduped[0]!;
  const tail = deduped[deduped.length - 1]!;

  if (first[0] !== tail[0] || first[1] !== tail[1]) deduped.push([first[0], first[1]]);

  return deduped;
}

/** Twice the signed area of a closed ring. Positive means counter-clockwise. */
export function signedArea2(ring: Ring): number {
  let sum = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!;
    const b = ring[i + 1]!;

    sum += a[0] * b[1] - b[0] * a[1];
  }

  return sum;
}

/**
 * Forces exterior rings counter-clockwise and holes clockwise, so the non-zero
 * fill rule punches the holes out.
 */
export function orientPolygons(polys: MultiPoly): Ring[] {
  const rings: Ring[] = [];

  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const ring = poly[i]!;
      const wantCcw = i === 0;
      const isCcw = signedArea2(ring) > 0;

      rings.push(isCcw === wantCcw ? ring : ring.slice().reverse());
    }
  }

  return rings;
}

/** Ramer-Douglas-Peucker simplification, keeping the ring closed. */
export function simplifyRing(ring: Ring, epsilon: number): Ring {
  if (ring.length < 4) return ring;

  const open = ring.slice(0, ring.length - 1);
  const keep: boolean[] = new Array(open.length).fill(false);

  keep[0] = true;
  keep[open.length - 1] = true;

  const stack: Array<[number, number]> = [[0, open.length - 1]];

  while (stack.length > 0) {
    const [first, last] = stack.pop()!;

    if (last <= first + 1) continue;

    const a = open[first]!;
    const b = open[last]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.sqrt(dx * dx + dy * dy);
    let maxDist = -1;
    let index = first;

    for (let i = first + 1; i < last; i++) {
      const p = open[i]!;
      const dist =
        len === 0
          ? Math.hypot(p[0] - a[0], p[1] - a[1])
          : Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;

      if (dist > maxDist) {
        maxDist = dist;
        index = i;
      }
    }

    if (maxDist > epsilon) {
      keep[index] = true;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Ring = [];

  for (let i = 0; i < open.length; i++) if (keep[i]) out.push(open[i]!);
  if (out.length < 3) return ring;
  out.push([out[0]![0], out[0]![1]]);

  return out;
}

/** Converts a closed ring into path data with straight segments. */
export function ringToPathData(ring: Ring, m: Mat): { points: PathPointLike[]; closed: boolean } {
  const points: PathPointLike[] = [];
  // The closing point is implied by `closed: true`.
  const end = ring.length > 1 && ring[0]![0] === ring[ring.length - 1]![0] && ring[0]![1] === ring[ring.length - 1]![1]
    ? ring.length - 1
    : ring.length;

  for (let i = 0; i < end; i++) {
    const [x, y] = apply(m, ring[i]![0], ring[i]![1]);

    points.push({ vertex: { x, y }, inTan: { x: 0, y: 0 }, outTan: { x: 0, y: 0 } });
  }

  return { points, closed: true };
}

/**
 * Converts a closed chain of fitted cubics into path data, transformed by `m`.
 *
 * Each anchor takes its outgoing handle from its own curve and its incoming
 * handle from the previous one, so the chain stays continuous around the seam.
 */
export function cubicsToPathData(curves: Cubic[], m: Mat): { points: PathPointLike[]; closed: boolean } {
  const points: PathPointLike[] = [];

  for (let i = 0; i < curves.length; i++) {
    const curve = curves[i]!;
    const previous = curves[(i - 1 + curves.length) % curves.length]!;
    const vertex = apply(m, curve[0][0], curve[0][1]);
    const outCtl = apply(m, curve[1][0], curve[1][1]);
    const inCtl = apply(m, previous[2][0], previous[2][1]);

    points.push({
      vertex: { x: vertex[0], y: vertex[1] },
      inTan: { x: inCtl[0] - vertex[0], y: inCtl[1] - vertex[1] },
      outTan: { x: outCtl[0] - vertex[0], y: outCtl[1] - vertex[1] },
    });
  }

  return { points, closed: true };
}

export interface TaggedPt {
  pt: Pt;
  /** Which operand this point came from. */
  tag: number;
}

/** Andrew's monotone chain. Returns hull vertices in cyclic order, tags intact. */
export function convexHull(input: TaggedPt[]): TaggedPt[] {
  const pts = input
    .slice()
    .sort((a, b) => (a.pt[0] === b.pt[0] ? a.pt[1] - b.pt[1] : a.pt[0] - b.pt[0]));

  if (pts.length < 3) return pts;

  const cross = (o: TaggedPt, a: TaggedPt, b: TaggedPt): number =>
    (a.pt[0] - o.pt[0]) * (b.pt[1] - o.pt[1]) - (a.pt[1] - o.pt[1]) * (b.pt[0] - o.pt[0]);

  const lower: TaggedPt[] = [];

  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }

  const upper: TaggedPt[] = [];

  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;

    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }

  lower.pop();
  upper.pop();

  return lower.concat(upper);
}
