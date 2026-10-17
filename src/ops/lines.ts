/**
 * Line ops (api-surface §Measures & construction ops; Phase 5 M3 C3):
 * line merge, line substring, offset curve, shared paths, snapping.
 */
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr } from "../types.ts";
import { JOIN_IDS } from "./buffer.ts";

export interface LineMergeOptions {
  /** Merge only same-direction sequences (3.14 GEOSLineMergeDirected). */
  directed?: boolean;
}

/**
 * Merge contiguous line sequences of a (multi)linestring into maximal
 * linestrings. Nodes are kept where endpoints do NOT meet exactly 2 lines.
 */
export function lineMerge(geos: Geos, g: Geometry, opts: LineMergeOptions = {}): Geometry {
  g.requireSame(geos);
  geos.assertOpen("lineMerge()");
  const out =
    opts.directed === true
      ? geos.native.geos.GEOSLineMergeDirected_r(geos.ctx, g.ptr)
      : geos.native.geos.GEOSLineMerge_r(geos.ctx, g.ptr);
  return geos.take(
    opts.directed === true ? "GEOSLineMergeDirected_r" : "GEOSLineMerge_r",
    out as GeomPtr | null,
  );
}

export interface OffsetCurveOptions {
  /** Quadrant segments per quarter circle (round joins). Default 8. */
  quadSegs?: number;
  /** Join style. Default "round". */
  join?: "round" | "mitre" | "bevel";
  /** Mitre ratio limit (mitre joins). GEOS default 5.0. */
  mitreLimit?: number;
}

/**
 * Offset curve of a linestring at `distance` (left side positive, right
 * negative — GEOS's sign convention). Params mirror the buffer options the
 * legacy GEOSOffsetCurve signature takes.
 */
export function offsetCurve(
  geos: Geos,
  g: Geometry,
  distance: number,
  opts: OffsetCurveOptions = {},
): Geometry {
  g.requireSame(geos);
  geos.assertOpen("offsetCurve()");
  if (!Number.isFinite(distance)) {
    throw new RangeError(`offsetCurve: distance must be a finite number, got ${distance}`);
  }
  const join = opts.join ?? "round";
  const out = geos.native.geos.GEOSOffsetCurve_r(
    geos.ctx,
    g.ptr,
    distance,
    opts.quadSegs ?? 8,
    JOIN_IDS[join],
    opts.mitreLimit ?? 5.0,
  );
  return geos.take("GEOSOffsetCurve_r", out as GeomPtr | null);
}

/**
 * Sub-linestring between fractional positions `start` and `end` of a
 * LINESTRING (3.14 GEOSLineSubstring). Fractions are clamped by GEOS to
 * [0, 1]; start > end throws (D13: programming error).
 */
export function lineSubstring(geos: Geos, g: Geometry, start: number, end: number): Geometry {
  g.requireSame(geos);
  geos.assertOpen("lineSubstring()");
  for (const [name, v] of [
    ["start", start],
    ["end", end],
  ] as const) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      throw new RangeError(`lineSubstring: ${name} fraction must be within [0, 1], got ${v}`);
    }
  }
  if (start > end) {
    throw new RangeError(`lineSubstring: start (${start}) must not exceed end (${end})`);
  }
  const out = geos.native.geos.GEOSLineSubstring_r(geos.ctx, g.ptr, start, end);
  return geos.take("GEOSLineSubstring_r", out as GeomPtr | null);
}

/** The shared paths between two geometries (noded common linework). */
export function sharedPaths(geos: Geos, a: Geometry, b: Geometry): Geometry {
  a.requireSame(geos);
  b.requireSame(geos);
  geos.assertOpen("sharedPaths()");
  const out = geos.native.geos.GEOSSharedPaths_r(geos.ctx, a.ptr, b.ptr);
  return geos.take("GEOSSharedPaths_r", out as GeomPtr | null);
}

/** Snap `a` to `b`'s vertices/segments within `tolerance`. */
export function snap(geos: Geos, a: Geometry, b: Geometry, tolerance: number): Geometry {
  a.requireSame(geos);
  b.requireSame(geos);
  geos.assertOpen("snap()");
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError(`snap: tolerance must be a non-negative number, got ${tolerance}`);
  }
  const out = geos.native.geos.GEOSSnap_r(geos.ctx, a.ptr, b.ptr, tolerance);
  return geos.take("GEOSSnap_r", out as GeomPtr | null);
}
