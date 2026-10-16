/**
 * Topology repair (api-surface §"Topology repair", ROADMAP Phase 2):
 * `makeValid` (method/keepCollapsed params), `isValidDetail` /
 * `isSimpleDetail` diagnostics, and `orientPolygons`.
 *
 * Diagnostics policy (D21): `isValidDetail`/`isSimpleDetail` return the
 * location as an OWNED geometry to callers, but the diagnostics attached to
 * thrown `GeosError`s are STRINGS (WKT) — an exception must never own C
 * resources. `GEOSOrientPolygons_r` mutates in place, so the wrapper clones
 * first: user input is never mutated.
 */
import { CString } from "bun:ffi";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import { ptrOf } from "../ptrs.ts";
import type { GeomPtr, OwnedStrPtr } from "../types.ts";
// value+type pair: one import carries both declarations
import { MakeValidMethod } from "../types.ts";

export interface MakeValidOptions {
  /** Repair algorithm. Default "linework". */
  method?: keyof typeof MakeValidMethod;
  /** Keep collapsed linear elements (structure method). Default false. */
  keepCollapsed?: boolean;
}

/** Repair an invalid geometry into a valid one (GEOSMakeValidWithParams). */
export function makeValid(geos: Geos, g: Geometry, opts: MakeValidOptions = {}): Geometry {
  g.requireSame(geos);
  geos.assertOpen("makeValid()");
  // Pooled params, but ALL values re-set per call: omitted options reset to
  // the documented defaults (linework / no keepCollapsed) instead of
  // inheriting whatever a previous call left behind (audited stale-pool bug).
  const p = geos.makeValidParams();
  const ops = geos.native.geos;
  if (
    ops.GEOSMakeValidParams_setMethod_r(geos.ctx, p, MakeValidMethod[opts.method ?? "linework"]) ===
    0
  ) {
    throw geos.fail("GEOSMakeValidParams_setMethod_r");
  }
  if (
    ops.GEOSMakeValidParams_setKeepCollapsed_r(geos.ctx, p, opts.keepCollapsed === true ? 1 : 0) ===
    0
  ) {
    throw geos.fail("GEOSMakeValidParams_setKeepCollapsed_r");
  }
  const out = ops.GEOSMakeValidWithParams_r(geos.ctx, g.ptr, p);
  return geos.take("GEOSMakeValidWithParams_r", out as GeomPtr | null);
}

export interface ValidityDetail {
  valid: boolean;
  /** First invalidity reason, or null when valid (GEOS-owned string, freed). */
  reason: string | null;
  /** Point/line at the invalidity (owned geometry), or null when valid. */
  location: Geometry | null;
}

/** Validity + first reason + location in one call (GEOSisValidDetail). */
export function isValidDetail(geos: Geos, g: Geometry): ValidityDetail {
  g.requireSame(geos);
  geos.assertOpen("isValidDetail()");
  const reasonOut = new BigUint64Array(1);
  const locationOut = new BigUint64Array(1);
  const r = geos.native.geos.GEOSisValidDetail_r(geos.ctx, g.ptr, 0, reasonOut, locationOut) & 0xff;
  if (r === 2) throw geos.fail("GEOSisValidDetail_r");
  const valid = r === 1;
  let reason: string | null = null;
  if (reasonOut[0] !== 0n) {
    const p = ptrOf(reasonOut[0]!) as unknown as OwnedStrPtr;
    try {
      reason = new CString(p);
    } finally {
      geos.native.geos.GEOSFree_r(geos.ctx, p);
    }
  }
  let location: Geometry | null = null;
  if (locationOut[0] !== 0n) {
    location = geos.take("GEOSisValidDetail_r", ptrOf(locationOut[0]!) as unknown as GeomPtr);
  }
  return { valid, reason, location };
}

export interface SimpleDetail {
  simple: boolean;
  /**
   * Non-simple location(s) — a MULTIPOINT of the self-intersection nodes
   * (all of them when `findAll`), owned; null when simple.
   */
  location: Geometry | null;
}

/** Simplicity + non-simple locations (GEOSisSimpleDetail, 3.14). */
export function isSimpleDetail(
  geos: Geos,
  g: Geometry,
  opts: { findAll?: boolean } = {},
): SimpleDetail {
  g.requireSame(geos);
  geos.assertOpen("isSimpleDetail()");
  const locationOut = new BigUint64Array(1);
  const r =
    geos.native.geos.GEOSisSimpleDetail_r(
      geos.ctx,
      g.ptr,
      opts.findAll === true ? 1 : 0,
      locationOut,
    ) & 0xff;
  if (r === 2) throw geos.fail("GEOSisSimpleDetail_r");
  const simple = r === 1;
  let location: Geometry | null = null;
  if (locationOut[0] !== 0n) {
    location = geos.take("GEOSisSimpleDetail_r", ptrOf(locationOut[0]!) as unknown as GeomPtr);
  }
  return { simple, location };
}

/**
 * Consistently orient polygon rings (exterior CCW + holes CW for "ccw" —
 * the RFC 7946 recommendation; "cw" inverts). GEOS's entry mutates in
 * place; we clone first (input is never mutated). Borrowed views are
 * rejected by clone... they are wrapped geoms — clone of a borrowed interior
 * pointer is fine in C, but our rule is that ops take owned or alive
 * geometries; requireSame/assertAlive covers liveness.
 */
export function orientPolygons(geos: Geos, g: Geometry, dir: "ccw" | "cw" = "ccw"): Geometry {
  g.requireSame(geos);
  geos.assertOpen("orientPolygons()");
  const clone = geos.native.geos.GEOSGeom_clone_r(geos.ctx, g.ptr);
  if (clone === null) throw geos.fail("GEOSGeom_clone_r");
  // OrientPolygons is an INT (not char) return: 0 on success, -1 on failure
  // (execute sentinel) — no 0xff masking here, -1 masked would read 255.
  const r = geos.native.geos.GEOSOrientPolygons_r(geos.ctx, clone as GeomPtr, dir === "cw" ? 1 : 0);
  if (r < 0) {
    geos.destroyRaw(clone as GeomPtr);
    throw geos.fail("GEOSOrientPolygons_r");
  }
  return geos.take("GEOSOrientPolygons_r", clone as GeomPtr);
}
