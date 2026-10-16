/**
 * Overlay / boolean ops (api-surface §Overlays) — OverlayNGRobust beneath
 * (GEOS 3.10+ self-heals near-degenerate inputs via snapping heuristics).
 * Outputs are new owned geometries, registered to the innermost open arena.
 */
import type { Pointer } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";

type Op2 = (geos: Geos, a: Geometry, b: Geometry) => Geometry;

function overlay(op: string, call: (geos: Geos, a: GeomPtr, b: GeomPtr) => Pointer | null): Op2 {
  return (geos, a, b) => {
    a.requireSame(geos);
    b.requireSame(geos);
    return geos.take(op, call(geos, a.ptr, b.ptr) as GeomPtr | null);
  };
}

export const intersection: Op2 = overlay("GEOSIntersection_r", (g, a, b) =>
  g.native.geos.GEOSIntersection_r(g.ctx, a, b),
);
export const union: Op2 = overlay("GEOSUnion_r", (g, a, b) =>
  g.native.geos.GEOSUnion_r(g.ctx, a, b),
);
export const difference: Op2 = overlay("GEOSDifference_r", (g, a, b) =>
  g.native.geos.GEOSDifference_r(g.ctx, a, b),
);
export const symDifference: Op2 = overlay("GEOSSymDifference_r", (g, a, b) =>
  g.native.geos.GEOSSymDifference_r(g.ctx, a, b),
);

/** Unary union of one geometry's components (no strategy dispatch until Phase 2). */
export function unaryUnion(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  return geos.take(
    "GEOSUnaryUnion_r",
    geos.native.geos.GEOSUnaryUnion_r(geos.ctx, g.ptr) as GeomPtr | null,
  );
}
