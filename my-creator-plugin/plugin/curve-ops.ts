/**
 * Curve operations against the Creator scene graph.
 *
 * Every operand is flattened into scene-space polygons, clipped, and written
 * back as a fresh shape layer whose transform is compensated for.
 */

import type { Joint } from './blend';
import { blendChain } from './blend';
import type { Mat } from './geom';
import {
  FLATTEN_TOLERANCE,
  IDENTITY,
  cubicsToPathData,
  invert,
  multiply,
  orientPolygons,
  pathDataToRing,
  ringToPathData,
  signedArea2,
  simplifyRing,
} from './geom';
import { fitRing } from './fit';
import type { MultiPoly, Operation, Pt, Ring } from './martinez';
import { DIFFERENCE, INTERSECTION, UNION, XOR, boolop } from './martinez';

type CurveOp = 'union' | 'intersect' | 'subtract' | 'exclude';

const OP_CODES: Record<CurveOp, Operation> = {
  union: UNION,
  intersect: INTERSECTION,
  subtract: DIFFERENCE,
  exclude: XOR,
};

interface StyleSnapshot {
  fill?: PaintOptions;
  stroke?: StrokeOptions;
  color?: Color;
}

interface Operand {
  /** The selected node this operand came from. */
  node: Layer | Shape;
  /** Render order, front to back: lower compares first. */
  order: number[];
  /** Scene-space polygons, already nested into outers and holes. */
  polys: MultiPoly;
  style: StyleSnapshot;
}

export interface OpResult {
  ok: boolean;
  message: string;
}

/* ------------------------------------------------------------------ *
 * Scene graph traversal
 * ------------------------------------------------------------------ */

type AnyNode = { parent?: unknown; getMatrix?: (frame?: number) => Matrix };

function toMat(m: Matrix): Mat {
  return { a: m.a, b: m.b, c: m.c, d: m.d, e: m.e, f: m.f };
}

/** Accumulates the transforms from the scene root down to `node`. */
function worldMatrix(node: unknown): Mat {
  let m: Mat = IDENTITY;
  let cur = node as AnyNode | undefined;

  while (cur) {
    if (typeof cur.getMatrix === 'function') m = multiply(toMat(cur.getMatrix()), m);
    cur = cur.parent as AnyNode | undefined;
  }

  return m;
}

function isShapeContainer(node: Layer | Shape): node is ShapeLayer | Group {
  return node.type === 'SHAPE_LAYER' || node.type === 'GROUP';
}

function isLayer(node: Layer | Shape): node is Layer {
  return (
    node.type === 'SHAPE_LAYER' ||
    node.type === 'SCENE_LAYER' ||
    node.type === 'IMAGE_LAYER' ||
    node.type === 'TEXT_LAYER'
  );
}

/** Render order key for a node: layer index first, then nesting indices. */
function indexOfShape(parent: ShapeLayer | Group, shape: Shape): number {
  for (let i = 0; i < parent.shapes.length; i++) {
    if (parent.shapes[i]!.id === shape.id) return i;
  }

  return -1;
}

function indexOfLayer(layer: Layer): number {
  const layers = creator.activeScene.layers;

  for (let i = 0; i < layers.length; i++) {
    if (layers[i]!.id === layer.id) return i;
  }

  return -1;
}

function orderKey(node: Layer | Shape): number[] {
  const key: number[] = [];
  let cur: Layer | Shape | undefined = node;

  while (cur) {
    if (isLayer(cur)) {
      key.unshift(indexOfLayer(cur));
      break;
    }

    const parent: ShapeLayer | Group | undefined = (cur as Shape).parent;

    if (!parent) break;
    key.unshift(indexOfShape(parent, cur as Shape));
    cur = parent;
  }

  return key;
}

function compareOrder(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);

  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? -1 : a[i]!;
    const bv = b[i] === undefined ? -1 : b[i]!;

    if (av !== bv) return av - bv;
  }

  return 0;
}

/** Collects every flattened outline under `node`, in scene space. */
function collectRings(node: Layer | Shape, rings: Ring[]): void {
  if (node.type === 'GROUP' || node.type === 'SHAPE_LAYER') {
    for (const child of node.shapes) collectRings(child, rings);

    return;
  }

  if (
    node.type === 'PATH' ||
    node.type === 'RECTANGLE' ||
    node.type === 'ELLIPSE' ||
    node.type === 'POLYGON' ||
    node.type === 'STAR'
  ) {
    const ring = pathDataToRing(node.toPathData(), worldMatrix(node.parent));

    if (ring.length >= 4) rings.push(ring);
  }
}

/** True if `p` is inside the closed ring, by the even-odd crossing count. */
function pointInRing(p: Pt, ring: Ring): boolean {
  let inside = false;

  for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;

    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }

  return inside;
}

/**
 * Nests a flat list of rings into polygons: rings at an even containment depth
 * become outlines, odd ones become holes of the smallest ring enclosing them.
 */
function nestRings(rings: Ring[]): MultiPoly {
  const sorted = rings
    .map((ring, index) => ({ ring, index, area: Math.abs(signedArea2(ring)) }))
    .sort((a, b) => b.area - a.area);
  const polys: MultiPoly = [];
  const polyIndexOf: Record<number, number> = {};

  for (const entry of sorted) {
    const probe = entry.ring[0]!;
    let parent: (typeof sorted)[number] | undefined;

    // The last (smallest) larger ring that contains us is our immediate parent.
    for (const other of sorted) {
      if (other === entry) break;
      if (pointInRing(probe, other.ring)) parent = other;
    }

    let depth = 0;
    let walker = parent;

    while (walker) {
      depth++;
      let next: (typeof sorted)[number] | undefined;

      for (const other of sorted) {
        if (other === walker) break;
        if (pointInRing(walker.ring[0]!, other.ring)) next = other;
      }
      walker = next;
    }

    if (depth % 2 === 1 && parent && polyIndexOf[parent.index] !== undefined) {
      polys[polyIndexOf[parent.index]!]!.push(entry.ring);
    } else {
      polyIndexOf[entry.index] = polys.length;
      polys.push([entry.ring]);
    }
  }

  return polys;
}

function readStyle(node: Layer | Shape): StyleSnapshot {
  // Fills live on the containing shape layer or group, not on the shape itself.
  let container: ShapeLayer | Group | undefined;
  let cur: Layer | Shape | undefined = node;

  while (cur) {
    if (isShapeContainer(cur) && (cur.fills.length > 0 || cur.strokes.length > 0)) {
      container = cur;
      break;
    }
    cur = (isLayer(cur) ? undefined : cur.parent) as Layer | Shape | undefined;
  }

  const style: StyleSnapshot = {};

  if (!container) return style;

  const fill = container.fills[0];

  if (fill) {
    if (fill.type === 'SOLID') {
      style.color = fill.color.getValueAt();
      style.fill = { type: 'SOLID', color: style.color };
    } else {
      const stops = fill.stops.getValueAt().map((s) => ({ color: s.color, offset: s.offset, opacity: s.opacity }));

      style.fill =
        fill.type === 'GRADIENT_LINEAR'
          ? { type: 'GRADIENT_LINEAR', start: fill.start.getValueAt(), end: fill.end.getValueAt(), stops }
          : { type: 'GRADIENT_RADIAL', start: fill.start.getValueAt(), end: fill.end.getValueAt(), stops };
    }
  }

  const stroke = container.strokes[0];

  if (stroke && stroke.fill.type === 'SOLID') {
    style.stroke = {
      fill: { type: 'SOLID', color: stroke.fill.color.getValueAt() },
      width: stroke.width.getValueAt(),
    };
  }

  return style;
}

/** Turns the current selection into operands, ordered front to back. */
function collectOperands(): Operand[] {
  const operands: Operand[] = [];

  for (const node of creator.selection.nodes) {
    const rings: Ring[] = [];

    collectRings(node, rings);
    if (rings.length === 0) continue;

    operands.push({ node, order: orderKey(node), polys: nestRings(rings), style: readStyle(node) });
  }

  return operands.sort((a, b) => compareOrder(a.order, b.order));
}

/* ------------------------------------------------------------------ *
 * Writing results back
 * ------------------------------------------------------------------ */

function applyStyle(container: ShapeLayer | Group, style: StyleSnapshot): void {
  container.createFill(style.fill ?? { type: 'SOLID', color: { r: 153, g: 153, b: 153 } });
  if (style.stroke) container.createStroke(style.stroke);
}

/**
 * Creates a shape layer and returns it along with the matrix that maps scene
 * space into the new layer's local space.
 */
function createTargetLayer(name: string): { layer: ShapeLayer; toLocal: Mat } {
  const layer = creator.activeScene.createShapeLayer({ name, position: { x: 0, y: 0 } });

  return { layer, toLocal: invert(worldMatrix(layer)) };
}

function hostLayer(node: Layer | Shape): Layer | undefined {
  let cur: Layer | Shape | undefined = node;

  while (cur && !isLayer(cur)) cur = (cur as Shape).parent as Layer | Shape | undefined;

  return cur as Layer | undefined;
}

function removeSources(operands: Operand[]): void {
  const hosts: ShapeLayer[] = [];

  for (const operand of operands) {
    if (!isLayer(operand.node)) {
      const host = hostLayer(operand.node);

      if (host && host.type === 'SHAPE_LAYER' && !hosts.some((l) => l.id === host.id)) hosts.push(host);
    }

    operand.node.remove();
  }

  // Drop layers that the operation emptied out.
  for (const host of hosts) {
    if (host.shapes.length === 0) host.remove();
  }
}

/**
 * Writes the result rings into `layer`, refitted as cubics.
 *
 * Clipping runs on flattened polylines, so its output would otherwise carry
 * every flattening vertex. A tolerance of 0 skips fitting and keeps them.
 * `joints` become smooth anchors wherever they land on a ring.
 *
 * @returns the number of anchor points written.
 */
function emitPaths(layer: ShapeLayer, rings: Ring[], toLocal: Mat, tolerance: number, joints: Joint[]): number {
  let anchors = 0;

  for (const ring of rings) {
    const curves = tolerance > 0 ? fitRing(ring, tolerance, joints) : [];

    if (curves.length > 0) {
      layer.createPath(cubicsToPathData(curves, toLocal));
      anchors += curves.length;
    } else {
      const pathData = ringToPathData(ring, toLocal);

      layer.createPath(pathData);
      anchors += pathData.points.length;
    }
  }

  return anchors;
}

/* ------------------------------------------------------------------ *
 * Result geometry
 * ------------------------------------------------------------------ */

export type Mode = 'union' | 'subtract' | 'intersect' | 'exclude' | 'blend';

const MODE_LABELS: Record<Mode, string> = {
  union: 'Union',
  subtract: 'Subtract',
  intersect: 'Intersect',
  exclude: 'Exclude',
  blend: 'Blend',
};

interface Computed {
  rings: Ring[];
  style: StyleSnapshot;
  note: string;
  /** Points that must come out as smooth anchors. */
  joints: Joint[];
}

function finishRings(result: MultiPoly): Ring[] {
  return orientPolygons(result)
    .map((ring) => simplifyRing(ring, FLATTEN_TOLERANCE / 2))
    .filter((ring) => ring.length >= 4);
}

function computeBlend(operands: Operand[], radius: number): Computed | { error: string } {
  // Bridge along render order, so each shape links to its neighbour.
  const blend = blendChain(
    operands
      .slice()
      .reverse()
      .map((operand) => operand.polys),
    radius
  );
  const rings = finishRings(blend.polys);

  if (rings.length === 0) return { error: 'Blend produced an empty shape.' };

  const size = radius === 0 ? 'auto' : `r ${Math.abs(Math.round(radius))}px`;
  const shape = radius < 0 ? 'bulge' : 'waist';
  const note =
    blend.bridges === 0
      ? 'no gap to bridge, merged without arcs'
      : `${blend.bridges * 2} arcs, ${size}, ${shape}${blend.clamped ? ', widened to fit' : ''}`;

  return { rings, style: operands[0]!.style, note, joints: blend.joints };
}

function computeBoolean(operands: Operand[], mode: Exclude<Mode, 'blend'>): Computed | { error: string } {
  let result: MultiPoly;

  if (mode === 'subtract') {
    // Illustrator's "minus front": the back-most shape keeps, everything above is removed.
    const base = operands[operands.length - 1]!;
    let cutter: MultiPoly = operands[0]!.polys;

    for (let i = 1; i < operands.length - 1; i++) cutter = boolop(cutter, operands[i]!.polys, UNION);
    result = boolop(base.polys, cutter, DIFFERENCE);
  } else {
    result = operands[0]!.polys;
    for (let i = 1; i < operands.length; i++) result = boolop(result, operands[i]!.polys, OP_CODES[mode]);
  }

  const rings = finishRings(result);

  if (rings.length === 0) return { error: `${MODE_LABELS[mode]} produces an empty shape.` };

  // Subtract keeps the base shape's look; the others take the front-most.
  const style = mode === 'subtract' ? operands[operands.length - 1]!.style : operands[0]!.style;

  return { rings, style, note: `${rings.length} contour${rings.length === 1 ? '' : 's'}`, joints: [] };
}

function compute(operands: Operand[], mode: Mode, radius: number): Computed | { error: string } {
  return mode === 'blend' ? computeBlend(operands, radius) : computeBoolean(operands, mode);
}

/* ------------------------------------------------------------------ *
 * Preview session
 *
 * The preview is the real result, drawn early. Applying promotes it in place
 * rather than recomputing, so what the user approves is exactly what they saw.
 * ------------------------------------------------------------------ */

const PREVIEW_TAG = 'curve-ops-preview';
const HIDDEN_TAG = 'curve-ops-hidden';

interface Session {
  layer: ShapeLayer;
  operands: Operand[];
  hidden: Layer[];
  mode: Mode;
}

let session: Session | null = null;

export interface PreviewResult {
  active: boolean;
  ok: boolean;
  message: string;
}

/**
 * Removes previews stranded by a session that closed without applying.
 *
 * The API exposes no plugin-close hook, so a preview can outlive its session.
 * Tagging both the preview and everything it hid makes the leftovers findable.
 */
export function sweepOrphans(): void {
  for (const layer of creator.activeScene.layers.slice()) {
    if (layer.data.get(HIDDEN_TAG)) {
      layer.visible = true;
      layer.data.delete(HIDDEN_TAG);
    }
  }

  for (const layer of creator.activeScene.layers.slice()) {
    if (layer.data.get(PREVIEW_TAG)) layer.remove();
  }
}

function leafShapes(container: ShapeLayer | Group, out: Shape[]): void {
  for (const shape of container.shapes) {
    if (shape.type === 'GROUP') leafShapes(shape, out);
    else out.push(shape);
  }
}

function coveredBy(shape: Shape, ids: string[]): boolean {
  let cur: Layer | Shape | undefined = shape;

  while (cur) {
    if (ids.indexOf(cur.id) !== -1) return true;
    cur = isLayer(cur) ? undefined : ((cur as Shape).parent as Layer | Shape | undefined);
  }

  return false;
}

/**
 * Host layers the preview may hide: only those whose entire contents take part,
 * since a layer holding unrelated shapes would take them down with it.
 */
function hideableHosts(operands: Operand[]): Layer[] {
  const ids = operands.map((operand) => operand.node.id);
  const hosts: Layer[] = [];

  for (const operand of operands) {
    const host = hostLayer(operand.node);

    if (!host || hosts.some((l) => l.id === host.id)) continue;

    if (host.type === 'SHAPE_LAYER') {
      const leaves: Shape[] = [];

      leafShapes(host, leaves);
      if (!leaves.every((shape) => coveredBy(shape, ids))) continue;
    }

    hosts.push(host);
  }

  return hosts;
}

function teardown(): void {
  if (!session) return;

  for (const host of session.hidden) {
    try {
      host.visible = true;
      host.data.delete(HIDDEN_TAG);
    } catch {
      // The layer was removed from under us; nothing left to restore.
    }
  }

  try {
    session.layer.remove();
  } catch {
    // Already gone.
  }

  session = null;
}

/** True when a preview is currently on the canvas. */
export function hasPreview(): boolean {
  return session !== null;
}

/**
 * Rebuilds the preview for the given settings. A null mode just clears whatever
 * is showing.
 */
export function refreshPreview(
  mode: Mode | null,
  radius: number,
  tolerance: number,
  keepOriginals: boolean
): PreviewResult {
  teardown();

  if (!mode) return { active: false, ok: true, message: '' };

  const operands = collectOperands();

  if (operands.length < 2) {
    return { active: false, ok: false, message: 'Select at least two paths.' };
  }

  const computed = compute(operands, mode, radius);

  if ('error' in computed) return { active: false, ok: false, message: computed.error };

  const { layer, toLocal } = createTargetLayer(`${MODE_LABELS[mode]} preview`);

  layer.data.set(PREVIEW_TAG, '1');
  // Locking keeps the preview from being clicked into the selection it feeds on.
  layer.locked = true;

  const source = computed.rings.reduce((n, ring) => n + ring.length - 1, 0);
  const anchors = emitPaths(layer, computed.rings, toLocal, tolerance, computed.joints);

  applyStyle(layer, computed.style);

  const hidden: Layer[] = [];

  if (!keepOriginals) {
    for (const host of hideableHosts(operands)) {
      // A layer the user already hid should stay hidden once the preview goes.
      if (!host.visible) continue;
      host.visible = false;
      host.data.set(HIDDEN_TAG, '1');
      hidden.push(host);
    }
  }

  session = { layer, operands, hidden, mode };

  const saved = source > 0 ? ` (from ${source})` : '';

  return {
    active: true,
    ok: true,
    message: `${MODE_LABELS[mode]} preview — ${computed.note}, ${anchors} points${saved}.`,
  };
}

/** Promotes the live preview into a real layer. */
export function applyPreview(keepOriginals: boolean): OpResult {
  if (!session) return { ok: false, message: 'Nothing to apply.' };

  const { layer, operands, hidden, mode } = session;

  session = null;

  layer.data.delete(PREVIEW_TAG);
  layer.locked = false;
  layer.name = MODE_LABELS[mode];

  // Restore first, so anything that survives removal is left visible.
  for (const host of hidden) {
    host.visible = true;
    host.data.delete(HIDDEN_TAG);
  }

  if (!keepOriginals) removeSources(operands);

  creator.selection.nodes = [layer];

  const kept = keepOriginals ? ', originals kept' : '';

  return { ok: true, message: `${MODE_LABELS[mode]} applied to ${operands.length} paths${kept}.` };
}

/** Drops the preview and restores the scene. */
export function cancelPreview(): OpResult {
  const had = session !== null;

  teardown();

  return { ok: true, message: had ? 'Preview discarded.' : '' };
}

/* ------------------------------------------------------------------ *
 * Selection reporting
 * ------------------------------------------------------------------ */

function hasGeometry(node: Layer | Shape): boolean {
  if (node.type === 'GROUP' || node.type === 'SHAPE_LAYER') {
    for (const child of node.shapes) if (hasGeometry(child)) return true;

    return false;
  }

  return (
    node.type === 'PATH' ||
    node.type === 'RECTANGLE' ||
    node.type === 'ELLIPSE' ||
    node.type === 'POLYGON' ||
    node.type === 'STAR'
  );
}

export function describeSelection(): { count: number; names: string[] } {
  const names: string[] = [];

  for (const node of creator.selection.nodes) {
    if (node.data.get(PREVIEW_TAG)) continue;
    if (hasGeometry(node)) names.push(node.name);
  }

  return { count: names.length, names };
}
