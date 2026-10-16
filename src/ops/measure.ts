/**
 * Measures (api-surface §Measures & construction ops). Each call passes a
 * one-element `Float64Array` out-param (the spike-proven pattern); the i32
 * return reports GEOS failure → `GeosError` (D13).
 */
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";

type Measure2 = (geos: Geos, a: Geometry, b: Geometry) => number;

function measure2(
  op: string,
  call: (geos: Geos, a: GeomPtr, b: GeomPtr, out: Float64Array) => number,
): Measure2 {
  return (geos, a, b) => {
    a.requireSame(geos);
    b.requireSame(geos);
    const out = new Float64Array(1);
    if (call(geos, a.ptr, b.ptr, out) === 0) throw geos.fail(op);
    return out[0]!;
  };
}

/** Area of a polygonal geometry (0 for non-areal). */
export function area(geos: Geos, g: Geometry): number {
  g.requireSame(geos);
  const out = new Float64Array(1);
  if (geos.native.geos.GEOSArea_r(geos.ctx, g.ptr, out) === 0) throw geos.fail("GEOSArea_r");
  return out[0]!;
}

/** Length / perimeter of a geometry (0 for points). */
export function length(geos: Geos, g: Geometry): number {
  g.requireSame(geos);
  const out = new Float64Array(1);
  if (geos.native.geos.GEOSLength_r(geos.ctx, g.ptr, out) === 0) throw geos.fail("GEOSLength_r");
  return out[0]!;
}

export const distance: Measure2 = measure2("GEOSDistance_r", (g, a, b, out) =>
  g.native.geos.GEOSDistance_r(g.ctx, a, b, out),
);

/** Discrete Hausdorff distance. */
export const hausdorff: Measure2 = measure2("GEOSHausdorffDistance_r", (g, a, b, out) =>
  g.native.geos.GEOSHausdorffDistance_r(g.ctx, a, b, out),
);

/** Discrete Fréchet distance. */
export const frechet: Measure2 = measure2("GEOSFrechetDistance_r", (g, a, b, out) =>
  g.native.geos.GEOSFrechetDistance_r(g.ctx, a, b, out),
);
