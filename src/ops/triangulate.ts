/**
 * Triangulations (api-surface §Measures & construction ops; Phase 5 M3 C2):
 * Delaunay / constrained Delaunay / Voronoi diagrams (3.12 C API).
 */
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";

// geos_c.h GEOS_VORONOI_* flags
const VORONOI_ONLY_EDGES = 1;
const VORONOI_PRESERVE_ORDER = 2;

export interface DelaunayOptions {
  /** Snapping tolerance for the extraction. Default 0 (no snapping). */
  tolerance?: number;
  /** Return the constraint edges as a MULTILINESTRING instead of triangles. */
  onlyEdges?: boolean;
}

export interface VoronoiOptions {
  /** Snapping tolerance. Default 0 (no snapping). */
  tolerance?: number;
  /** Return the diagram edges as a MULTILINESTRING instead of cell polygons. */
  onlyEdges?: boolean;
  /** Clip the diagram to this envelope's extent. */
  envelope?: Geometry;
  /** Keep cell order aligned with the input sites. Default false. */
  ordered?: boolean;
}

/** Delaunay triangulation of the input's vertices (multi-geometry aware). */
export function delaunay(geos: Geos, g: Geometry, opts: DelaunayOptions = {}): Geometry {
  g.requireSame(geos);
  geos.assertOpen("delaunay()");
  const tolerance = opts.tolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(`delaunay: tolerance must be a non-negative number, got ${tolerance}`);
  }
  const out = geos.native.geos.GEOSDelaunayTriangulation_r(
    geos.ctx,
    g.ptr,
    tolerance,
    opts.onlyEdges === true ? 1 : 0,
  );
  return geos.take("GEOSDelaunayTriangulation_r", out as GeomPtr | null);
}

/**
 * Constrained Delaunay triangulation of a POLYGON's edges (3.13+): the
 * polygon's rings become triangle constraints — the triangles exactly
 * cover the (multi)polygon's area.
 */
export function constrainedDelaunay(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  geos.assertOpen("constrainedDelaunay()");
  const out = geos.native.geos.GEOSConstrainedDelaunayTriangulation_r(geos.ctx, g.ptr);
  return geos.take("GEOSConstrainedDelaunayTriangulation_r", out as GeomPtr | null);
}

/** Voronoi diagram of the input's vertices. */
export function voronoi(geos: Geos, g: Geometry, opts: VoronoiOptions = {}): Geometry {
  g.requireSame(geos);
  geos.assertOpen("voronoi()");
  const tolerance = opts.tolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(`voronoi: tolerance must be a non-negative number, got ${tolerance}`);
  }
  let flags = 0;
  if (opts.onlyEdges === true) flags |= VORONOI_ONLY_EDGES;
  if (opts.ordered === true) flags |= VORONOI_PRESERVE_ORDER;
  const env = opts.envelope;
  if (env !== undefined) env.requireSame(geos);
  const out = geos.native.geos.GEOSVoronoiDiagram_r(
    geos.ctx,
    g.ptr,
    env?.ptr ?? null,
    tolerance,
    flags,
  );
  return geos.take("GEOSVoronoiDiagram_r", out as GeomPtr | null);
}
