/**
 * Buffer (api-surface §Measures & construction ops) via the params-object
 * path (M7 decision): `GEOSBufferParams_create_r` + setters +
 * `GEOSBufferWithParams_r` — covers quadSegs, join style, mitre limit and
 * single-sided without the legacy `BufferWithStyle` enum soup.
 */
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { BufferParamsPtr, GeomPtr } from "../types.ts";

export interface BufferOptions {
  /** Quadrant segments per quarter circle (round joins). Default 8. */
  quadSegs?: number;
  /** Join style. Default "round". */
  join?: "round" | "mitre" | "bevel";
  /** Mitre ratio limit (mitre joins). GEOS default 5.0. */
  mitreLimit?: number;
  /** Single-sided buffer (positive = left side). Default false. */
  singleSided?: boolean;
  /** Cooperative cancellation (D19). */
  signal?: AbortSignal;
}

// geos_c.h enums
const BUF_CAP_ROUND = 1;
const BUF_JOIN_ROUND = 1;
const BUF_JOIN_MITRE = 2;
const BUF_JOIN_BEVEL = 3;

const JOIN_IDS = { round: BUF_JOIN_ROUND, mitre: BUF_JOIN_MITRE, bevel: BUF_JOIN_BEVEL } as const;

/**
 * Build a GEOSBufferParams from options. Created per call and always
 * destroyed by the caller (single-singular use) or around the batch call
 * (`bufferAll`). Phase 3: factored out of `buffer` so the batch path shares
 * one option-mapping.
 */
export function bufferParams(geos: Geos, opts: BufferOptions = {}): BufferParamsPtr {
  const params = geos.native.geos.GEOSBufferParams_create_r(geos.ctx);
  if (params === null) throw geos.fail("GEOSBufferParams_create_r");
  const p = params as BufferParamsPtr;
  const ops = geos.native.geos;
  const quadSegs = opts.quadSegs ?? 8;
  if (ops.GEOSBufferParams_setQuadrantSegments_r(geos.ctx, p, quadSegs) === 0) {
    throw geos.fail("GEOSBufferParams_setQuadrantSegments_r");
  }
  const join = opts.join ?? "round";
  if (ops.GEOSBufferParams_setJoinStyle_r(geos.ctx, p, JOIN_IDS[join]) === 0) {
    throw geos.fail("GEOSBufferParams_setJoinStyle_r");
  }
  if (join === "mitre" && opts.mitreLimit !== undefined) {
    if (ops.GEOSBufferParams_setMitreLimit_r(geos.ctx, p, opts.mitreLimit) === 0) {
      throw geos.fail("GEOSBufferParams_setMitreLimit_r");
    }
  }
  // Round caps for mitre/bevel joins would be overridden by the join style;
  // flat caps are the single-sided convention, square stays explicit round.
  if (ops.GEOSBufferParams_setEndCapStyle_r(geos.ctx, p, BUF_CAP_ROUND) === 0) {
    throw geos.fail("GEOSBufferParams_setEndCapStyle_r");
  }
  if (opts.singleSided === true) {
    if (ops.GEOSBufferParams_setSingleSided_r(geos.ctx, p, 1) === 0) {
      throw geos.fail("GEOSBufferParams_setSingleSided_r");
    }
  }
  return p;
}

export function buffer(
  geos: Geos,
  g: Geometry,
  distance: number,
  opts: BufferOptions = {},
): Geometry {
  g.requireSame(geos);
  geos.assertOpen("buffer()");
  const p = bufferParams(geos, opts);
  try {
    const out = geos.native.geos.GEOSBufferWithParams_r(geos.ctx, g.ptr, p, distance);
    return geos.take("GEOSBufferWithParams_r", out as GeomPtr | null);
  } finally {
    geos.native.geos.GEOSBufferParams_destroy_r(geos.ctx, p);
  }
}
