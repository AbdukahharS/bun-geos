/**
 * Unprepared predicates (api-surface §Predicates) and DE-9IM relate.
 *
 * GEOS char-return contract (geos_c.h): 1 = true, 0 = false, 2 = exception.
 * The exception path consumes the shim's thread-local message and throws
 * `GeosError` (D13); `false` is a normal answer, never an error.
 */
import { CString } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";

/**
 * @internal — interpret a GEOS char predicate result. Char returns arrive in
 * a 32-bit register whose UPPER BITS ARE GARBAGE (x86-64 psABI: unspecified
 * for sub-word returns — measured: GEOSisEmpty_r returned 0x44070001), so
 * mask to the low byte before interpreting. 1 = true, 0 = false, 2 = exception.
 */
export function charResult(geos: Geos, op: string, r: number): boolean {
  const v = r & 0xff;
  if (v === 2) throw geos.fail(op);
  return v === 1;
}

type Pred = (geos: Geos, a: Geometry, b: Geometry) => boolean;

function binary(op: string, call: (geos: Geos, a: GeomPtr, b: GeomPtr) => number): Pred {
  return (geos, a, b) => {
    a.requireSame(geos);
    b.requireSame(geos);
    return charResult(geos, op, call(geos, a.ptr, b.ptr));
  };
}

export const intersects: Pred = binary("GEOSIntersects_r", (g, a, b) =>
  g.native.geos.GEOSIntersects_r(g.ctx, a, b),
);
export const disjoint: Pred = binary("GEOSDisjoint_r", (g, a, b) =>
  g.native.geos.GEOSDisjoint_r(g.ctx, a, b),
);
export const touches: Pred = binary("GEOSTouches_r", (g, a, b) =>
  g.native.geos.GEOSTouches_r(g.ctx, a, b),
);
export const crosses: Pred = binary("GEOSCrosses_r", (g, a, b) =>
  g.native.geos.GEOSCrosses_r(g.ctx, a, b),
);
export const within: Pred = binary("GEOSWithin_r", (g, a, b) =>
  g.native.geos.GEOSWithin_r(g.ctx, a, b),
);
export const contains: Pred = binary("GEOSContains_r", (g, a, b) =>
  g.native.geos.GEOSContains_r(g.ctx, a, b),
);
export const overlaps: Pred = binary("GEOSOverlaps_r", (g, a, b) =>
  g.native.geos.GEOSOverlaps_r(g.ctx, a, b),
);
export const covers: Pred = binary("GEOSCovers_r", (g, a, b) =>
  g.native.geos.GEOSCovers_r(g.ctx, a, b),
);
export const coveredBy: Pred = binary("GEOSCoveredBy_r", (g, a, b) =>
  g.native.geos.GEOSCoveredBy_r(g.ctx, a, b),
);
export const equals: Pred = binary("GEOSEquals_r", (g, a, b) =>
  g.native.geos.GEOSEquals_r(g.ctx, a, b),
);
export const equalsIdentical: Pred = binary("GEOSEqualsIdentical_r", (g, a, b) =>
  g.native.geos.GEOSEqualsIdentical_r(g.ctx, a, b),
);

/** DE-9IM pattern match, e.g. `"FF*FF****"` (D13: invalid patterns throw). */
export function relatesPattern(geos: Geos, a: Geometry, b: Geometry, pattern: string): boolean {
  a.requireSame(geos);
  b.requireSame(geos);
  const r = geos.native.geos.GEOSRelatePattern_r(geos.ctx, a.ptr, b.ptr, pattern);
  return charResult(geos, "GEOSRelatePattern_r", r);
}

/** Full DE-9IM intersection matrix, e.g. `"212101212"` (owned string, F10). */
export function relateMatrix(geos: Geos, a: Geometry, b: Geometry): string {
  a.requireSame(geos);
  b.requireSame(geos);
  const p = geos.native.geos.GEOSRelate_r(geos.ctx, a.ptr, b.ptr);
  if (p === null) throw geos.fail("GEOSRelate_r");
  try {
    return new CString(p);
  } finally {
    geos.native.geos.GEOSFree_r(geos.ctx, p);
  }
}
