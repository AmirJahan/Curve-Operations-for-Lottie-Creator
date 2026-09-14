/**
 * Blend geometry: fuses shapes with bridges that meet each outline smoothly.
 *
 * Each long edge of a bridge is a fillet — an arc of a circle that touches both
 * shapes. A circle touching a curve shares its tangent at the contact point, so
 * the arc leaves one outline and joins the other without a crease. Where the
 * contact lands on a sharp corner, which has no single tangent to share, that
 * corner is rounded off first and the fillet is solved again against the
 * softened outline.
 *
 * The joined outline is stitched together by hand — the far side of one shape,
 * an arc, the far side of the other, the second arc — instead of being left to
 * the clipper. Each arc only grazes its outline at the contact, and any
 * intersection computed there is ill-conditioned: it leaves needle slivers, and
 * can stall the sweep outright.
 */

import type { TaggedPt } from './geom';
import { FLATTEN_TOLERANCE, convexHull } from './geom';
import { CORNER_DEGREES } from './fit';
import type { MultiPoly, Pt, Ring } from './martinez';
import { INTERSECTION, UNION, boolop } from './martinez';

/** Where a bridge arc meets an outline, and the tangent the two share there. */
export interface Joint {
  pt: Pt;
  /** Unit tangent. Its sign carries no meaning. */
  tangent: Pt;
}

export interface BlendResult {
  polys: MultiPoly;
  joints: Joint[];
  bridges: number;
  /** True if any requested radius had to grow so the arcs could reach or stay apart. */
  clamped: boolean;
}

/** A contact sharper than this gets rounded so the arc has a tangent to meet. */
const ROUND_DEGREES = 15;
/** How far along the outline a rounded corner reaches, as a share of the arc radius. */
const ROUND_REACH = 0.25;
/** Each round softens one corner; a shape can present a few before the fillets settle. */
const MAX_ROUNDS = 8;
/** Largest angle one arc sample may span, so the fitter never mistakes it for a corner. */
const MAX_ARC_STEP = (8 * Math.PI) / 180;
/** Both fillets on one shape must touch it at least this share of its size apart. */
const MIN_CONTACT_SPREAD = 0.1;
/** How far outside the stitched outline a left-out point may sit before it counts as lost. */
const CONTAIN_TOLERANCE = 0.05;
/** A contact within this distance of an outline is taken to lie exactly on it. */
const ON_OUTLINE = 1e-6;
/** Points this close on both axes are the same point. */
const NEAR = 1e-9;
const SNAP = 1e4;

/* ------------------------------------------------------------------ *
 * Vector helpers
 * ------------------------------------------------------------------ */

function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]];
}

function add(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]];
}

function scale(a: Pt, s: number): Pt {
  return [a[0] * s, a[1] * s];
}

function dot(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1];
}

function cross(a: Pt, b: Pt): number {
  return a[0] * b[1] - a[1] * b[0];
}

function normalize(a: Pt): Pt {
  const l = Math.hypot(a[0], a[1]);

  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
}

function snap(p: Pt): Pt {
  return [Math.round(p[0] * SNAP) / SNAP, Math.round(p[1] * SNAP) / SNAP];
}

/** Equal up to floating-point noise, so no zero-length edge survives with a meaningless direction. */
function samePt(a: Pt, b: Pt): boolean {
  return Math.abs(a[0] - b[0]) <= NEAR && Math.abs(a[1] - b[1]) <= NEAR;
}

/* ------------------------------------------------------------------ *
 * Outline queries
 * ------------------------------------------------------------------ */

/** A point on an outline: segment `seg` of ring `ring`, at parameter `t`. */
interface Hit {
  ring: number;
  seg: number;
  t: number;
  pt: Pt;
  dist: number;
}

function openRing(ring: Ring): Pt[] {
  return ring.slice(0, -1);
}

function outerRings(polys: MultiPoly): Ring[] {
  return polys.map((poly) => poly[0]!);
}

/** Length of the diagonal of the shape's bounding box. */
function extent(polys: MultiPoly): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const ring of outerRings(polys)) {
    for (const p of ring) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }

  return Math.hypot(maxX - minX, maxY - minY);
}

function nearestOnRings(rings: Ring[], c: Pt): Hit {
  let best: Hit = { ring: -1, seg: -1, t: 0, pt: c, dist: Infinity };

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;

    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = l2 === 0 ? 0 : ((c[0] - a[0]) * dx + (c[1] - a[1]) * dy) / l2;

      t = t < 0 ? 0 : t > 1 ? 1 : t;

      const px = a[0] + dx * t;
      const py = a[1] + dy * t;
      const dist = Math.hypot(c[0] - px, c[1] - py);

      if (dist < best.dist) best = { ring: r, seg: i, t, pt: [px, py], dist };
    }
  }

  return best;
}

/** Farthest outline vertex from `c` among those on the `n` side of `origin`. */
function farthestOnRings(rings: Ring[], c: Pt, origin: Pt, n: Pt): Hit | undefined {
  let best: Hit | undefined;

  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!;

    for (let i = 0; i < ring.length - 1; i++) {
      const v = ring[i]!;

      if (dot(sub(v, origin), n) < 0) continue;

      const dist = Math.hypot(v[0] - c[0], v[1] - c[1]);

      if (!best || dist > best.dist) best = { ring: r, seg: i, t: 0, pt: v, dist };
    }
  }

  return best;
}

/**
 * True if the circle holds both outline neighbours of a vertex contact — the
 * test that separates a circle touching the outline there from one crossing it.
 */
function wraps(rings: Ring[], hit: Hit, center: Pt, radius: number): boolean {
  const open = openRing(rings[hit.ring]!);
  const n = open.length;
  const limit = radius * (1 + 1e-6) + 1e-6;
  const holds = (p: Pt): boolean => Math.hypot(p[0] - center[0], p[1] - center[1]) <= limit;

  return holds(open[(hit.seg - 1 + n) % n]!) && holds(open[(hit.seg + 1) % n]!);
}

function insideRings(rings: Ring[], p: Pt): boolean {
  for (const ring of rings) {
    let inside = false;

    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;

      if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
        inside = !inside;
      }
    }

    if (inside) return true;
  }

  return false;
}

function signedDistance(rings: Ring[], p: Pt): number {
  const d = nearestOnRings(rings, p).dist;

  return insideRings(rings, p) ? -d : d;
}

/** The exterior turn at vertex `k`, in radians. */
function turnAt(open: Pt[], k: number): number {
  const n = open.length;
  const a = sub(open[k]!, open[(k - 1 + n) % n]!);
  const b = sub(open[(k + 1) % n]!, open[k]!);

  return Math.abs(Math.atan2(cross(a, b), dot(a, b)));
}

/** Vertex index a hit sits on, or -1 if it falls inside a segment. */
function hitVertex(hit: Hit, n: number): number {
  if (hit.t <= 1e-9) return hit.seg;
  if (hit.t >= 1 - 1e-9) return (hit.seg + 1) % n;

  return -1;
}

function segmentsCross(p1: Pt, p2: Pt, q1: Pt, q2: Pt): { t: number; u: number } | undefined {
  const r = sub(p2, p1);
  const s = sub(q2, q1);
  const denom = cross(r, s);

  if (denom === 0) return undefined;

  const qp = sub(q1, p1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;

  return t < 0 || t > 1 || u < 0 || u > 1 ? undefined : { t, u };
}

/** True if no two edges of the closed ring cross away from their shared ends. */
function isSimple(ring: Ring): boolean {
  const n = ring.length - 1;

  for (let i = 0; i < n; i++) {
    const a1 = ring[i]!;
    const a2 = ring[i + 1]!;
    const minX = Math.min(a1[0], a2[0]);
    const maxX = Math.max(a1[0], a2[0]);
    const minY = Math.min(a1[1], a2[1]);
    const maxY = Math.max(a1[1], a2[1]);

    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;

      const b1 = ring[j]!;
      const b2 = ring[j + 1]!;

      if (Math.max(b1[0], b2[0]) < minX || Math.min(b1[0], b2[0]) > maxX) continue;
      if (Math.max(b1[1], b2[1]) < minY || Math.min(b1[1], b2[1]) > maxY) continue;

      const hit = segmentsCross(a1, a2, b1, b2);

      if (hit && hit.t > 1e-9 && hit.t < 1 - 1e-9 && hit.u > 1e-9 && hit.u < 1 - 1e-9) return false;
    }
  }

  return true;
}

function closeRing(points: Pt[]): Ring | undefined {
  const ring: Pt[] = [];

  for (const p of points) if (ring.length === 0 || !samePt(ring[ring.length - 1]!, p)) ring.push(p);
  if (ring.length > 1 && samePt(ring[0]!, ring[ring.length - 1]!)) ring.pop();
  if (ring.length < 3) return undefined;
  ring.push([ring[0]![0], ring[0]![1]]);

  return ring;
}

/* ------------------------------------------------------------------ *
 * Corner rounding
 * ------------------------------------------------------------------ */

/** Walks `dist` along the outline from vertex `k`, forward (+1) or back (-1). */
function walk(open: Pt[], k: number, dist: number, dir: 1 | -1): { pt: Pt; seg: number } {
  const n = open.length;
  let i = k;
  let remaining = dist;

  for (let guard = 0; guard < n; guard++) {
    const j = (i + dir + n) % n;
    const a = open[i]!;
    const b = open[j]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);

    if (len >= remaining && len > 0) {
      const f = remaining / len;

      return { pt: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], seg: dir > 0 ? i : j };
    }

    remaining -= len;
    i = j;
  }

  return { pt: open[i]!, seg: dir > 0 ? i : (i - 1 + n) % n };
}

/** Outline length from vertex `k` to the next sharp corner in direction `dir`. */
function reachToCorner(open: Pt[], k: number, dir: 1 | -1): number {
  const n = open.length;
  const threshold = (CORNER_DEGREES * Math.PI) / 180;
  let total = 0;
  let i = k;

  for (let guard = 0; guard < n; guard++) {
    const j = (i + dir + n) % n;

    total += Math.hypot(open[j]![0] - open[i]![0], open[j]![1] - open[i]![1]);
    if (j === k || turnAt(open, j) >= threshold) return total;
    i = j;
  }

  return total;
}

/**
 * Replaces vertex `k` with a smooth cubic fillet reaching `reach` along the
 * outline each way, stopping short of neighbouring corners so they keep an edge.
 */
function roundCorner(ring: Ring, k: number, reach: number): Ring | undefined {
  const open = openRing(ring);
  const n = open.length;

  if (n < 3) return undefined;

  let perimeter = 0;

  for (let i = 0; i < n; i++) perimeter += Math.hypot(open[(i + 1) % n]![0] - open[i]![0], open[(i + 1) % n]![1] - open[i]![1]);

  const s = Math.min(reach, 0.45 * reachToCorner(open, k, -1), 0.45 * reachToCorner(open, k, 1), 0.15 * perimeter);

  if (!(s > 1e-3)) return undefined;

  const a = walk(open, k, s, -1);
  const b = walk(open, k, s, 1);

  if (a.seg === b.seg) return undefined;

  const out: Pt[] = [snap(b.pt)];

  for (let i = (b.seg + 1) % n, guard = 0; guard < n; i = (i + 1) % n, guard++) {
    out.push(open[i]!);
    if (i === a.seg) break;
  }

  out.push(snap(a.pt));

  // A circular fillet of this span has its handles at 4/3 tan(phi/4) of its radius.
  const da = normalize(sub(open[(a.seg + 1) % n]!, open[a.seg]!));
  const db = normalize(sub(open[(b.seg + 1) % n]!, open[b.seg]!));
  const phi = Math.abs(Math.atan2(cross(da, db), dot(da, db)));
  const handle = phi < 1e-3 ? (2 * s) / 3 : ((4 / 3) * Math.tan(phi / 4) * s) / Math.tan(phi / 2);
  const c1 = add(a.pt, scale(da, handle));
  const c2 = sub(b.pt, scale(db, handle));
  const steps = Math.max(4, Math.ceil(phi / ((6 * Math.PI) / 180)));

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const w0 = u * u * u;
    const w1 = 3 * u * u * t;
    const w2 = 3 * u * t * t;
    const w3 = t * t * t;

    out.push(
      snap([
        w0 * a.pt[0] + w1 * c1[0] + w2 * c2[0] + w3 * b.pt[0],
        w0 * a.pt[1] + w1 * c1[1] + w2 * c2[1] + w3 * b.pt[1],
      ])
    );
  }

  return closeRing(out);
}

/* ------------------------------------------------------------------ *
 * Fillet circles
 * ------------------------------------------------------------------ */

/** One side of the gap: the hull edge running from shape A to shape B. */
interface Side {
  mid: Pt;
  /** Unit normal pointing out of the hull. */
  n: Pt;
  span: number;
}

interface Arc {
  center: Pt;
  radius: number;
  onA: Hit;
  onB: Hit;
  /** From the contact on A to the contact on B, both included. */
  points: Pt[];
}

type Field = (c: Pt) => { value: number; grad: Pt; hit: Hit } | undefined;

/** Signed distance to the outline, for a circle sitting outside it. */
function outsideField(rings: Ring[]): Field {
  return (c) => {
    const hit = nearestOnRings(rings, c);

    if (!(hit.dist > 0)) return undefined;

    const sign = insideRings(rings, c) ? -1 : 1;

    return { value: sign * hit.dist, grad: scale(normalize(sub(c, hit.pt)), sign), hit };
  };
}

/** Distance to the farthest outline point, for a circle wrapped around it. */
function enclosingField(rings: Ring[], origin: Pt, n: Pt): Field {
  return (c) => {
    const hit = farthestOnRings(rings, c, origin, n);

    if (!hit || !(hit.dist > 0)) return undefined;

    return { value: hit.dist, grad: normalize(sub(c, hit.pt)), hit };
  };
}

/** Newton's method for the centre sitting at `radius` from both fields. */
function solveCenter(guess: Pt, fieldA: Field, fieldB: Field, radius: number, maxStep: number) {
  const eps = 1e-4 * Math.max(1, radius);
  let c = guess;

  for (let iter = 0; iter < 60; iter++) {
    const a = fieldA(c);
    const b = fieldB(c);

    if (!a || !b) return undefined;

    const fa = a.value - radius;
    const fb = b.value - radius;

    if (Math.abs(fa) < eps && Math.abs(fb) < eps) return { center: c, onA: a.hit, onB: b.hit };

    const det = cross(a.grad, b.grad);

    if (Math.abs(det) < 1e-7) return undefined;

    let dx = (-fa * b.grad[1] + fb * a.grad[1]) / det;
    let dy = (-fb * a.grad[0] + fa * b.grad[0]) / det;
    const step = Math.hypot(dx, dy);

    if (step > maxStep) {
      dx *= maxStep / step;
      dy *= maxStep / step;
    }

    c = [c[0] + dx, c[1] + dy];
  }

  return undefined;
}

/** Samples the arc of the circle from `from` to `to` that passes toward `toward`. */
function arcSamples(center: Pt, radius: number, from: Pt, to: Pt, toward: Pt): { points: Pt[]; sweep: number } {
  const a0 = Math.atan2(from[1] - center[1], from[0] - center[0]);
  const a1 = Math.atan2(to[1] - center[1], to[0] - center[0]);
  let delta = a1 - a0;

  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta <= -Math.PI) delta += 2 * Math.PI;

  const mid = a0 + delta / 2;

  if (Math.cos(mid) * toward[0] + Math.sin(mid) * toward[1] < 0) delta += delta > 0 ? -2 * Math.PI : 2 * Math.PI;

  const byTolerance = FLATTEN_TOLERANCE >= radius ? Math.PI : 2 * Math.acos(1 - FLATTEN_TOLERANCE / radius);
  const step = Math.min(byTolerance, MAX_ARC_STEP);
  const count = Math.max(2, Math.min(720, Math.ceil(Math.abs(delta) / step)));
  const points: Pt[] = [from];

  for (let i = 1; i < count; i++) {
    const angle = a0 + (delta * i) / count;

    points.push(snap([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]));
  }

  points.push(to);

  return { points, sweep: Math.abs(delta) };
}

/**
 * The fillet on one side. A positive radius is a waist (the circle sits outside
 * both shapes); a negative one is a bulge (the circle wraps around them).
 */
function solveSide(side: Side, ringsA: Ring[], ringsB: Ring[], radius: number, gapCenter: Pt): Arc | undefined {
  const r = Math.abs(radius);
  const bulge = radius < 0;
  const lift = Math.sqrt(Math.max(0, r * r - (side.span * side.span) / 4));
  const guess = add(side.mid, scale(side.n, bulge ? -lift : lift));
  const fieldA = bulge ? enclosingField(ringsA, gapCenter, side.n) : outsideField(ringsA);
  const fieldB = bulge ? enclosingField(ringsB, gapCenter, side.n) : outsideField(ringsB);
  const solved = solveCenter(guess, fieldA, fieldB, r, 0.5 * Math.max(r, side.span));

  if (!solved) return undefined;

  // Newton can wander onto the opposite side of the gap; that circle is not ours.
  if (dot(sub(solved.onA.pt, gapCenter), side.n) < 0) return undefined;
  if (dot(sub(solved.onB.pt, gapCenter), side.n) < 0) return undefined;
  if (samePt(solved.onA.pt, solved.onB.pt)) return undefined;

  const arc = arcSamples(solved.center, r, solved.onA.pt, solved.onB.pt, bulge ? side.n : scale(side.n, -1));

  if (bulge) {
    // Past a half circle, a bulge stops bridging the gap and starts wrapping the shapes.
    if (arc.sweep > Math.PI) return undefined;

    // The side-of-gap cut can hand back a vertex the circle merely crosses.
    if (!wraps(ringsA, solved.onA, solved.center, r) || !wraps(ringsB, solved.onB, solved.center, r)) return undefined;
  }

  return { center: solved.center, radius: r, onA: solved.onA, onB: solved.onB, points: arc.points };
}

/** True if the two arcs cross, or pass closer than `minGap`. */
function arcsCollide(a: Pt[], b: Pt[], minGap: number): boolean {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsCross(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) return true;
    }
  }

  if (minGap <= 0) return false;

  const gap2 = minGap * minGap;

  for (const p of a) {
    for (const q of b) {
      if ((p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 < gap2) return true;
    }
  }

  return false;
}

/** The two hull edges that cross the gap, each with its outward normal. */
function gapSides(a: MultiPoly, b: MultiPoly): Side[] | undefined {
  const tagged: TaggedPt[] = [];

  outerRings(a).forEach((ring) => openRing(ring).forEach((pt) => tagged.push({ pt, tag: 0 })));
  outerRings(b).forEach((ring) => openRing(ring).forEach((pt) => tagged.push({ pt, tag: 1 })));

  const hull = convexHull(tagged);

  if (hull.length < 4) return undefined;

  const transitions: number[] = [];

  for (let i = 0; i < hull.length; i++) {
    if (hull[i]!.tag !== hull[(i + 1) % hull.length]!.tag) transitions.push(i);
  }

  // Anything other than two crossings means one shape wraps the other.
  if (transitions.length !== 2) return undefined;

  const centroid = hull.reduce<Pt>((acc, h) => [acc[0] + h.pt[0] / hull.length, acc[1] + h.pt[1] / hull.length], [0, 0]);

  return transitions.map((t) => {
    const p = hull[t]!.pt;
    const q = hull[(t + 1) % hull.length]!.pt;
    const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    let n = normalize([q[1] - p[1], p[0] - q[0]]);

    if (dot(sub(mid, centroid), n) < 0) n = scale(n, -1);

    return { mid, n, span: Math.hypot(q[0] - p[0], q[1] - p[1]) };
  });
}

interface Bridge {
  top: Arc;
  bottom: Arc;
  clamped: boolean;
}

/**
 * Solves the pair of fillets bridging two shapes, rounding their outlines where
 * a fillet lands on a corner. `a` and `b` are edited in place by that rounding.
 */
function solveBridge(a: MultiPoly, b: MultiPoly, radius: number): Bridge | undefined {
  const sides = gapSides(a, b);

  if (!sides) return undefined;

  const [top, bottom] = sides as [Side, Side];
  const gapCenter: Pt = [(top.mid[0] + bottom.mid[0]) / 2, (top.mid[1] + bottom.mid[1]) / 2];
  const overlapping = boolop(a, b, INTERSECTION).length > 0;
  // Leave a tenth of the gap open, so the tightest waist never pinches shut.
  const minGap = overlapping ? 0 : 0.1 * Math.hypot(top.mid[0] - bottom.mid[0], top.mid[1] - bottom.mid[1]);
  const spreadA = MIN_CONTACT_SPREAD * extent(a);
  const spreadB = MIN_CONTACT_SPREAD * extent(b);
  const sign = radius < 0 ? -1 : 1;
  const base = (side: Side): number => (radius === 0 ? side.span : Math.abs(radius));
  const apart = (p: Pt, q: Pt, spread: number): boolean => Math.hypot(p[0] - q[0], p[1] - q[1]) >= spread;

  const attempt = (factor: number) => {
    const ringsA = outerRings(a);
    const ringsB = outerRings(b);
    const arcT = solveSide(top, ringsA, ringsB, sign * base(top) * factor, gapCenter);
    const arcB = arcT && solveSide(bottom, ringsA, ringsB, sign * base(bottom) * factor, gapCenter);

    if (!arcT || !arcB) return undefined;
    if (sign > 0 && arcsCollide(arcT.points, arcB.points, minGap)) return undefined;
    // Both fillets touching a shape in nearly the same spot would pinch it to a point.
    if (!apart(arcT.onA.pt, arcB.onA.pt, spreadA) || !apart(arcT.onB.pt, arcB.onB.pt, spreadB)) return undefined;

    return [arcT, arcB] as const;
  };

  // Grow the radius until the fillets fit, then bisect back to the smallest that does.
  const widen = () => {
    const direct = attempt(1);

    if (direct) return { arcs: direct, clamped: false };

    let lo = 1;
    let hi = 1;
    let found: ReturnType<typeof attempt>;

    for (let k = 0; k < 16 && !found; k++) {
      lo = hi;
      hi *= 2;
      found = attempt(hi);
    }

    if (!found) return undefined;

    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2;
      const next = attempt(mid);

      if (next) {
        hi = mid;
        found = next;
      } else {
        lo = mid;
      }
    }

    return { arcs: found, clamped: true };
  };

  let solved = widen();

  // Contacts on sharp corners get rounded, one at a time, then everything is solved again.
  for (let round = 0; solved && round < MAX_ROUNDS; round++) {
    let changed = false;

    for (const arc of solved.arcs) {
      for (const [polys, hit] of [[a, arc.onA], [b, arc.onB]] as const) {
        const ring = polys[hit.ring]![0]!;
        const open = openRing(ring);
        const k = hitVertex(hit, open.length);

        if (k < 0 || turnAt(open, k) < (ROUND_DEGREES * Math.PI) / 180) continue;

        const rounded = roundCorner(ring, k, ROUND_REACH * arc.radius);

        if (!rounded) continue;
        polys[hit.ring]![0] = rounded;
        changed = true;
        break;
      }

      if (changed) break;
    }

    if (!changed) break;
    solved = widen();
  }

  return solved && { top: solved.arcs[0], bottom: solved.arcs[1], clamped: solved.clamped };
}

function bridgeJoints(bridge: Bridge): Joint[] {
  const joints: Joint[] = [];

  for (const arc of [bridge.top, bridge.bottom]) {
    for (const hit of [arc.onA, arc.onB]) {
      const normal = normalize(sub(arc.center, hit.pt));

      joints.push({ pt: hit.pt, tangent: [-normal[1], normal[0]] });
    }
  }

  return joints;
}

/* ------------------------------------------------------------------ *
 * Joining outlines
 * ------------------------------------------------------------------ */

/** The outline of one ring between two hits, walking forward or backward. */
function ringPath(open: Pt[], from: Hit, to: Hit, forward: boolean): Pt[] {
  const n = open.length;
  const out: Pt[] = [from.pt];

  if (forward) {
    if (!(from.seg === to.seg && to.t >= from.t)) {
      for (let i = (from.seg + 1) % n, guard = 0; guard <= n; i = (i + 1) % n, guard++) {
        out.push(open[i]!);
        if (i === to.seg) break;
      }
    }
  } else if (!(from.seg === to.seg && to.t <= from.t)) {
    for (let i = from.seg, guard = 0; guard <= n; i = (i - 1 + n) % n, guard++) {
      out.push(open[i]!);
      if (i === (to.seg + 1) % n) break;
    }
  }

  out.push(to.pt);

  const deduped: Pt[] = [];

  for (const p of out) if (deduped.length === 0 || !samePt(deduped[deduped.length - 1]!, p)) deduped.push(p);

  return deduped;
}

/**
 * Cuts a ring at two contacts into the stretch facing the other shape and the
 * far side, both running from `from` to `to`.
 */
function splitOutline(ring: Ring, from: Hit, to: Hit, other: Ring[]): { facing: Pt[]; far: Pt[] } {
  const open = openRing(ring);
  // The facing stretch is the one that reaches closest to — or furthest into — the other shape.
  const score = (path: Pt[]): number => {
    const stride = Math.max(1, Math.floor(path.length / 64));
    let best = Infinity;

    for (let i = 0; i < path.length; i += stride) best = Math.min(best, signedDistance(other, path[i]!));

    return best;
  };
  const forward = ringPath(open, from, to, true);
  const backward = ringPath(open, from, to, false);

  return score(forward) <= score(backward) ? { facing: forward, far: backward } : { facing: backward, far: forward };
}

/**
 * Re-finds an arc's contacts on the outlines about to be joined. Earlier joins
 * and later rounding both rebuild rings, so the original indices are stale.
 */
function relocate(arc: Arc, a: MultiPoly, b: MultiPoly): { arc: Arc; exact: boolean } {
  const onA = nearestOnRings(outerRings(a), arc.onA.pt);
  const onB = nearestOnRings(outerRings(b), arc.onB.pt);
  const exact = onA.dist <= ON_OUTLINE && onB.dist <= ON_OUTLINE;

  // Keep the arc's own endpoints, so the stitch meets them exactly.
  if (exact) {
    onA.pt = arc.onA.pt;
    onB.pt = arc.onB.pt;
  }

  return { arc: { ...arc, onA, onB }, exact };
}

/**
 * Joins the two outlines along the arcs: A's far side, the top arc, B's far
 * side, and the bottom arc back to the start.
 *
 * @returns undefined when that outline would cross itself or leave out part of
 * either shape, so the caller can fall back to clipping.
 */
function stitch(a: MultiPoly, b: MultiPoly, top: Arc, bottom: Arc): MultiPoly | undefined {
  const ia = top.onA.ring;
  const ib = top.onB.ring;

  if (bottom.onA.ring !== ia || bottom.onB.ring !== ib) return undefined;

  const polyA = a[ia]!;
  const polyB = b[ib]!;

  // Where the shapes overlap, one may fill part of the other's hole; only the clipper knows how much.
  if ((polyA.length > 1 || polyB.length > 1) && boolop(a, b, INTERSECTION).length > 0) return undefined;

  const sideA = splitOutline(polyA[0]!, top.onA, bottom.onA, outerRings(b));
  const sideB = splitOutline(polyB[0]!, top.onB, bottom.onB, outerRings(a));
  const outline = closeRing([
    ...sideA.far.slice().reverse(),
    ...top.points.slice(1),
    ...sideB.far.slice(1),
    ...bottom.points.slice().reverse().slice(1),
  ]);

  if (!outline || !isSimple(outline)) return undefined;

  // The stretches left out must already lie inside the new outline, or material is lost.
  for (const path of [sideA.facing, sideB.facing]) {
    const stride = Math.max(1, Math.floor(path.length / 24));

    for (let i = stride; i < path.length - 1; i += stride) {
      const p = path[i]!;

      if (!insideRings([outline], p) && nearestOnRings([outline], p).dist > CONTAIN_TOLERANCE) return undefined;
    }
  }

  return [
    [outline, ...polyA.slice(1), ...polyB.slice(1)],
    ...a.filter((_, i) => i !== ia),
    ...b.filter((_, i) => i !== ib),
  ];
}

/**
 * Makes each contact a real vertex of its outline, so a bridge region running
 * along the outline from there shares that vertex exactly with the shape.
 */
function insertContacts(polys: MultiPoly, hits: Hit[]): void {
  // Latest positions first, so the earlier indices stay valid.
  const sorted = hits.slice().sort((x, y) => y.ring - x.ring || y.seg - x.seg || y.t - x.t);

  for (const hit of sorted) {
    if (hit.t <= 1e-9 || hit.t >= 1 - 1e-9) continue;
    polys[hit.ring]![0]!.splice(hit.seg + 1, 0, hit.pt);
  }
}

function firstCrossing(path: Pt[], other: Pt[], fromEnd: boolean) {
  const order = path.map((_, i) => i).slice(0, -1);

  if (fromEnd) order.reverse();

  for (const i of order) {
    let best: { i: number; j: number; pt: Pt; t: number } | undefined;

    for (let j = 0; j < other.length - 1; j++) {
      const hit = segmentsCross(path[i]!, path[i + 1]!, other[j]!, other[j + 1]!);

      if (!hit) continue;

      const t = fromEnd ? 1 - hit.t : hit.t;

      if (!best || t < best.t) {
        best = { i, j, t, pt: [path[i]![0] + (path[i + 1]![0] - path[i]![0]) * hit.t, path[i]![1] + (path[i + 1]![1] - path[i]![1]) * hit.t] };
      }
    }

    if (best) return best;
  }

  return undefined;
}

/**
 * Fallback for outlines that cannot be stitched: fills the bridge as regions and
 * lets the clipper merge them, leaving out any region it cannot handle.
 */
function fuseWithRegions(a: MultiPoly, b: MultiPoly, top: Arc, bottom: Arc): MultiPoly {
  const ringsA = outerRings(a);
  const ringsB = outerRings(b);
  const facing = (rings: Ring[], from: Hit, to: Hit, other: Ring[]): Pt[] =>
    // Contacts on separate rings of a compound shape: a chord is the best we have.
    from.ring === to.ring ? splitOutline(rings[from.ring]!, from, to, other).facing : [from.pt, to.pt];
  const pathA = facing(ringsA, top.onA, bottom.onA, ringsB);
  const pathB = facing(ringsB, top.onB, bottom.onB, ringsA);

  insertContacts(a, [top.onA, bottom.onA]);
  insertContacts(b, [top.onB, bottom.onB]);

  const backArc = bottom.points.slice().reverse();
  const regions: Ring[] = [];
  const crossTop = firstCrossing(pathB, pathA, false);
  const crossBottom = crossTop && firstCrossing(pathB, pathA, true);

  if (!crossTop || !crossBottom) {
    // Separate shapes: one region spanning the whole gap.
    const region = closeRing([...top.points, ...pathB.slice(1), ...backArc.slice(1), ...pathA.slice().reverse().slice(1)]);

    if (region) regions.push(region);
  } else {
    // Overlapping shapes: each fillet fills only its own notch.
    const upper = closeRing([
      ...top.points,
      ...pathB.slice(1, crossTop.i + 1),
      crossTop.pt,
      ...pathA.slice(1, crossTop.j + 1).reverse(),
    ]);
    const lower = closeRing([
      ...backArc,
      ...pathA.slice(crossBottom.j + 1, pathA.length - 1).reverse(),
      crossBottom.pt,
      ...pathB.slice(crossBottom.i + 1, pathB.length - 1),
    ]);

    if (upper) regions.push(upper);
    if (lower) regions.push(lower);
  }

  let result = boolop(a, b, UNION);

  for (const ring of regions) {
    // A region crossing itself is exactly what sends the sweep into a spin.
    if (!isSimple(ring)) continue;

    try {
      result = boolop(result, [[ring]], UNION);
    } catch {
      // Leave this side unbridged rather than fail the whole blend.
    }
  }

  return result;
}

/**
 * Joins `next` onto everything fused so far.
 *
 * The bridge solved against `next`'s neighbour is used while its contacts are
 * still on the fused outline. On a small middle shape the two fillets can
 * compete for the same stretch, which the previous join has already replaced;
 * then the bridge is solved again against the fused outline itself.
 */
function fuse(sofar: MultiPoly, next: MultiPoly, bridge: Bridge, radius: number): { polys: MultiPoly; bridge: Bridge } {
  const join = (candidate: Bridge) => {
    const top = relocate(candidate.top, sofar, next);
    const bottom = relocate(candidate.bottom, sofar, next);

    return { top, bottom, polys: top.exact && bottom.exact ? stitch(sofar, next, top.arc, bottom.arc) : undefined };
  };
  const first = join(bridge);

  if (first.polys) return { polys: first.polys, bridge };

  const resolved = solveBridge(sofar, next, radius);
  const second = resolved && join(resolved);

  if (resolved && second && second.polys) return { polys: second.polys, bridge: resolved };

  const last = resolved && second ? second : first;

  return { polys: fuseWithRegions(sofar, next, last.top.arc, last.bottom.arc), bridge: resolved ?? bridge };
}

/** Drops needle spikes, where an outline runs out and straight back along itself. */
function removeSpikes(ring: Ring): Ring {
  const pts = openRing(ring);
  let changed = true;

  while (changed && pts.length > 3) {
    changed = false;

    for (let i = 0; i < pts.length && pts.length > 3; i++) {
      const a = sub(pts[i]!, pts[(i - 1 + pts.length) % pts.length]!);
      const b = sub(pts[(i + 1) % pts.length]!, pts[i]!);
      const la = Math.hypot(a[0], a[1]);
      const lb = Math.hypot(b[0], b[1]);

      if (la <= NEAR || lb <= NEAR || (Math.abs(cross(a, b)) <= 1e-3 * la * lb && dot(a, b) < 0)) {
        pts.splice(i, 1);
        i--;
        changed = true;
      }
    }
  }

  pts.push([pts[0]![0], pts[0]![1]]);

  return pts;
}

/**
 * Blends a chain of shapes, each bridged to its neighbour. `radius` is the
 * fillet radius in scene units: 0 sizes each arc to its gap, negative bulges.
 */
export function blendChain(chain: MultiPoly[], radius: number): BlendResult {
  // Deep copies: rounding and joining edit these rings in place.
  const polys = chain.map((multi) => multi.map((poly) => poly.map((ring) => ring.slice())));
  // Every bridge is solved first, so all corner rounding is in place before any joining.
  const bridges = polys.slice(1).map((next, i) => solveBridge(polys[i]!, next, radius));
  let result: MultiPoly = polys[0] ?? [];

  const used: Bridge[] = [];

  for (let i = 1; i < polys.length; i++) {
    const bridge = bridges[i - 1];

    if (!bridge) {
      result = boolop(result, polys[i]!, UNION);
      continue;
    }

    const fused = fuse(result, polys[i]!, bridge, radius);

    result = fused.polys;
    used.push(fused.bridge);
  }

  // A compound shape's other pieces can still overlap the joined outline; merge them in.
  if (result.length > 1) {
    result = result.slice(1).reduce<MultiPoly>((acc, poly) => boolop(acc, [poly], UNION), [result[0]!]);
  }

  return {
    polys: result.map((poly) => poly.map(removeSpikes)),
    joints: used.flatMap(bridgeJoints),
    bridges: used.length,
    clamped: used.some((bridge) => bridge.clamped),
  };
}
