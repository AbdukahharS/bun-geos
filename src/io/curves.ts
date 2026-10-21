/**
 * The linear-only boundary (D31). Curved geometry types (CircularString,
 * CompoundCurve, CurvePolygon, MultiCurve, MultiSurface — GEOS 3.13+) are
 * DECLARED NEVER for this library: GEOS's own curved support is
 * I/O-and-measure only (predicates via RelateNG, overlays via OverlayNG,
 * distance, and validity all reject curved inputs — mostly via
 * `ensureNoCurvedComponents`; IsValidOp/IsSimpleOp throw their own
 * unsupported-operation errors), so a curve could never appear in the
 * op surface, and the JS exchange formats (GeoJSON, GeoArrow) are
 * linear-only. The WKT/WKB readers — the only
 * places a curve could enter, since construction is linear-only by shape —
 * call `assertLinear` on every parsed geometry, including every child of a
 * GEOMETRYCOLLECTION (a top-level check alone would let `GEOMETRYCOLLECTION(
 * CIRCULARSTRING(...))` slip through wrapped in a linear id-7 shell).
 */
import { GeosError } from "../errors.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";
import { CURVED_TYPE_NAMES, GeoType } from "../types.ts";

/** Pathological nesting guard (mirrors the shim's vertex_count). */
const MAX_DEPTH = 32;

/**
 * Throw unless `g` is a linear geometry (recursing into collections).
 * Called on reader output, so geometries need no cleanup here — children
 * are borrowed views and the parsed roots are already arena-registered
 * (disposal is the arena's job on both the success and the throw path).
 */
export function assertLinear(geos: Geos, g: Geometry, op: string, depth = 0): void {
  if (depth > MAX_DEPTH) {
    throw new GeosError(op, "geometry nesting exceeds 32 levels");
  }
  const id = geos.typeId(g);
  const name = CURVED_TYPE_NAMES[id];
  if (name !== undefined) {
    throw new GeosError(
      op,
      `${name}: curved geometry types are not supported — this library is linear-only (D31)`,
    );
  }
  if (id === GeoType.GeometryCollection) {
    const n = geos.numGeometries(g);
    for (let i = 0; i < n; i++) {
      const child = geos.borrow(
        geos.native.geos.GEOSGetGeometryN_r(geos.ctx, g.ptr, i) as GeomPtr,
        "GEOSGetGeometryN_r",
        g,
      );
      assertLinear(geos, child, op, depth + 1);
    }
  }
}
