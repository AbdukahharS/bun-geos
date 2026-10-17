/**
 * Hulls, simplification, rectangular clipping (api-surface §Measures &
 * construction ops; Phase 5 M3 C1). Singular forms here; the element-wise
 * `*All` forms live in batch.ts via `geos_shim_unary_all` (D27).
 */
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";

export interface ConcaveHullOptions {
  /** Keep holes of the input in the output. Default false. */
  allowHoles?: boolean;
}

/** The convex hull (GEOSConvexHull). */
export function convexHull(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("convexHull()");
  const out = geos.native.geos.GEOSConvexHull_r(geos.ctx, g.ptr);
  return geos.take("GEOSConvexHull_r", out as GeomPtr | null);
}

/**
 * The concave hull (3.11+). `ratio` ∈ [0, 1]: 1 = convex hull, smaller
 * values hug the input more tightly; ratios that cannot produce a valid
 * hull fall back per GEOS's documented behavior.
 */
export function concaveHull(
  geos: Geos,
  g: Geometry,
  ratio: number,
  opts: ConcaveHullOptions = {},
): Geometry {
  g.requireSame(geos);
  geos.assertOpen("concaveHull()");
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new RangeError(`concaveHull: ratio must be within [0, 1], got ${ratio}`);
  }
  const out = geos.native.geos.GEOSConcaveHull_r(
    geos.ctx,
    g.ptr,
    ratio,
    opts.allowHoles === true ? 1 : 0,
  );
  return geos.take("GEOSConcaveHull_r", out as GeomPtr | null);
}

/** Douglas-Peucker simplification (distance tolerance). */
export function simplify(geos: Geos, g: Geometry, tolerance: number): Geometry {
  g.requireSame(geos);
  geos.assertOpen("simplify()");
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(`simplify: tolerance must be a non-negative number, got ${tolerance}`);
  }
  const out = geos.native.geos.GEOSSimplify_r(geos.ctx, g.ptr, tolerance);
  return geos.take("GEOSSimplify_r", out as GeomPtr | null);
}

/** Topology-preserving simplification — never introduces self-intersections. */
export function topologyPreserveSimplify(geos: Geos, g: Geometry, tolerance: number): Geometry {
  g.requireSame(geos);
  geos.assertOpen("topologyPreserveSimplify()");
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(
      `topologyPreserveSimplify: tolerance must be a non-negative number, got ${tolerance}`,
    );
  }
  const out = geos.native.geos.GEOSTopologyPreserveSimplify_r(geos.ctx, g.ptr, tolerance);
  return geos.take("GEOSTopologyPreserveSimplify_r", out as GeomPtr | null);
}

/** Fast rectangular clip (clip-by-rect — not a robust overlay; see GEOS docs). */
export function clipByRect(
  geos: Geos,
  g: Geometry,
  xmin: number,
  ymin: number,
  xmax: number,
  ymax: number,
): Geometry {
  g.requireSame(geos);
  geos.assertOpen("clipByRect()");
  if (!(xmax > xmin) || !(ymax > ymin)) {
    throw new RangeError(
      `clipByRect: need xmax > xmin and ymax > ymin, got [${xmin}, ${ymin}, ${xmax}, ${ymax}]`,
    );
  }
  const out = geos.native.geos.GEOSClipByRect_r(geos.ctx, g.ptr, xmin, ymin, xmax, ymax);
  return geos.take("GEOSClipByRect_r", out as GeomPtr | null);
}
