/**
 * Overlay / boolean ops (api-surface §Overlays) — OverlayNGRobust beneath
 * (GEOS 3.10+ self-heals near-degenerate inputs via snapping heuristics).
 * Outputs are new owned geometries, registered to the innermost open arena.
 *
 * Phase 2: `unionAll` strategy dispatch (D20) runs as ONE shim call — the
 * clone loop, temporary collection, and CoverageUnion/DisjointSubsetUnion/
 * UnaryUnion selection all happen in C (architecture.md §4: two crossings
 * regardless of input size).
 */

import type { Pointer } from "bun:ffi";
import type { Arena } from "../arena.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import { geomPtrArray } from "../ptrs.ts";
import type { GeomPtr } from "../types.ts";
import { UnionStrategy } from "../types.ts";

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

/** Unary union of one geometry's components. */
export function unaryUnion(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  return geos.take(
    "GEOSUnaryUnion_r",
    geos.native.geos.GEOSUnaryUnion_r(geos.ctx, g.ptr) as GeomPtr | null,
  );
}

/** `unionAll` strategy (api-surface §Overlays). */
export type UnionAllStrategy = "auto" | "coverage" | "disjointSubset" | "unary";

export interface UnionAllOptions {
  /**
   * auto (default): valid aligned coverage → CoverageUnion; otherwise
   * DisjointSubsetUnion (correct for any input, wins on spatially
   * partitioned data). Explicit overrides skip the validation pass.
   */
  strategy?: UnionAllStrategy;
  /** Register the result with this arena instead of the innermost open one. */
  arena?: Arena;
  /** Cooperative cancellation (D19). */
  signal?: AbortSignal;
}

/**
 * Union many geometries (D20): one shim crossing — clone → temp
 * GEOMETRYCOLLECTION → strategy → result. `n === 1` is the identity (a
 * clone); the inputs are never consumed.
 */
export function unionAll(
  geos: Geos,
  gs: readonly Geometry[],
  opts: UnionAllOptions = {},
): Geometry {
  geos.assertOpen("unionAll()");
  if (gs.length === 0) {
    throw new RangeError("unionAll: needs at least one geometry");
  }
  const strategy = UnionStrategy[opts.strategy ?? "auto"];
  const ptrs = geomPtrArray(geos, gs, "unionAll");
  const r = geos.native.shim.geos_shim_union_all(geos.shim, ptrs, gs.length, strategy);
  return geos.take("geos_shim_union_all", r as GeomPtr | null, opts.arena ?? undefined);
}

/**
 * Raw CoverageUnion — orders-of-magnitude union for ALIGNED polygonal
 * coverages. Caller asserts the input IS a valid coverage: on a non-coverage
 * the result is silently wrong (GEOS does not check), which is why
 * `unionAll({ strategy: "coverage" })` validates first (D20).
 */
export function coverageUnion(
  geos: Geos,
  gs: readonly Geometry[],
  opts: { arena?: Arena } = {},
): Geometry {
  geos.assertOpen("coverageUnion()");
  if (gs.length === 0) {
    throw new RangeError("coverageUnion: needs at least one geometry");
  }
  const ptrs = geomPtrArray(geos, gs, "coverageUnion");
  const r = geos.native.shim.geos_shim_coverage_union(geos.shim, ptrs, gs.length);
  return geos.take("geos_shim_coverage_union", r as GeomPtr | null, opts.arena ?? undefined);
}
