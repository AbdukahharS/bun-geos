/**
 * Precision model (api-surface §Overlays, ROADMAP Phase 2): `setPrecision`
 * (GEOSGeom_setPrecision) and the fixed-precision overlay variants (`*Prec`).
 *
 * gridSize is the snapping grid (0 → floating precision); the mode flags map
 * 1:1 onto the GEOSPrecisionRules enum. The `*Prec` overlays snap their
 * RESULT to the grid (GEOSIntersectionPrec_r et al) — the honest answer to
 * IEEE-754 robustness surprises (geos research §10.2).
 */
import type { Pointer } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";
// value+type pair: one import carries both declarations
import { PrecisionMode } from "../types.ts";

export interface SetPrecisionOptions {
  /**
   * validOutput (default): output always valid, collapsed elements removed.
   * noTopo: pointwise reduction, output may be invalid.
   * keepCollapsed: like validOutput but collapsed LINES are kept.
   */
  mode?: keyof typeof PrecisionMode;
}

/** Re-build a geometry on a fixed precision grid (new owned geometry). */
export function setPrecision(
  geos: Geos,
  g: Geometry,
  gridSize: number,
  opts: SetPrecisionOptions = {},
): Geometry {
  g.requireSame(geos);
  geos.assertOpen("setPrecision()");
  if (!Number.isFinite(gridSize) || gridSize < 0) {
    throw new RangeError(`setPrecision: gridSize must be a non-negative number, got ${gridSize}`);
  }
  const out = geos.native.geos.GEOSGeom_setPrecision_r(
    geos.ctx,
    g.ptr,
    gridSize,
    PrecisionMode[opts.mode ?? "validOutput"],
  );
  return geos.take("GEOSGeom_setPrecision_r", out as GeomPtr | null);
}

/** The geometry's current precision grid (0 = floating). */
export function getPrecision(geos: Geos, g: Geometry): number {
  g.requireSame(geos);
  geos.assertOpen("getPrecision()");
  return geos.native.geos.GEOSGeom_getPrecision_r(geos.ctx, g.ptr);
}

type PrecOp2 = (geos: Geos, a: Geometry, b: Geometry, gridSize: number) => Geometry;

function overlayPrec(
  op: string,
  call: (geos: Geos, a: GeomPtr, b: GeomPtr, gridSize: number) => Pointer | null,
): PrecOp2 {
  return (geos, a, b, gridSize) => {
    assertGrid(op, gridSize);
    a.requireSame(geos);
    b.requireSame(geos);
    return geos.take(op, call(geos, a.ptr, b.ptr, gridSize) as GeomPtr | null);
  };
}

function assertGrid(op: string, gridSize: number): void {
  if (!Number.isFinite(gridSize) || gridSize < 0) {
    throw new RangeError(`${op}: gridSize must be a non-negative number, got ${gridSize}`);
  }
}

export const intersectionPrec: PrecOp2 = overlayPrec("GEOSIntersectionPrec_r", (g, a, b, grid) =>
  g.native.geos.GEOSIntersectionPrec_r(g.ctx, a, b, grid),
);
export const unionPrec: PrecOp2 = overlayPrec("GEOSUnionPrec_r", (g, a, b, grid) =>
  g.native.geos.GEOSUnionPrec_r(g.ctx, a, b, grid),
);
export const differencePrec: PrecOp2 = overlayPrec("GEOSDifferencePrec_r", (g, a, b, grid) =>
  g.native.geos.GEOSDifferencePrec_r(g.ctx, a, b, grid),
);
export const symDifferencePrec: PrecOp2 = overlayPrec("GEOSSymDifferencePrec_r", (g, a, b, grid) =>
  g.native.geos.GEOSSymDifferencePrec_r(g.ctx, a, b, grid),
);

/** Unary union with the result snapped to the grid. */
export function unaryUnionPrec(geos: Geos, g: Geometry, gridSize: number): Geometry {
  assertGrid("GEOSUnaryUnionPrec_r", gridSize);
  g.requireSame(geos);
  return geos.take(
    "GEOSUnaryUnionPrec_r",
    geos.native.geos.GEOSUnaryUnionPrec_r(geos.ctx, g.ptr, gridSize) as GeomPtr | null,
  );
}
