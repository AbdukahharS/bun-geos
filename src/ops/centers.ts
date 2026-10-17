/**
 * Centers, distances, clearance, clustering, grids (api-surface §Measures &
 * construction ops; Phase 5 M3 C5). Clustering follows the D16 lesson: the
 * public result is integer ids per input, never pointers.
 */

import { toArrayBuffer } from "bun:ffi";
import { fromCoords } from "../construct.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import { geomPtrArray, ptrOf } from "../ptrs.ts";
import type { GeomPtr } from "../types.ts";
import { numGeometries } from "./accessors.ts";

/** The centroid (GEOSGetCentroid — empty-safe: POINT EMPTY for an empty). */
export function centroid(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("centroid()");
  const out = geos.native.geos.GEOSGetCentroid_r(geos.ctx, g.ptr);
  return geos.take("GEOSGetCentroid_r", out as GeomPtr | null);
}

/**
 * A point guaranteed on the surface of the geometry (GEOSPointOnSurface —
 * the C name for JTS `getInteriorPoint`; XMLTester's getinteriorpoint).
 */
export function interiorPoint(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("interiorPoint()");
  const out = geos.native.geos.GEOSPointOnSurface_r(geos.ctx, g.ptr);
  return geos.take("GEOSPointOnSurface_r", out as GeomPtr | null);
}

/** The boundary (point/line per dimension — GEOSBoundary). */
export function boundary(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("boundary()");
  const out = geos.native.geos.GEOSBoundary_r(geos.ctx, g.ptr);
  return geos.take("GEOSBoundary_r", out as GeomPtr | null);
}

/**
 * The nearest points of two geometries as `[pOfA, pOfB]` (GEOSNearestPoints
 * — the STRtree-free pairwise form; for many queries use `STRtree.nearest`).
 */
export function nearestPoints(geos: Geos, a: Geometry, b: Geometry): [Geometry, Geometry] {
  a.requireSame(geos);
  b.requireSame(geos);
  geos.assertOpen("nearestPoints()");
  const seq = geos.native.geos.GEOSNearestPoints_r(geos.ctx, a.ptr, b.ptr) as GeomPtr | null;
  if (seq === null) throw geos.fail("GEOSNearestPoints_r");
  try {
    const buf = new Float64Array(4);
    if (geos.native.geos.GEOSCoordSeq_copyToBuffer_r(geos.ctx, seq, buf, 0, 0) === 0) {
      throw geos.fail("GEOSCoordSeq_copyToBuffer_r");
    }
    const pa = fromCoords(
      geos,
      { coords: buf.slice(0, 2), n: 1, hasZ: false, hasM: false },
      "point",
    );
    const pb = fromCoords(
      geos,
      { coords: buf.slice(2, 4), n: 1, hasZ: false, hasM: false },
      "point",
    );
    return [pa, pb];
  } finally {
    geos.native.geos.GEOSCoordSeq_destroy_r(geos.ctx, seq);
  }
}

/** The minimum clearance — the smallest distance at which the topology
 * holds; 0 for a valid single geometry without near-self-touches. */
export function minimumClearance(geos: Geos, g: Geometry): number {
  g.requireSame(geos);
  geos.assertOpen("minimumClearance()");
  const out = new Float64Array(1);
  // INT return (0 ok / 2 failure — geos_ts_c.cpp) — NOT masked (house rule).
  const r = geos.native.geos.GEOSMinimumClearance_r(geos.ctx, g.ptr, out);
  if (r !== 0) throw geos.fail("GEOSMinimumClearance_r");
  return out[0]!;
}

/** The minimum-clearance LINE — a two-point linestring realizing it. */
export function minimumClearanceLine(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("minimumClearanceLine()");
  const out = geos.native.geos.GEOSMinimumClearanceLine_r(geos.ctx, g.ptr);
  return geos.take("GEOSMinimumClearanceLine_r", out as GeomPtr | null);
}

/**
 * The largest circle contained in the polygon, centered on its true center —
 * returned as a two-point LINESTRING (center → nearest-boundary point),
 * matching the C API's encoding. `tolerance` bounds the approximation error
 * (required — there is no silent default).
 */
export function maximumInscribedCircle(geos: Geos, g: Geometry, tolerance: number): Geometry {
  g.requireSame(geos);
  geos.assertOpen("maximumInscribedCircle()");
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError(
      `maximumInscribedCircle: tolerance must be a positive number, got ${tolerance}`,
    );
  }
  const out = geos.native.geos.GEOSMaximumInscribedCircle_r(geos.ctx, g.ptr, tolerance);
  return geos.take("GEOSMaximumInscribedCircle_r", out as GeomPtr | null);
}

export interface LargestEmptyCircleOptions {
  /** Constrain the circle's center to this boundary's interior. */
  boundary?: Geometry;
}

/**
 * The largest empty circle whose center lies within `g` (optionally
 * constrained to `opts.boundary`) — two-point LINESTRING (center →
 * nearest-obstacle point), like maximumInscribedCircle. `tolerance` is
 * required.
 */
export function largestEmptyCircle(
  geos: Geos,
  g: Geometry,
  tolerance: number,
  opts: LargestEmptyCircleOptions = {},
): Geometry {
  g.requireSame(geos);
  geos.assertOpen("largestEmptyCircle()");
  if (!Number.isFinite(tolerance) || tolerance <= 0) {
    throw new RangeError(
      `largestEmptyCircle: tolerance must be a positive number, got ${tolerance}`,
    );
  }
  const boundary = opts.boundary;
  if (boundary !== undefined) boundary.requireSame(geos);
  const out = geos.native.geos.GEOSLargestEmptyCircle_r(
    geos.ctx,
    g.ptr,
    boundary?.ptr ?? null,
    tolerance,
  );
  return geos.take("GEOSLargestEmptyCircle_r", out as GeomPtr | null);
}

/** `Array.isArray` does not narrow `readonly T[]` unions — explicit predicate. */
function isGeometryArray(gs: Geometry | readonly Geometry[]): gs is readonly Geometry[] {
  return Array.isArray(gs);
}

/**
 * DBSCAN clustering (3.14): `clusterDBSCAN(gs, eps, minPoints)[i]` is the
 * cluster id of input i, or **-1 for noise** (unclustered). Ids are dense
 * integers in no guaranteed order. Accepts `Geometry[]` (normalized through
 * the shim's clone-collect, D21) or one collection geometry (its members
 * are clustered). Input order defines id positions.
 */
export function clusterDBSCAN(
  geos: Geos,
  gs: Geometry | readonly Geometry[],
  eps: number,
  minPoints: number,
): Int32Array {
  geos.assertOpen("clusterDBSCAN()");
  if (!Number.isFinite(eps) || eps < 0) {
    throw new RangeError(`clusterDBSCAN: eps must be a non-negative number, got ${eps}`);
  }
  if (!Number.isInteger(minPoints) || minPoints < 1) {
    throw new RangeError(`clusterDBSCAN: minPoints must be a positive integer, got ${minPoints}`);
  }
  let collectionPtr: GeomPtr;
  let inputCount: number;
  let tmpPtr: GeomPtr | null = null;
  if (isGeometryArray(gs)) {
    if (gs.length === 0) {
      throw new RangeError("clusterDBSCAN: input array must not be empty");
    }
    for (const g of gs) g.requireSame(geos);
    // D21: the collection consumes clones of the inputs — destroy raw after
    const ptrs = geomPtrArray(geos, gs, "clusterDBSCAN()");
    const src = geos.native.shim.geos_shim_clone_collect(
      geos.shim,
      ptrs,
      gs.length,
    ) as GeomPtr | null;
    if (src === null) throw geos.fail("geos_shim_clone_collect");
    tmpPtr = src;
    collectionPtr = src;
    inputCount = gs.length; // the collection has exactly n members
  } else {
    gs.requireSame(geos);
    collectionPtr = gs.ptr;
    inputCount = numGeometries(geos, gs);
  }
  try {
    const info = geos.native.geos.GEOSClusterDBSCAN_r(
      geos.ctx,
      collectionPtr,
      eps,
      minPoints,
    ) as GeomPtr | null;
    if (info === null) throw geos.fail("GEOSClusterDBSCAN_r");
    try {
      const n = inputCount;
      const idsPtr = geos.native.geos.GEOSClusterInfo_getClustersForInputs_r(
        geos.ctx,
        info,
      ) as GeomPtr | null;
      if (idsPtr === null) throw geos.fail("GEOSClusterInfo_getClustersForInputs_r");
      try {
        // size_t per input (GEOS-owned; copied out immediately)
        const view = new BigUint64Array(toArrayBuffer(idsPtr, 0, n * 8));
        const out = new Int32Array(n);
        for (let i = 0; i < n; i++) {
          const v = ptrOf(view[i]!);
          out[i] = v >= 0x7fffffff ? -1 : v; // SIZE_MAX (and friends) = noise
        }
        return out;
      } finally {
        geos.native.geos.GEOSFree_r(geos.ctx, idsPtr);
      }
    } finally {
      geos.native.geos.GEOSClusterInfo_destroy_r(geos.ctx, info);
    }
  } finally {
    if (tmpPtr !== null) geos.destroyRaw(tmpPtr);
  }
}

/**
 * Fraction of each grid cell covered by the polygon (3.14) — a Float32Array
 * of `nx × ny` values in [0, 1], row-major from (xmin, ymin).
 */
export function gridIntersectionFractions(
  geos: Geos,
  g: Geometry,
  grid: { xmin: number; ymin: number; xmax: number; ymax: number; nx: number; ny: number },
): Float32Array {
  g.requireSame(geos);
  geos.assertOpen("gridIntersectionFractions()");
  const { xmin, ymin, xmax, ymax, nx, ny } = grid;
  if (!(xmax > xmin) || !(ymax > ymin)) {
    throw new RangeError(
      `gridIntersectionFractions: need xmax > xmin and ymax > ymin, got [${xmin}, ${ymin}, ${xmax}, ${ymax}]`,
    );
  }
  if (!Number.isInteger(nx) || nx < 1 || !Number.isInteger(ny) || ny < 1) {
    throw new RangeError(
      `gridIntersectionFractions: nx/ny must be positive integers, got ${nx}×${ny}`,
    );
  }
  const out = new Float32Array(nx * ny);
  // INT return: lambda yields 1 on success, execute's failure value is 0.
  const r = geos.native.geos.GEOSGridIntersectionFractions_r(
    geos.ctx,
    g.ptr,
    xmin,
    ymin,
    xmax,
    ymax,
    nx,
    ny,
    out,
  );
  if (r !== 1) throw geos.fail("GEOSGridIntersectionFractions_r");
  return out;
}
