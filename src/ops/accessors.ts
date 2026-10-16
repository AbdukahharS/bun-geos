/**
 * Envelope & accessors (api-surface §Construction & I/O + ROADMAP Phase 1
 * "envelope/accessors").
 *
 * BORROWED RULE (geos research §4): `GEOSGetExteriorRing_r`,
 * `GEOSGetInteriorRingN_r` and `GEOSGetGeometryN_r` return GEOS-owned
 * interior pointers — they are wrapped as non-owning `Geometry` views whose
 * dispose is a no-op, and must not outlive their parent.
 */
import { CString } from "bun:ffi";
import { GeosError } from "../errors.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import type { CoordSeqPtr, FlatCoords, GeomPtr, GeoTypeId } from "../types.ts";
import { GeoType } from "../types.ts";

export function geomType(geos: Geos, g: Geometry): string {
  g.requireSame(geos);
  const p = geos.native.geos.GEOSGeomType_r(geos.ctx, g.ptr);
  if (p === null) throw geos.fail("GEOSGeomType_r");
  try {
    return new CString(p);
  } finally {
    geos.native.geos.GEOSFree_r(geos.ctx, p);
  }
}

export function geomTypeId(geos: Geos, g: Geometry): GeoTypeId {
  g.requireSame(geos);
  const id = geos.native.geos.GEOSGeomTypeId_r(geos.ctx, g.ptr);
  if (id < 0) throw geos.fail("GEOSGeomTypeId_r");
  return id as GeoTypeId;
}

export function isEmpty(geos: Geos, g: Geometry): boolean {
  g.requireSame(geos);
  // char return: mask (see predicates.charResult — upper register bits garbage)
  const r = geos.native.geos.GEOSisEmpty_r(geos.ctx, g.ptr) & 0xff;
  if (r === 2) throw geos.fail("GEOSisEmpty_r");
  return r === 1;
}

/** Bounding envelope as a new owned geometry (typically a polygon). */
export function envelope(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  return geos.take(
    "GEOSEnvelope_r",
    geos.native.geos.GEOSEnvelope_r(geos.ctx, g.ptr) as GeomPtr | null,
  );
}

export function numGeometries(geos: Geos, g: Geometry): number {
  g.requireSame(geos);
  const n = geos.native.geos.GEOSGetNumGeometries_r(geos.ctx, g.ptr);
  if (n < 0) throw geos.fail("GEOSGetNumGeometries_r");
  return n;
}

/** i-th sub-geometry — a BORROWED view (see module doc). */
export function getGeometryN(geos: Geos, g: Geometry, n: number): Geometry {
  g.requireSame(geos);
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`getGeometryN: index must be a non-negative integer, got ${n}`);
  }
  return geos.borrow(
    geos.native.geos.GEOSGetGeometryN_r(geos.ctx, g.ptr, n) as GeomPtr | null,
    "GEOSGetGeometryN_r",
    g,
  );
}

export function numInteriorRings(geos: Geos, g: Geometry): number {
  g.requireSame(geos);
  const n = geos.native.geos.GEOSGetNumInteriorRings_r(geos.ctx, g.ptr);
  if (n < 0) throw geos.fail("GEOSGetNumInteriorRings_r");
  return n;
}

/** Exterior ring of a polygon — a BORROWED view. */
export function exteriorRing(geos: Geos, g: Geometry): Geometry {
  g.requireSame(geos);
  return geos.borrow(
    geos.native.geos.GEOSGetExteriorRing_r(geos.ctx, g.ptr) as GeomPtr | null,
    "GEOSGetExteriorRing_r",
    g,
  );
}

/** n-th interior ring of a polygon — a BORROWED view. */
export function interiorRingN(geos: Geos, g: Geometry, n: number): Geometry {
  g.requireSame(geos);
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`interiorRingN: index must be a non-negative integer, got ${n}`);
  }
  return geos.borrow(
    geos.native.geos.GEOSGetInteriorRingN_r(geos.ctx, g.ptr, n) as GeomPtr | null,
    "GEOSGetInteriorRingN_r",
    g,
  );
}

export function numPoints(geos: Geos, g: Geometry): number {
  g.requireSame(geos);
  const n = geos.native.geos.GEOSGeomGetNumPoints_r(geos.ctx, g.ptr);
  if (n < 0) throw geos.fail("GEOSGeomGetNumPoints_r");
  return n;
}

/** Validity — also the property-test oracle (M8); the repair suite is Phase 2. */
export function isValid(geos: Geos, g: Geometry): boolean {
  g.requireSame(geos);
  const r = geos.native.geos.GEOSisValid_r(geos.ctx, g.ptr) & 0xff; // char return
  if (r === 2) throw geos.fail("GEOSisValid_r");
  return r === 1;
}

/** SRID carried natively by GEOS (`GEOSGetSRID_r`); 0 means "unset" → null. */
export function sridOf(geos: Geos, g: Geometry): number | null {
  g.requireSame(geos);
  const srid = geos.native.geos.GEOSGetSRID_r(geos.ctx, g.ptr);
  if (srid < 0) throw geos.fail("GEOSGetSRID_r");
  return srid === 0 ? null : srid;
}

/** Set (or clear, with null) the SRID — mutates the geometry in place. */
export function setSrid(geos: Geos, g: Geometry, srid: number | null): void {
  g.requireSame(geos);
  geos.native.geos.GEOSSetSRID_r(geos.ctx, g.ptr, srid ?? 0);
}

/** Copy one coordinate sequence out to a fresh interleaved buffer (D9). */
export function readCoordSeq(
  geos: Geos,
  cs: CoordSeqPtr | null,
  hasZ: boolean,
  hasM: boolean,
  op: string,
): Float64Array {
  if (cs === null) throw geos.fail(op);
  const sizeOut = new Uint32Array(1);
  if (geos.native.geos.GEOSCoordSeq_getSize_r(geos.ctx, cs, sizeOut) === 0) {
    throw geos.fail("GEOSCoordSeq_getSize_r");
  }
  const n = sizeOut[0]!;
  const out = new Float64Array(n * (2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0)));
  if (
    geos.native.geos.GEOSCoordSeq_copyToBuffer_r(geos.ctx, cs, out, hasZ ? 1 : 0, hasM ? 1 : 0) ===
    0
  ) {
    throw geos.fail("GEOSCoordSeq_copyToBuffer_r");
  }
  return out;
}

/**
 * First coordinate sequence of a geometry, descending collections/polygons
 * so `hasZ`/`hasM` detection works everywhere (io.md §6: the 3.14
 * `CoordSeq_hasZ/hasM` accessors distinguish XYZ from XYM).
 */
function firstCoordSeq(geos: Geos, g: Geometry, depth = 0): CoordSeqPtr | null {
  if (depth > 8) return null;
  const typeId = geomTypeId(geos, g);
  const ops = geos.native.geos;
  switch (typeId) {
    case GeoType.Point:
    case GeoType.LineString:
    case GeoType.LinearRing:
      return ops.GEOSGeom_getCoordSeq_r(geos.ctx, g.ptr) as CoordSeqPtr | null;
    case GeoType.Polygon: {
      const ring = exteriorRing(geos, g);
      return ops.GEOSGeom_getCoordSeq_r(geos.ctx, ring.ptr) as CoordSeqPtr | null;
    }
    default: {
      if (numGeometries(geos, g) === 0) return null;
      const sub = getGeometryN(geos, g, 0);
      return firstCoordSeq(geos, sub, depth + 1);
    }
  }
}

export function dimensionsOf(geos: Geos, g: Geometry): { hasZ: boolean; hasM: boolean } {
  g.requireSame(geos);
  const cs = firstCoordSeq(geos, g);
  if (cs === null) return { hasZ: false, hasM: false };
  const ops = geos.native.geos;
  // char returns — mask (see predicates.charResult)
  const z = ops.GEOSCoordSeq_hasZ_r(geos.ctx, cs) & 0xff;
  const m = ops.GEOSCoordSeq_hasM_r(geos.ctx, cs) & 0xff;
  if (z === 2 || m === 2) throw geos.fail("GEOSCoordSeq_hasZ_r");
  return { hasZ: z === 1, hasM: m === 1 };
}

/**
 * Coordinates of a point/linestring/linearring as the canonical FlatCoords.
 * For polygons and collections use `toArrow()` / `toGeoJSON()`.
 */
export function coordinates(geos: Geos, g: Geometry): FlatCoords {
  g.requireSame(geos);
  const typeId = geomTypeId(geos, g);
  if (typeId !== GeoType.Point && typeId !== GeoType.LineString && typeId !== GeoType.LinearRing) {
    throw new GeosError(
      "coordinates",
      `only defined for point/linestring geometries (got type id ${typeId}) — use toArrow()/toGeoJSON()`,
    );
  }
  const cs = geos.native.geos.GEOSGeom_getCoordSeq_r(geos.ctx, g.ptr) as CoordSeqPtr | null;
  if (cs === null) throw geos.fail("GEOSGeom_getCoordSeq_r");
  const { hasZ, hasM } = dimensionsOf(geos, g);
  const coords = readCoordSeq(geos, cs, hasZ, hasM, "GEOSCoordSeq_copyToBuffer_r");
  return { coords, n: coords.length / (2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0)), hasZ, hasM };
}
