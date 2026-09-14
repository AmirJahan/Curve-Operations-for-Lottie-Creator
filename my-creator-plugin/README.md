# Curve Ops

A LottieFiles Creator plugin for path boolean operations and shape blending.

Select two or more paths on the canvas, pick a mode, and the result appears on
the canvas as a live preview. Adjust settings to see it update, then **Apply**
to commit it or **Cancel** to discard it.

Five modes:

| Button | What it does |
| --- | --- |
| **Union** | Merges every selected path into one silhouette. |
| **Subtract** | Removes the front paths from the back-most one (Illustrator's "minus front"). |
| **Intersect** | Keeps only the area shared by all selected paths. |
| **Exclude** | Keeps everything except the overlap. |
| **Blend** | Fuses the selected paths into one shape, joined by two arcs across each gap that meet the outlines smoothly. |

Every mode produces a single new shape layer, styled after the front-most path
(Subtract keeps the back path's style). The originals are deleted on Apply
unless **Keep originals** is checked.

## Vertex count

Clipping runs on flattened polylines, so the raw result carries one vertex per
flattening step — a circle comes out of a union with ~76. Before writing the
result back, `plugin/fit.ts` refits it with cubic beziers: corners are detected
first and the outline is cut there, so creases stay sharp, and each smooth run
between corners is fitted least-squares with Newton-Raphson reparameterisation
(Schneider, *Graphics Gems* 1990).

| Shape | Raw | Fitted |
| --- | --- | --- |
| Circle | 76 | 6 |
| Union of two circles | 108 | 12 |
| Union of two rectangles | 8 | 8 (unchanged, corners exact) |
| Rounded rectangle | 100 | 10 |
| Star unioned with a circle | 62 | 15 |

The **Tolerance** control is the largest deviation the fit may introduce, in
scene units. The default of `0.25px` is visually indistinguishable; raise it for
fewer points, or set it to `0` to keep every vertex. The status line reports the
resulting point count alongside the raw one.

## Preview

The preview is the real result, drawn early — Apply promotes that same layer
rather than recomputing, so what you approve is exactly what you saw. While a
preview is up the source layers are hidden (unless Keep originals is on), and
the preview layer is locked so canvas clicks cannot pull it into the selection
it is built from.

The preview rebuilds whenever the mode, arc radius, checkbox, or canvas
selection changes.

**One caveat:** the plugin API exposes no close hook, so closing the plugin
window with a preview open can strand a `… preview` layer in the document with
its sources still hidden. The plugin tags both, tries to clean up as the window
unloads, and sweeps up any leftovers the next time it opens.

## Blend

Blend bridges the shapes rather than interpolating between them. The convex hull
of two outlines crosses from one shape to the other exactly twice, marking the
two sides of the gap. On each side the bridge edge is a fillet: an arc of a
circle that touches both shapes. A circle touching an outline shares its tangent
there, so each arc leaves one shape and joins the other with no crease.

Each contact point comes out as an anchor whose two handles lie on one line,
pointing in opposite directions (180° apart), and the fitter is never allowed
to treat it as a corner. If a contact lands on a sharp corner, which has no
single tangent to share, that corner is rounded off locally, reaching at most a
quarter of the arc radius along the outline, and the fillet is solved again. So
the originals may get slightly softer right where the bridge attaches, and
nowhere else.

The **arc radius** control sets the radius of those arcs in scene units:

- `0` — auto, sized to each span for a gentle waist.
- Large values flatten the arcs toward a straight-sided hull bridge.
- Small values deepen the waist. The radius grows as needed so the arcs can
  reach both shapes and the waist stays open.
- Negative values bow the arcs outward into a bulge instead of a waist. A bulge
  never sweeps past a half circle; the radius grows as needed to stay within
  that, so it bridges the gap rather than wrapping the shapes.

Overlapping shapes work too: each fillet then fills the notch where the two
outlines cross.

The geometry lives in `plugin/blend.ts`.

With three or more paths, each is bridged to its neighbour in render order and
the whole chain merges into one object. When both bridges on a small middle
shape reach for the same stretch of its outline, the later one is solved again
against the already-merged outline, so the two meet smoothly as well.

The merged outline is stitched together directly: one shape's far side, an
arc, the other shape's far side, then the second arc. It is not left to the
polygon clipper, because an arc only grazes the outline where it touches, and
intersections computed at a grazing contact leave slivers behind.

## How it works

The Creator API has no native boolean operations, so the geometry is computed
in the plugin sandbox:

- `plugin/geom.ts` — bezier flattening, affine transforms, ring simplification,
  convex hulls, and circular arc construction.
- `plugin/fit.ts` — corner detection and least-squares cubic bezier fitting, so
  results come back as curves rather than dense polylines.
- `plugin/martinez.ts` — a self-contained Martinez-Rueda-Feito sweep line
  polygon clipper covering union, intersection, difference, and XOR, including
  holes.
- `plugin/curve-ops.ts` — walks the selection, bakes each operand into
  scene-space polygons, runs the clip, and writes the result back as a new
  shape layer.

Each selected node is one operand. Selecting a shape layer or group treats
everything inside it as a single compound shape. Curves are flattened to
polylines within 0.05 scene units before clipping, then refitted as beziers
afterwards.

## Theming

The UI is built entirely from `@lottiefiles/creator-plugins-ui` components and
theme tokens — no hard-coded colours. The sandbox forwards `creator.ui.theme` on
startup and re-forwards it on every `change:theme` event; the UI feeds those
tokens to `ThemeProvider` and toggles the `dark` class, so the panel tracks
Creator's interface theme, including custom ones.

## Development

```bash
npm run dev     # HTTPS dev server with hot reload
npm run build   # Type check + production build
npm run lint
```

Load it in Creator via **Plugins > Develop > New plugin**, using the localhost
URL that `npm run dev` prints.
