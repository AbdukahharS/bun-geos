/**
 * WKT I/O (io.md §2). Reading uses the pooled WKT reader. All write paths go
 * through a FRESH writer per call: writers carry mutable settings (so they
 * cannot be pooled), and the default is trimmed output (`POINT (0 0)` —
 * GEOSGeomToWKT_r would emit untrimmed 16-digit text on 3.14, which is why
 * it is bound for the Phase 3 bench harness only, never used here).
 *
 * Owned-string discipline (F10): the writer returns a GEOS-owned buffer →
 * bind "ptr", view with `CString`, `GEOSFree_r` in a finally block.
 */
import { CString } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { GeomPtr, WktWriterPtr } from "../types.ts";
import { assertLinear } from "./curves.ts";

export interface WKTOptions {
  /** Max digits after the decimal point (writer path). */
  precision?: number;
  /** Trim trailing zeros (writer path). Default true when options are given. */
  trim?: boolean;
  /** Output dimension: 2, 3 (Z) or 4 (ZM). Default 2. */
  outputDimension?: 2 | 3 | 4;
  /** Old-style 3D (`POINT Z (…)` vs `POINT Z(…)`)? GEOS default false. */
  old3D?: boolean;
}

/** Parse WKT into a new owned geometry (GEOS message on malformed input, D13). */
export function fromWKT(geos: Geos, wkt: string): Geometry {
  geos.assertOpen("fromWKT");
  const g = geos.native.geos.GEOSWKTReader_read_r(geos.ctx, geos.wktReader(), wkt);
  const geom = geos.take("GEOSWKTReader_read_r", g as GeomPtr | null);
  assertLinear(geos, geom, "fromWKT"); // D31 — curved payloads never enter
  return geom;
}

/** WKT of a geometry. Default: trimmed (`POINT (0 0)`, Shapely-2 style). */
export function toWKT(geos: Geos, g: Geometry, opts: WKTOptions = {}): string {
  g.requireSame(geos);
  const ops = geos.native.geos;
  // Note: GEOSGeomToWKT_r would skip the writer, but on 3.14 it emits
  // untrimmed 16-digit output — not the debuggable default we want. All
  // paths go through a fresh writer (writers carry mutable settings, so
  // they are not pooled).
  const w = ops.GEOSWKTWriter_create_r(geos.ctx);
  if (w === null) throw geos.fail("GEOSWKTWriter_create_r");
  const writer = w as WktWriterPtr;
  try {
    if (opts.trim ?? true) ops.GEOSWKTWriter_setTrim_r(geos.ctx, writer, 1);
    if (opts.precision !== undefined) {
      ops.GEOSWKTWriter_setRoundingPrecision_r(geos.ctx, writer, opts.precision);
    }
    if (opts.outputDimension !== undefined) {
      ops.GEOSWKTWriter_setOutputDimension_r(geos.ctx, writer, opts.outputDimension);
    }
    if (opts.old3D !== undefined) {
      ops.GEOSWKTWriter_setOld3D_r(geos.ctx, writer, opts.old3D ? 1 : 0);
    }
    const p = ops.GEOSWKTWriter_write_r(geos.ctx, writer, g.ptr);
    if (p === null) throw geos.fail("GEOSWKTWriter_write_r");
    try {
      return new CString(p);
    } finally {
      ops.GEOSFree_r(geos.ctx, p);
    }
  } finally {
    ops.GEOSWKTWriter_destroy_r(geos.ctx, writer);
  }
}
