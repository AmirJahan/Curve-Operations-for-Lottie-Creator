/**
 * Polygon boolean operations — Martinez-Rueda-Feito sweep line clipping.
 *
 * Self-contained (the plugin sandbox cannot import external packages at runtime),
 * operating on flat polygons. Bezier input is flattened before it gets here; see
 * `geom.ts`.
 */

export type Pt = [number, number];
/** A closed ring. The first point is repeated as the last. */
export type Ring = Pt[];
/** `[outerRing, ...holeRings]` */
export type Poly = Ring[];
export type MultiPoly = Poly[];

export const INTERSECTION = 0;
export const UNION = 1;
export const DIFFERENCE = 2;
export const XOR = 3;
export type Operation = 0 | 1 | 2 | 3;

const NORMAL = 0;
const NON_CONTRIBUTING = 1;
const SAME_TRANSITION = 2;
const DIFFERENT_TRANSITION = 3;

type BBox = [number, number, number, number];

class SweepEvent {
  public left: boolean;
  public point: Pt;
  public otherEvent: SweepEvent;
  public isSubject: boolean;
  public type: number;
  public inOut = false;
  public otherInOut = false;
  public prevInResult: SweepEvent | null = null;
  public resultTransition = 0;
  public otherPos = -1;
  public outputContourId = -1;
  public isExteriorRing = true;
  public contourId = 0;

  public constructor(point: Pt, left: boolean, otherEvent: SweepEvent, isSubject: boolean, type?: number) {
    this.point = point;
    this.left = left;
    this.otherEvent = otherEvent;
    this.isSubject = isSubject;
    this.type = type === undefined ? NORMAL : type;
  }

  /** Is the segment (this, otherEvent) below point p? */
  public isBelow(p: Pt): boolean {
    const p0 = this.point;
    const p1 = this.otherEvent.point;

    return this.left
      ? (p0[0] - p[0]) * (p1[1] - p[1]) - (p1[0] - p[0]) * (p0[1] - p[1]) > 0
      : (p1[0] - p[0]) * (p0[1] - p[1]) - (p0[0] - p[0]) * (p1[1] - p[1]) > 0;
  }

  public isAbove(p: Pt): boolean {
    return !this.isBelow(p);
  }

  public isVertical(): boolean {
    return this.point[0] === this.otherEvent.point[0];
  }

  public get inResult(): boolean {
    return this.resultTransition !== 0;
  }
}

function equals(a: Pt, b: Pt): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function signedArea(p0: Pt, p1: Pt, p2: Pt): number {
  return (p0[0] - p2[0]) * (p1[1] - p2[1]) - (p1[0] - p2[0]) * (p0[1] - p2[1]);
}

function compareEvents(e1: SweepEvent, e2: SweepEvent): number {
  const p1 = e1.point;
  const p2 = e2.point;

  if (p1[0] > p2[0]) return 1;
  if (p1[0] < p2[0]) return -1;
  if (p1[1] !== p2[1]) return p1[1] > p2[1] ? 1 : -1;

  // Same point. A right event is processed before a left one.
  if (e1.left !== e2.left) return e1.left ? 1 : -1;
  // Same point, same side: order by slope.
  if (signedArea(e1.point, e1.otherEvent.point, e2.otherEvent.point) !== 0) {
    return e1.isAbove(e2.otherEvent.point) ? 1 : -1;
  }

  return !e1.isSubject && e2.isSubject ? 1 : -1;
}

/** Ordering of segments along the sweep line status. Both events must be left events. */
function compareSegments(le1: SweepEvent, le2: SweepEvent): number {
  if (le1 === le2) return 0;

  if (
    signedArea(le1.point, le1.otherEvent.point, le2.point) !== 0 ||
    signedArea(le1.point, le1.otherEvent.point, le2.otherEvent.point) !== 0
  ) {
    // Segments are not collinear.
    if (equals(le1.point, le2.point)) return le1.isBelow(le2.otherEvent.point) ? -1 : 1;
    if (le1.point[0] === le2.point[0]) return le1.point[1] < le2.point[1] ? -1 : 1;
    // Was le1 inserted into the status after le2?
    if (compareEvents(le1, le2) === 1) return le2.isAbove(le1.point) ? -1 : 1;

    return le1.isBelow(le2.point) ? -1 : 1;
  }

  // Collinear segments.
  if (le1.isSubject === le2.isSubject) {
    let p1 = le1.point;
    let p2 = le2.point;

    if (p1[0] === p2[0] && p1[1] === p2[1]) {
      p1 = le1.otherEvent.point;
      p2 = le2.otherEvent.point;
      if (p1[0] === p2[0] && p1[1] === p2[1]) return 0;

      return le1.contourId > le2.contourId ? 1 : -1;
    }
  } else {
    return le1.isSubject ? -1 : 1;
  }

  return compareEvents(le1, le2) === 1 ? 1 : -1;
}

/** Binary heap keyed by `compareEvents`. */
class EventQueue {
  private readonly data: SweepEvent[] = [];

  public get length(): number {
    return this.data.length;
  }

  public push(item: SweepEvent): void {
    this.data.push(item);
    let pos = this.data.length - 1;

    while (pos > 0) {
      const parent = (pos - 1) >> 1;

      if (compareEvents(this.data[pos]!, this.data[parent]!) >= 0) break;
      const tmp = this.data[pos]!;

      this.data[pos] = this.data[parent]!;
      this.data[parent] = tmp;
      pos = parent;
    }
  }

  public pop(): SweepEvent | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;

    if (this.data.length === 0) return top;
    this.data[0] = last;

    let pos = 0;
    const len = this.data.length;

    for (;;) {
      const left = 2 * pos + 1;
      const right = left + 1;
      let best = pos;

      if (left < len && compareEvents(this.data[left]!, this.data[best]!) < 0) best = left;
      if (right < len && compareEvents(this.data[right]!, this.data[best]!) < 0) best = right;
      if (best === pos) break;
      const tmp = this.data[pos]!;

      this.data[pos] = this.data[best]!;
      this.data[best] = tmp;
      pos = best;
    }

    return top;
  }
}

function inResult(event: SweepEvent, operation: Operation): boolean {
  switch (event.type) {
    case NORMAL:
      switch (operation) {
        case INTERSECTION:
          return !event.otherInOut;
        case UNION:
          return event.otherInOut;
        case DIFFERENCE:
          return (event.isSubject && event.otherInOut) || (!event.isSubject && !event.otherInOut);
        case XOR:
          return true;
        default:
          return false;
      }
    case SAME_TRANSITION:
      return operation === INTERSECTION || operation === UNION;
    case DIFFERENT_TRANSITION:
      return operation === DIFFERENCE;
    case NON_CONTRIBUTING:
      return false;
    default:
      return false;
  }
}

function determineResultTransition(event: SweepEvent, operation: Operation): number {
  const thisIn = !event.inOut;
  const thatIn = !event.otherInOut;
  let isIn: boolean;

  switch (operation) {
    case INTERSECTION:
      isIn = thisIn && thatIn;
      break;
    case UNION:
      isIn = thisIn || thatIn;
      break;
    case XOR:
      isIn = thisIn !== thatIn;
      break;
    case DIFFERENCE:
      isIn = event.isSubject ? thisIn && !thatIn : thatIn && !thisIn;
      break;
    default:
      isIn = false;
  }

  return isIn ? 1 : -1;
}

function computeFields(event: SweepEvent, prev: SweepEvent | null, operation: Operation): void {
  if (prev === null) {
    event.inOut = false;
    event.otherInOut = true;
  } else {
    if (event.isSubject === prev.isSubject) {
      event.inOut = !prev.inOut;
      event.otherInOut = prev.otherInOut;
    } else {
      event.inOut = !prev.otherInOut;
      event.otherInOut = prev.isVertical() ? !prev.inOut : prev.inOut;
    }
    event.prevInResult = !inResult(prev, operation) || prev.isVertical() ? prev.prevInResult : prev;
  }

  event.resultTransition = inResult(event, operation) ? determineResultTransition(event, operation) : 0;
}

function divideSegment(se: SweepEvent, p: Pt, queue: EventQueue): void {
  const r = new SweepEvent(p, false, se, se.isSubject);
  const l = new SweepEvent(p, true, se.otherEvent, se.isSubject);

  r.contourId = se.contourId;
  l.contourId = se.contourId;

  // Rounding can put the split point past the segment's right endpoint; swap sides if so.
  if (compareEvents(l, se.otherEvent) > 0) {
    se.otherEvent.left = true;
    l.left = false;
  }

  se.otherEvent.otherEvent = l;
  se.otherEvent = r;

  queue.push(l);
  queue.push(r);
}

function crossProduct(a: Pt, b: Pt): number {
  return a[0] * b[1] - a[1] * b[0];
}

function dotProduct(a: Pt, b: Pt): number {
  return a[0] * b[0] + a[1] * b[1];
}

function toPoint(p: Pt, s: number, d: Pt): Pt {
  return [p[0] + s * d[0], p[1] + s * d[1]];
}

/** Intersection of segments a1a2 and b1b2: null, one point, or an overlapping range. */
function segmentIntersection(a1: Pt, a2: Pt, b1: Pt, b2: Pt): Pt[] | null {
  const va: Pt = [a2[0] - a1[0], a2[1] - a1[1]];
  const vb: Pt = [b2[0] - b1[0], b2[1] - b1[1]];
  const e: Pt = [b1[0] - a1[0], b1[1] - a1[1]];

  let kross = crossProduct(va, vb);
  let sqrKross = kross * kross;
  const sqrLenA = dotProduct(va, va);

  if (sqrKross > 0) {
    const s = crossProduct(e, vb) / kross;

    if (s < 0 || s > 1) return null;
    const t = crossProduct(e, va) / kross;

    if (t < 0 || t > 1) return null;
    if (s === 0 || s === 1) return [toPoint(a1, s, va)];
    if (t === 0 || t === 1) return [toPoint(b1, t, vb)];

    return [toPoint(a1, s, va)];
  }

  // Parallel segments.
  kross = crossProduct(e, va);
  sqrKross = kross * kross;
  if (sqrKross > 0) return null;

  // Collinear segments — find the overlapping range.
  const sa = dotProduct(va, e) / sqrLenA;
  const sb = sa + dotProduct(va, vb) / sqrLenA;
  const smin = Math.min(sa, sb);
  const smax = Math.max(sa, sb);

  if (smin <= 1 && smax >= 0) {
    if (smin === 1) return [toPoint(a1, smin, va)];
    if (smax === 0) return [toPoint(a1, smax, va)];

    return [toPoint(a1, Math.max(smin, 0), va), toPoint(a1, Math.min(smax, 1), va)];
  }

  return null;
}

function possibleIntersection(se1: SweepEvent, se2: SweepEvent, queue: EventQueue): number {
  const inter = segmentIntersection(se1.point, se1.otherEvent.point, se2.point, se2.otherEvent.point);
  const nIntersections = inter ? inter.length : 0;

  if (nIntersections === 0) return 0;
  // They intersect only at a shared endpoint — nothing to divide.
  if (nIntersections === 1 && (equals(se1.point, se2.point) || equals(se1.otherEvent.point, se2.otherEvent.point))) {
    return 0;
  }
  // Self-overlapping edges within the same polygon set are not handled; leave them be.
  if (nIntersections === 2 && se1.isSubject === se2.isSubject) return 0;

  if (nIntersections === 1) {
    const p = inter![0]!;

    if (!equals(se1.point, p) && !equals(se1.otherEvent.point, p)) divideSegment(se1, p, queue);
    if (!equals(se2.point, p) && !equals(se2.otherEvent.point, p)) divideSegment(se2, p, queue);

    return 1;
  }

  // Overlapping segments.
  const events: SweepEvent[] = [];
  let leftCoincide = false;
  let rightCoincide = false;

  if (equals(se1.point, se2.point)) leftCoincide = true;
  else if (compareEvents(se1, se2) === 1) events.push(se2, se1);
  else events.push(se1, se2);

  if (equals(se1.otherEvent.point, se2.otherEvent.point)) rightCoincide = true;
  else if (compareEvents(se1.otherEvent, se2.otherEvent) === 1) events.push(se2.otherEvent, se1.otherEvent);
  else events.push(se1.otherEvent, se2.otherEvent);

  if ((leftCoincide && rightCoincide) || leftCoincide) {
    // The segments are equal or share the left endpoint.
    se2.type = NON_CONTRIBUTING;
    se1.type = se2.inOut === se1.inOut ? SAME_TRANSITION : DIFFERENT_TRANSITION;

    if (leftCoincide && !rightCoincide) divideSegment(events[1]!.otherEvent, events[0]!.point, queue);

    return 2;
  }

  if (rightCoincide) {
    // They share the right endpoint.
    divideSegment(events[0]!, events[1]!.point, queue);

    return 3;
  }

  if (events[0] !== events[3]!.otherEvent) {
    // Partial overlap, no shared endpoints.
    divideSegment(events[0]!, events[1]!.point, queue);
    divideSegment(events[1]!, events[2]!.point, queue);

    return 3;
  }

  // One segment fully contains the other.
  divideSegment(events[0]!, events[1]!.point, queue);
  divideSegment(events[3]!.otherEvent, events[2]!.point, queue);

  return 3;
}

/**
 * Sweep line status, kept as an array ordered by `compareSegments`.
 * A balanced tree would be asymptotically better; for plugin-scale geometry
 * (a few thousand active edges) the splice cost is not the bottleneck.
 */
function insertSorted(status: SweepEvent[], e: SweepEvent): number {
  let lo = 0;
  let hi = status.length;

  while (lo < hi) {
    const mid = (lo + hi) >> 1;

    if (compareSegments(status[mid]!, e) < 0) lo = mid + 1;
    else hi = mid;
  }
  status.splice(lo, 0, e);

  return lo;
}

function processPolygon(
  ring: Ring,
  isSubject: boolean,
  contourId: number,
  queue: EventQueue,
  bbox: BBox,
  isExteriorRing: boolean
): void {
  for (let i = 0; i < ring.length - 1; i++) {
    const s1 = ring[i]!;
    const s2 = ring[i + 1]!;

    if (s1[0] === s2[0] && s1[1] === s2[1]) continue; // Skip collapsed edges.

    const e1 = new SweepEvent(s1, false, undefined as unknown as SweepEvent, isSubject);
    const e2 = new SweepEvent(s2, false, e1, isSubject);

    e1.otherEvent = e2;
    e1.contourId = contourId;
    e2.contourId = contourId;

    if (!isExteriorRing) {
      e1.isExteriorRing = false;
      e2.isExteriorRing = false;
    }

    if (compareEvents(e1, e2) > 0) e2.left = true;
    else e1.left = true;

    bbox[0] = Math.min(bbox[0], s1[0]);
    bbox[1] = Math.min(bbox[1], s1[1]);
    bbox[2] = Math.max(bbox[2], s1[0]);
    bbox[3] = Math.max(bbox[3], s1[1]);

    queue.push(e1);
    queue.push(e2);
  }
}

function fillQueue(subject: MultiPoly, clipping: MultiPoly, sbbox: BBox, cbbox: BBox): EventQueue {
  const queue = new EventQueue();
  let contourId = 0;

  for (const polygon of subject) {
    for (let j = 0; j < polygon.length; j++) {
      const isExteriorRing = j === 0;

      if (isExteriorRing) contourId++;
      processPolygon(polygon[j]!, true, contourId, queue, sbbox, isExteriorRing);
    }
  }

  for (const polygon of clipping) {
    for (let j = 0; j < polygon.length; j++) {
      const isExteriorRing = j === 0;

      if (isExteriorRing) contourId++;
      processPolygon(polygon[j]!, false, contourId, queue, cbbox, isExteriorRing);
    }
  }

  return queue;
}

function subdivideSegments(
  queue: EventQueue,
  sbbox: BBox,
  cbbox: BBox,
  operation: Operation
): SweepEvent[] {
  const status: SweepEvent[] = [];
  const sortedEvents: SweepEvent[] = [];
  const rightbound = Math.min(sbbox[2], cbbox[2]);
  // Degenerate input can make the sweep keep splitting segments forever. Give up
  // loudly rather than exhaust memory and take the host application down with us.
  const limit = Math.max(200000, queue.length * 64);

  while (queue.length !== 0) {
    if (sortedEvents.length > limit) throw new Error('Polygon clipping did not converge.');

    let event = queue.pop()!;

    sortedEvents.push(event);

    // Everything past this point cannot contribute to the result.
    if (
      (operation === INTERSECTION && event.point[0] > rightbound) ||
      (operation === DIFFERENCE && event.point[0] > sbbox[2])
    ) {
      break;
    }

    if (event.left) {
      const pos = insertSorted(status, event);
      const prevEvent = pos > 0 ? status[pos - 1]! : null;
      const nextEvent = pos + 1 < status.length ? status[pos + 1]! : null;

      computeFields(event, prevEvent, operation);

      if (nextEvent && possibleIntersection(event, nextEvent, queue) === 2) {
        computeFields(event, prevEvent, operation);
        computeFields(nextEvent, event, operation);
      }

      if (prevEvent && possibleIntersection(prevEvent, event, queue) === 2) {
        const pp = status.indexOf(prevEvent);
        const prevPrevEvent = pp > 0 ? status[pp - 1]! : null;

        computeFields(prevEvent, prevPrevEvent, operation);
        computeFields(event, prevEvent, operation);
      }
    } else {
      event = event.otherEvent;
      const idx = status.indexOf(event);

      if (idx !== -1) {
        const prevEvent = idx > 0 ? status[idx - 1]! : null;
        const nextEvent = idx + 1 < status.length ? status[idx + 1]! : null;

        status.splice(idx, 1);
        if (prevEvent && nextEvent) possibleIntersection(prevEvent, nextEvent, queue);
      }
    }
  }

  return sortedEvents;
}

function orderEvents(sortedEvents: SweepEvent[]): SweepEvent[] {
  const resultEvents: SweepEvent[] = [];

  for (const event of sortedEvents) {
    if ((event.left && event.inResult) || (!event.left && event.otherEvent.inResult)) {
      resultEvents.push(event);
    }
  }

  // Overlapping edges can leave the array slightly out of order.
  let sorted = false;

  while (!sorted) {
    sorted = true;
    for (let i = 0; i + 1 < resultEvents.length; i++) {
      if (compareEvents(resultEvents[i]!, resultEvents[i + 1]!) === 1) {
        const tmp = resultEvents[i]!;

        resultEvents[i] = resultEvents[i + 1]!;
        resultEvents[i + 1] = tmp;
        sorted = false;
      }
    }
  }

  for (let i = 0; i < resultEvents.length; i++) resultEvents[i]!.otherPos = i;

  for (const event of resultEvents) {
    if (!event.left) {
      const tmp = event.otherPos;

      event.otherPos = event.otherEvent.otherPos;
      event.otherEvent.otherPos = tmp;
    }
  }

  return resultEvents;
}

function nextPos(pos: number, resultEvents: SweepEvent[], processed: boolean[], origPos: number): number {
  let newPos = pos + 1;
  const length = resultEvents.length;
  const p = resultEvents[pos]!.point;

  while (newPos < length && equals(resultEvents[newPos]!.point, p)) {
    if (!processed[newPos]) return newPos;
    newPos++;
  }

  newPos = pos - 1;
  while (newPos > origPos && processed[newPos]) newPos--;

  return newPos;
}

interface Contour {
  points: Pt[];
  holeIds: number[];
  holeOf: number | null;
  depth: number;
}

function initContour(event: SweepEvent, contours: Contour[], contourId: number): Contour {
  const contour: Contour = { points: [], holeIds: [], holeOf: null, depth: 0 };
  const prevInResult = event.prevInResult;

  if (prevInResult == null) return contour;

  const lowerContourId = prevInResult.outputContourId;
  const lowerContour = contours[lowerContourId];

  if (!lowerContour) return contour;

  if (prevInResult.resultTransition > 0) {
    // We are inside the contour below us.
    if (lowerContour.holeOf != null) {
      // Below is a hole, so we are a sibling island inside the same parent.
      const parentContourId = lowerContour.holeOf;

      contours[parentContourId]!.holeIds.push(contourId);
      contour.holeOf = parentContourId;
      contour.depth = lowerContour.depth;
    } else {
      // Below is an exterior ring, so we are a hole in it.
      lowerContour.holeIds.push(contourId);
      contour.holeOf = lowerContourId;
      contour.depth = lowerContour.depth + 1;
    }
  } else {
    // We are outside — an exterior contour at the same depth.
    contour.depth = lowerContour.depth;
  }

  return contour;
}

function connectEdges(sortedEvents: SweepEvent[]): Contour[] {
  const resultEvents = orderEvents(sortedEvents);
  const processed: boolean[] = new Array(resultEvents.length).fill(false);
  const contours: Contour[] = [];

  for (let i = 0; i < resultEvents.length; i++) {
    if (processed[i]) continue;

    const contourId = contours.length;
    const contour = initContour(resultEvents[i]!, contours, contourId);
    const origPos = i;
    let pos = i;

    contour.points.push(resultEvents[i]!.point);

    for (;;) {
      processed[pos] = true;
      resultEvents[pos]!.outputContourId = contourId;

      pos = resultEvents[pos]!.otherPos;
      if (pos < 0 || pos >= resultEvents.length) break;

      processed[pos] = true;
      resultEvents[pos]!.outputContourId = contourId;
      contour.points.push(resultEvents[pos]!.point);

      pos = nextPos(pos, resultEvents, processed, origPos);
      if (pos === origPos || pos < 0 || pos >= resultEvents.length) break;
    }

    contours.push(contour);
  }

  return contours;
}

function bboxesDisjoint(a: BBox, b: BBox): boolean {
  return a[0] > b[2] || b[0] > a[2] || a[1] > b[3] || b[1] > a[3];
}

/**
 * Runs a boolean operation between two sets of polygons.
 *
 * Rings must be closed (first point repeated as the last). The result is a
 * multipolygon; each polygon is `[outerRing, ...holeRings]`.
 */
export function boolop(subject: MultiPoly, clipping: MultiPoly, operation: Operation): MultiPoly {
  if (subject.length === 0 || clipping.length === 0) {
    if (operation === INTERSECTION) return [];
    if (operation === DIFFERENCE) return subject;

    return subject.length === 0 ? clipping : subject;
  }

  const sbbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const cbbox: BBox = [Infinity, Infinity, -Infinity, -Infinity];
  const queue = fillQueue(subject, clipping, sbbox, cbbox);

  if (bboxesDisjoint(sbbox, cbbox)) {
    if (operation === INTERSECTION) return [];
    if (operation === DIFFERENCE) return subject;

    return subject.concat(clipping);
  }

  const contours = connectEdges(subdivideSegments(queue, sbbox, cbbox, operation));
  const result: MultiPoly = [];

  for (const contour of contours) {
    if (contour.holeOf != null) continue; // Holes are emitted with their parent.
    if (contour.points.length < 3) continue;

    const rings: Poly = [closeRing(contour.points)];

    for (const holeId of contour.holeIds) {
      const hole = contours[holeId];

      if (hole && hole.points.length >= 3) rings.push(closeRing(hole.points));
    }

    result.push(rings);
  }

  return result;
}

function closeRing(points: Pt[]): Ring {
  const ring = points.slice();
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;

  if (!equals(first, last)) ring.push([first[0], first[1]]);

  return ring;
}
