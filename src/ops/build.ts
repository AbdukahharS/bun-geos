/**
 * Topology building (api-surface §Measures & construction ops; Phase 5 M3
 * C4): node, build area, polygonize.
 */
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import { geomPtrArray } from "../ptrs.ts";
import type { GeomPtr } from "../types.ts";

/** Fully node a linestring collection (all intersections split). */
export function node(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("node()");
  const out = geos.native.geos.GEOSNode_r(geos.ctx, g.ptr);
  return geos.take("GEOSNode_r", out as GeomPtr | null);
}

/** Polygonal area enclosed by a linework geometry (PostGIS ST_BuildArea). */
export function buildArea(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("buildArea()");
  const out = geos.native.geos.GEOSBuildArea_r(geos.ctx, g.ptr);
  return geos.take("GEOSBuildArea_r", out as GeomPtr | null);
}

/**
 * Polygonize linework into a GEOMETRYCOLLECTION of polygons — every ring
 * formed by the (noded) lines becomes a polygon. Inputs are borrowed, never
 * consumed. Accepts one geometry (a collection's members are NOT unpacked —
 * pass the collection only if GEOS should see it as one input; the usual
 * call is an array of LINESTRINGs) or an array of geometries.
 */
export function polygonize(geos: Geos, gs: Geometry | readonly Geometry[]): Geometry {
  geos.assertOpen("polygonize()");
  const items = Array.isArray(gs) ? gs : [gs];
  if (items.length === 0) {
    throw new RangeError("polygonize: input must not be empty");
  }
  for (const g of items) g.requireSame(geos);
  // GEOSPolygonize borrows the inputs — the pointer array is our own buffer.
  const ptrs = geomPtrArray(geos, items, "polygonize()");
  const out = geos.native.geos.GEOSPolygonize_r(geos.ctx, ptrs, items.length);
  return geos.take("GEOSPolygonize_r", out as GeomPtr | null);
}
