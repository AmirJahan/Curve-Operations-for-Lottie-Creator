/**
 * Cubic bezier curve fitting.
 *
 * Boolean clipping works on flattened polylines, so its output carries one
 * vertex per flattening step — hundreds for a shape that started as four
 * bezier segments. This refits those polylines with the fewest cubic segments
 * that stay within tolerance, after splitting at corners so creases survive.
 *
 * Least-squares fit with Newton-Raphson reparameterisation, after Schneider,
 * "An Algorithm for Automatically Fitting Digitized Curves" (Graphics Gems, 1990).
 */

import type { Joint } from './blend';
import type { Pt, Ring } from './martinez';

/** `[anchor, controlOut, controlIn, anchor]`, all absolute. */
export type Cubic = [Pt, Pt, Pt, Pt];

/** A turn sharper than this is treated as a corner and never smoothed over. */
export const CORNER_DEGREES = 30;
/** A joint this close to the ring is pinned onto it. */
const JOINT_SNAP = 0.25;
/** Both outline edges at a joint must run within 25° of its tangent. */
const JOINT_ALIGN = Math.cos((25 * Math.PI) / 180);
/** Recursion guard; each level splits the run in two. */
const MAX_DEPTH = 24;

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

function length(a: Pt): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1]);
}

function normalize(a: Pt): Pt {
  const l = length(a);

  return l === 0 ? [0, 0] : [a[0] / l, a[1] / l];
}

function negate(a: Pt): Pt {
  return [-a[0], -a[1]];
}

function bezierAt(bez: Cubic, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;

  return [
    w0 * bez[0][0] + w1 * bez[1][0] + w2 * bez[2][0] + w3 * bez[3][0],
    w0 * bez[0][1] + w1 * bez[1][1] + w2 * bez[2][1] + w3 * bez[3][1],
  ];
}

/** Chord-length parameterisation, normalised to [0, 1]. */
function parameterize(points: Pt[]): number[] {
  const u: number[] = [0];

  for (let i = 1; i < points.length; i++) {
    u.push(u[i - 1]! + length(sub(points[i]!, points[i - 1]!)));
  }

  const total = u[u.length - 1]!;

  if (total === 0) return points.map((_, i) => i / Math.max(1, points.length - 1));

  return u.map((value) => value / total);
}

/** Least-squares fit of one cubic to `points`, with the end tangents fixed. */
function generateBezier(points: Pt[], u: number[], tan1: Pt, tan2: Pt): Cubic {
  const first = points[0]!;
  const last = points[points.length - 1]!;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;

  for (let i = 0; i < points.length; i++) {
    const t = u[i]!;
    const ut = 1 - t;
    const b0 = ut * ut * ut;
    const b1 = 3 * ut * ut * t;
    const b2 = 3 * ut * t * t;
    const b3 = t * t * t;
    const a0 = scale(tan1, b1);
    const a1 = scale(tan2, b2);

    c00 += dot(a0, a0);
    c01 += dot(a0, a1);
    c11 += dot(a1, a1);

    const target = sub(points[i]!, add(scale(first, b0 + b1), scale(last, b2 + b3)));

    x0 += dot(a0, target);
    x1 += dot(a1, target);
  }

  const detC = c00 * c11 - c01 * c01;
  const chord = length(sub(last, first));
  let alpha1 = detC === 0 ? 0 : (x0 * c11 - c01 * x1) / detC;
  let alpha2 = detC === 0 ? 0 : (c00 * x1 - x0 * c01) / detC;

  // A degenerate solve means the handles collapsed or flipped; fall back to the
  // Wu/Barsky heuristic of a third of the chord.
  if (alpha1 < 1e-6 * chord || alpha2 < 1e-6 * chord) {
    alpha1 = chord / 3;
    alpha2 = chord / 3;
  }

  return [first, add(first, scale(tan1, alpha1)), add(last, scale(tan2, alpha2)), last];
}

/** Squared max deviation of the fit, and the point where it occurs. */
function computeMaxError(points: Pt[], bez: Cubic, u: number[]): { error: number; index: number } {
  let error = 0;
  let index = points.length >> 1;

  for (let i = 1; i < points.length - 1; i++) {
    const d = sub(bezierAt(bez, u[i]!), points[i]!);
    const dist = d[0] * d[0] + d[1] * d[1];

    if (dist >= error) {
      error = dist;
      index = i;
    }
  }

  return { error, index };
}

/** One Newton-Raphson step toward the parameter closest to `point`. */
function refineParameter(bez: Cubic, point: Pt, u: number): number {
  const d = sub(bezierAt(bez, u), point);
  const q1: Pt[] = [
    scale(sub(bez[1], bez[0]), 3),
    scale(sub(bez[2], bez[1]), 3),
    scale(sub(bez[3], bez[2]), 3),
  ];
  const q2: Pt[] = [scale(sub(q1[1]!, q1[0]!), 2), scale(sub(q1[2]!, q1[1]!), 2)];
  const t = u;
  const ut = 1 - t;
  const d1: Pt = [
    ut * ut * q1[0]![0] + 2 * ut * t * q1[1]![0] + t * t * q1[2]![0],
    ut * ut * q1[0]![1] + 2 * ut * t * q1[1]![1] + t * t * q1[2]![1],
  ];
  const d2: Pt = [ut * q2[0]![0] + t * q2[1]![0], ut * q2[0]![1] + t * q2[1]![1]];
  const numerator = dot(d, d1);
  const denominator = d1[0] * d1[0] + d1[1] * d1[1] + dot(d, d2);

  if (denominator === 0) return u;

  return u - numerator / denominator;
}

function fitCubic(points: Pt[], tan1: Pt, tan2: Pt, tolerance: number, depth: number, out: Cubic[]): void {
  // Two points can only be a straight run; a cubic along it is exact.
  if (points.length === 2) {
    const first = points[0]!;
    const last = points[1]!;
    const d = length(sub(last, first)) / 3;

    out.push([first, add(first, scale(tan1, d)), add(last, scale(tan2, d)), last]);

    return;
  }

  const toleranceSq = tolerance * tolerance;
  let u = parameterize(points);
  let bez = generateBezier(points, u, tan1, tan2);
  let { error, index } = computeMaxError(points, bez, u);

  if (error < toleranceSq) {
    out.push(bez);

    return;
  }

  // Close enough to be worth polishing the parameterisation before splitting.
  if (error < toleranceSq * 16 && depth < MAX_DEPTH) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const refined = u.map((value, i) => refineParameter(bez, points[i]!, value));

      bez = generateBezier(points, refined, tan1, tan2);
      u = refined;

      const next = computeMaxError(points, bez, u);

      error = next.error;
      index = next.index;
      if (error < toleranceSq) {
        out.push(bez);

        return;
      }
    }
  }

  if (depth >= MAX_DEPTH || index < 1 || index > points.length - 2) {
    out.push(bez);

    return;
  }

  // Split at the worst point and fit each half.
  const center = normalize(sub(points[index - 1]!, points[index + 1]!));

  fitCubic(points.slice(0, index + 1), tan1, center, tolerance, depth + 1, out);
  fitCubic(points.slice(index), negate(center), tan2, tolerance, depth + 1, out);
}

/** Indices of `open` where the path turns sharply enough to be a corner. */
function findCorners(open: Pt[]): number[] {
  const threshold = Math.cos((CORNER_DEGREES * Math.PI) / 180);
  const corners: number[] = [];
  const n = open.length;

  for (let i = 0; i < n; i++) {
    const prev = open[(i - 1 + n) % n]!;
    const here = open[i]!;
    const next = open[(i + 1) % n]!;
    const incoming = normalize(sub(here, prev));
    const outgoing = normalize(sub(next, here));

    if (incoming[0] === 0 && incoming[1] === 0) continue;
    if (outgoing[0] === 0 && outgoing[1] === 0) continue;
    if (dot(incoming, outgoing) < threshold) corners.push(i);
  }

  return corners;
}

/**
 * Pins each joint onto the ring as a vertex, inserting one where needed.
 *
 * @returns the shared tangent of every joint, keyed by its vertex index.
 */
function placeJoints(open: Pt[], joints: ReadonlyArray<Joint>): Map<number, Pt> {
  const placed: Array<{ vertex: Pt; tangent: Pt }> = [];

  for (const joint of joints) {
    let best = -1;
    let bestDist = JOINT_SNAP;
    let bestT = 0;

    for (let i = 0; i < open.length; i++) {
      const a = open[i]!;
      const d = sub(open[(i + 1) % open.length]!, a);
      const l2 = dot(d, d);
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(joint.pt, a), d) / l2));
      const dist = length(sub(add(a, scale(d, t)), joint.pt));

      if (dist < bestDist) {
        best = i;
        bestDist = dist;
        bestT = t;
      }
    }

    if (best < 0) continue;

    const a = open[best]!;
    const b = open[(best + 1) % open.length]!;
    const pt = add(a, scale(sub(b, a), bestT));

    if (length(sub(pt, a)) < 1e-6) {
      placed.push({ vertex: a, tangent: joint.tangent });
    } else if (length(sub(pt, b)) < 1e-6) {
      placed.push({ vertex: b, tangent: joint.tangent });
    } else {
      open.splice(best + 1, 0, pt);
      placed.push({ vertex: pt, tangent: joint.tangent });
    }
  }

  const byIndex = new Map<number, Pt>();
  const n = open.length;

  // Indices shift as points go in, so resolve them once every insert is done.
  for (const { vertex, tangent } of placed) {
    const i = open.indexOf(vertex);
    const t = normalize(tangent);
    const before = dot(normalize(sub(vertex, open[(i - 1 + n) % n]!)), t);
    const after = dot(normalize(sub(open[(i + 1) % n]!, vertex)), t);

    // Only a point the outline runs straight through along the tangent is a joint.
    // One swallowed by another shape, or stranded on a sliver, would be forced
    // into a cusp.
    if (before * after <= 0 || Math.abs(before) < JOINT_ALIGN || Math.abs(after) < JOINT_ALIGN) continue;

    byIndex.set(i, t);
  }

  return byIndex;
}

/**
 * Refits a closed ring as cubic segments, within `tolerance` scene units.
 *
 * Corners are found first and the ring is cut there, so each run is fitted as a
 * smooth curve and the creases between runs stay sharp.
 *
 * `joints` are points that must become anchors whose two handles lie along the
 * given tangent, pointing in opposite directions — a smooth vertex, never a
 * corner, even where the polyline happens to turn sharply.
 */
export function fitRing(ring: Ring, tolerance: number, joints: ReadonlyArray<Joint> = []): Cubic[] {
  // The ring repeats its first point to close; the cyclic walk does not want it.
  const open =
    ring.length > 1 &&
    ring[0]![0] === ring[ring.length - 1]![0] &&
    ring[0]![1] === ring[ring.length - 1]![1]
      ? ring.slice(0, -1)
      : ring.slice();

  if (open.length < 3) return [];

  const smooth = placeJoints(open, joints);
  const n = open.length;
  const corners = [...new Set([...findCorners(open), ...smooth.keys()])].sort((x, y) => x - y);
  const out: Cubic[] = [];
  // A joint's tangent, flipped to point into the run it starts or ends.
  const tangentAt = (index: number, toward: Pt): Pt => {
    const shared = smooth.get(index);

    if (!shared) return normalize(toward);

    return dot(shared, toward) >= 0 ? shared : negate(shared);
  };

  if (corners.length === 0) {
    // A fully smooth loop: cut it anywhere and keep the seam tangent-continuous.
    const points = [...open, open[0]!];
    const seam = normalize(sub(open[1]!, open[n - 1]!));

    fitCubic(points, seam, negate(seam), tolerance, 0, out);

    return out;
  }

  for (let c = 0; c < corners.length; c++) {
    const start = corners[c]!;
    const end = corners[(c + 1) % corners.length]!;
    const run: Pt[] = [];
    let i = start;

    // Walk forward to the next corner, wrapping around the end of the ring.
    for (;;) {
      run.push(open[i]!);
      if (i === end && run.length > 1) break;
      i = (i + 1) % n;
      if (run.length > n) break;
    }

    if (run.length < 2) continue;

    const tan1 = tangentAt(start, sub(run[1]!, run[0]!));
    const tan2 = tangentAt(end, sub(run[run.length - 2]!, run[run.length - 1]!));

    fitCubic(run, tan1, tan2, tolerance, 0, out);
  }

  return out;
}
