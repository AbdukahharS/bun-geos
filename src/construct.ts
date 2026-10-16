/**
 * Geometry construction from the canonical flat buffers (io.md §1, D9) via
 * the shim's batch builders — one FFI crossing per ring set / collection,
 * never per ring (D4).
 *
 * Data errors throw `GeosError` with structural detail — ring and vertex
 * indices, not C-level "ParseException" text (D13).
 *
 * Ring-closure policy (frozen M5, documented in io docs): polygon rings are
 * NORMALIZED on input — unclosed rings are closed by appending a copy of the
 * first coordinate; rings with fewer than 3 distinct positions are rejected.
 * Output (WKT/WKB/GeoJSON) preserves what GEOS holds.
 */
import type { Arena } from "./arena.ts";
import { GeosError } from "./errors.ts";
import type { Geos } from "./geos.ts";
import type { CollectionKind, FlatCoords, GeomPtr, GeoTypeId, Polygonal } from "./types.ts";
import { collectionTypeId, GeoType, geoTypeName } from "./types.ts";

export interface FromPartsOptions {
  /**
   * `false` (default): parts are cloned into the collection — the caller's
   * geometries stay alive (non-destructive API). `true`: ownership of the
   * parts transfers to the collection and the caller's wrappers become
   * spent (hot-path opt-out; matches raw GEOS transfer semantics).
   */
  transfer?: boolean;
}

function dimOf(hasZ: boolean, hasM: boolean): number {
  return 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
}

/** Build the u64 pointer array GEOS consumes for collections. */
export function ptrArray(ptrs: readonly GeomPtr[]): BigUint64Array {
  const out = new BigUint64Array(ptrs.length);
  for (let i = 0; i < ptrs.length; i++) out[i] = BigInt(ptrs[i]!);
  return out;
}

/** Validate + normalize `FlatCoords`; returns the dimension stride. */
function checkFlat(spec: FlatCoords, op: string, minN: number, what: string): number {
  const dim = dimOf(spec.hasZ, spec.hasM);
  if (!Number.isInteger(spec.n) || spec.n < minN) {
    throw new GeosError(op, `${what} needs at least ${minN} position(s), got ${spec.n}`);
  }
  if (spec.coords.length !== spec.n * dim) {
    throw new GeosError(
      op,
      `coords length ${spec.coords.length} != n * stride (${spec.n} × ${dim})`,
    );
  }
  for (let i = 0; i < spec.n; i++) {
    // Every ordinate lane must be finite — X, Y, Z and M alike (audit M1:
    // Z/M NaN used to slip past and GEOS reports such points as valid).
    for (let d = 0; d < dim; d++) {
      const v = spec.coords[i * dim + d];
      if (!Number.isFinite(v)) {
        throw new GeosError(op, `${what} position ${i} ordinate ${d} is not finite`, { vertex: i });
      }
    }
  }
  return dim;
}

/**
 * Build a Point or LineString from flat coordinates.
 * `kind` defaults to `"linestring"`.
 */
export function fromCoords(
  geos: Geos,
  spec: FlatCoords,
  kind: "point" | "linestring" = "linestring",
  arena?: Arena,
): import("./geometry.ts").Geometry {
  if (kind === "point") {
    checkFlat(spec, "GEOSGeom_createPoint_r", 1, "point");
    const cs = geos.native.geos.GEOSCoordSeq_copyFromBuffer_r(
      geos.ctx,
      spec.coords,
      spec.n,
      spec.hasZ ? 1 : 0,
      spec.hasM ? 1 : 0,
    );
    if (cs === null) throw geos.fail("GEOSCoordSeq_copyFromBuffer_r");
    const g = geos.native.geos.GEOSGeom_createPoint_r(geos.ctx, cs);
    if (g === null) {
      // Same GEOS quirk class as createLineString (see native/shim.c): the
      // coordseq moved into a unique_ptr before construction — on failure
      // GEOS has consumed it; do not destroy (double free).
      throw geos.fail("GEOSGeom_createPoint_r");
    }
    return geos.take("GEOSGeom_createPoint_r", g as GeomPtr, arena ?? undefined);
  }
  checkFlat(spec, "geos_shim_build_linestring", 2, "linestring");
  const g = geos.native.shim.geos_shim_build_linestring(
    geos.shim,
    spec.coords,
    spec.n,
    spec.hasZ ? 1 : 0,
    spec.hasM ? 1 : 0,
  );
  return geos.take("geos_shim_build_linestring", g as GeomPtr | null, arena ?? undefined);
}

/**
 * Check ring/part offsets and ring sizes; returns the per-ring coordinate
 * ranges. `ringOffsets[j]` is the end-coordinate of ring j; a ring must hold
 * ≥ 3 distinct positions (it will be closed to GEOS's required 4).
 */
function checkPolygonal(spec: Polygonal, op: string): { dim: number; n: number } {
  const dim = dimOf(spec.hasZ, spec.hasM);
  const { coords, ringOffsets, partOffsets } = spec;
  if (ringOffsets.length === 0) {
    throw new GeosError(op, "polygon needs at least one ring", { ring: 0 });
  }
  let prev = 0;
  for (let r = 0; r < ringOffsets.length; r++) {
    const end: number = ringOffsets[r]!;
    if (!Number.isInteger(end) || end <= prev) {
      throw new GeosError(
        op,
        `ringOffsets must be strictly increasing (ring ${r}: ${end} <= ${prev})`,
        { ring: r },
      );
    }
    if (end - prev < 3) {
      throw new GeosError(op, `ring ${r} has ${end - prev} positions; need ≥ 3`, { ring: r });
    }
    prev = end;
  }
  const n: number = ringOffsets[ringOffsets.length - 1]!;
  if (coords.length !== n * dim) {
    throw new GeosError(
      op,
      `coords length ${coords.length} != coordinate count × stride (${n} × ${dim})`,
    );
  }
  let prevPart = 0;
  for (let p = 0; p < partOffsets.length; p++) {
    const end: number = partOffsets[p]!;
    if (!Number.isInteger(end) || end <= prevPart) {
      throw new GeosError(op, `partOffsets must be strictly increasing (part ${p})`);
    }
    prevPart = end;
  }
  if (partOffsets[partOffsets.length - 1] !== ringOffsets.length) {
    throw new GeosError(
      op,
      `partOffsets must end at the ring count (${partOffsets[partOffsets.length - 1]} != ${ringOffsets.length})`,
    );
  }
  // Every ordinate lane must be finite — X, Y, Z and M alike (audit M1).
  for (let c = 0; c < n; c++) {
    for (let d = 0; d < dim; d++) {
      if (!Number.isFinite(coords[c * dim + d])) {
        // Locate the owning ring for the precise message (D13).
        let ring = 0;
        while (ring < ringOffsets.length && ringOffsets[ring]! <= c) ring++;
        throw new GeosError(op, `coordinate ${c} ordinate ${d} is not finite`, { ring, vertex: c });
      }
    }
  }
  return { dim, n };
}

/**
 * Close unclosed rings (policy: normalize on input). Returns the coord
 * buffer plus u32 end-offsets ready for the shim; zero-copy when every ring
 * is already closed and the offsets are u32-clean.
 */
function closedRings(
  spec: Polygonal,
  dim: number,
): { coords: Float64Array; ringOffsets: Uint32Array } {
  const { coords, ringOffsets } = spec;
  let unclosed = 0;
  let prev = 0;
  for (let r = 0; r < ringOffsets.length; r++) {
    const end: number = ringOffsets[r]!;
    const first = prev * dim;
    const last = (end - 1) * dim;
    if (coords[first] !== coords[last] || coords[first + 1] !== coords[last + 1]) unclosed++;
    prev = end;
  }
  if (unclosed === 0) {
    const u32 = new Uint32Array(ringOffsets.length);
    for (let i = 0; i < ringOffsets.length; i++) u32[i] = ringOffsets[i]!;
    return { coords, ringOffsets: u32 };
  }
  // Rebuild with closures inserted.
  const totalCoords = ringOffsets[ringOffsets.length - 1]! + unclosed;
  const out = new Float64Array(totalCoords * dim);
  const offs = new Uint32Array(ringOffsets.length);
  let dst = 0;
  prev = 0;
  for (let r = 0; r < ringOffsets.length; r++) {
    const end: number = ringOffsets[r]!;
    const ringStart = dst;
    for (let c = prev; c < end; c++) {
      for (let d = 0; d < dim; d++) out[dst * dim + d] = coords[c * dim + d]!;
      dst++;
    }
    // Closure compares and copies from THIS ring's start in `out` (not the
    // previous ring's start — that was the bug that produced unclosed rings).
    const first = ringStart * dim;
    const last = (dst - 1) * dim;
    if (out[first] !== out[last] || out[first + 1] !== out[last + 1]) {
      for (let d = 0; d < dim; d++) out[dst * dim + d] = out[first + d]!;
      dst++;
    }
    offs[r] = dst;
    prev = end;
  }
  return { coords: out, ringOffsets: offs };
}

/**
 * Build a Polygon (single part) or MultiPolygon (multiple parts) from
 * concatenated rings + offsets. Ring 0 of each part is the shell; the rest
 * are holes.
 */
export function fromPolygonal(geos: Geos, spec: Polygonal): import("./geometry.ts").Geometry {
  const op = "geos_shim_build_polygon";
  const { dim } = checkPolygonal(spec, op);
  const closed = closedRings(spec, dim);
  const isMulti = spec.partOffsets.length > 1;
  if (!isMulti) {
    const g = geos.native.shim.geos_shim_build_polygon(
      geos.shim,
      closed.coords,
      closed.ringOffsets,
      closed.ringOffsets.length,
      spec.hasZ ? 1 : 0,
      spec.hasM ? 1 : 0,
    );
    return geos.take(op, g as GeomPtr | null);
  }
  // MultiPolygon: one build_polygon crossing per part, then a collection.
  const parts: GeomPtr[] = [];
  try {
    for (let p = 0; p < spec.partOffsets.length; p++) {
      const ringEnd: number = spec.partOffsets[p]!;
      const firstRing = p === 0 ? 0 : spec.partOffsets[p - 1]!;
      const partOffsets = closed.ringOffsets.slice(firstRing, ringEnd);
      const startCoord = firstRing === 0 ? 0 : closed.ringOffsets[firstRing - 1]!;
      const view = new Uint32Array(partOffsets.length);
      for (let i = 0; i < partOffsets.length; i++) view[i] = partOffsets[i]! - startCoord;
      const sub = geos.native.shim.geos_shim_build_polygon(
        geos.shim,
        closed.coords.subarray(startCoord * dim),
        view,
        view.length,
        spec.hasZ ? 1 : 0,
        spec.hasM ? 1 : 0,
      );
      if (sub === null) throw geos.fail(op);
      parts.push(sub as GeomPtr);
    }
  } catch (err) {
    // Parts built so far are ours (build_polygon hands ownership to JS) and
    // deliberately unregistered — raw teardown via the sanctioned helper.
    for (const p of parts) geos.destroyRaw(p);
    throw err;
  }
  const col = geos.native.shim.geos_shim_build_collection(
    geos.shim,
    GeoType.MultiPolygon,
    ptrArray(parts),
    parts.length,
  );
  return geos.take("geos_shim_build_collection", col as GeomPtr | null);
}

/**
 * Build a collection (multipoint / multilinestring / multipolygon /
 * geometrycollection) from existing geometries.
 *
 * By default the parts are CLONED into the collection (non-destructive);
 * pass `{ transfer: true }` to move them (the callers' wrappers become
 * spent — raw GEOS semantics, for hot paths).
 */
export function fromParts(
  geos: Geos,
  kind: CollectionKind,
  parts: import("./geometry.ts").Geometry[],
  opts: FromPartsOptions = {},
): import("./geometry.ts").Geometry {
  const typeId: GeoTypeId = collectionTypeId(kind);
  if (parts.length === 0) {
    const g = geos.native.geos.GEOSGeom_createEmptyCollection_r(geos.ctx, typeId);
    return geos.take("GEOSGeom_createEmptyCollection_r", g as GeomPtr | null);
  }
  for (const p of parts) {
    p.requireSame(geos);
  }
  const transfer = opts.transfer === true;
  // Type-check homogeneous collections at the boundary (D13): GEOS 3.14
  // does NOT validate member types at createCollection — a multipolygon of
  // points builds fine and misbehaves downstream.
  const expectedPartType: GeoTypeId | null =
    kind === "multipoint"
      ? GeoType.Point
      : kind === "multilinestring"
        ? GeoType.LineString
        : kind === "multipolygon"
          ? GeoType.Polygon
          : null; // geometrycollection: anything goes
  if (expectedPartType !== null) {
    for (let i = 0; i < parts.length; i++) {
      const actual = geos.typeId(parts[i]!);
      if (actual !== expectedPartType) {
        throw new TypeError(
          `fromParts: ${kind} part ${i} is a ${geoTypeName(actual)}, expected ${geoTypeName(expectedPartType)} — use "geometrycollection" for heterogeneous parts`,
        );
      }
    }
  }
  if (transfer) {
    // Audit C2: in transfer mode the raw pointers are handed to GEOS, which
    // stores them in unique_ptr slots — duplicates would be freed twice, and
    // a borrowed view's pointer is still owned by its parent.
    const seen = new Set<GeomPtr>();
    for (const p of parts) {
      if (!p.owned) {
        throw new TypeError(
          "fromParts: transfer:true requires owned geometries — a borrowed view does not own its pointer (clone it first or drop transfer)",
        );
      }
      if (seen.has(p.ptr)) {
        throw new TypeError(
          "fromParts: duplicate geometry with transfer:true — GEOS would free the same pointer twice (drop transfer to alias, or clone)",
        );
      }
      seen.add(p.ptr);
    }
  }
  const ptrs: GeomPtr[] = [];
  if (transfer) {
    for (const p of parts) ptrs.push(p.ptr);
  } else {
    for (const p of parts) {
      const c = geos.native.geos.GEOSGeom_clone_r(geos.ctx, p.ptr);
      if (c === null) {
        // Clean up clones built so far (audit finding: they leaked here).
        for (const made of ptrs) geos.destroyRaw(made);
        throw geos.fail("GEOSGeom_clone_r");
      }
      ptrs.push(c as GeomPtr);
    }
  }
  const col = geos.native.shim.geos_shim_build_collection(
    geos.shim,
    typeId,
    ptrArray(ptrs),
    ptrs.length,
  );
  // GEOS consumed the parts on success AND on failure (the verified quirk —
  // shim.md rule 1), so renounce BEFORE take(): take throws when col is
  // null, and the caller's wrappers must be spent in that case too (audit C2).
  if (transfer) {
    for (const p of parts) p.renounce();
  }
  return geos.take("geos_shim_build_collection", col as GeomPtr | null);
}

export type EmptyKind = CollectionKind | "point" | "linestring" | "polygon";

/** Build a typed empty geometry (`POLYGON EMPTY` etc. — io.md §3). */
export function empty(
  geos: Geos,
  kind: EmptyKind,
  arena?: Arena,
): import("./geometry.ts").Geometry {
  switch (kind) {
    case "point": {
      const g = geos.native.geos.GEOSGeom_createEmptyPoint_r(geos.ctx);
      return geos.take("GEOSGeom_createEmptyPoint_r", g as GeomPtr | null, arena ?? undefined);
    }
    case "linestring": {
      const g = geos.native.geos.GEOSGeom_createEmptyLineString_r(geos.ctx);
      return geos.take("GEOSGeom_createEmptyLineString_r", g as GeomPtr | null, arena ?? undefined);
    }
    case "polygon": {
      const g = geos.native.geos.GEOSGeom_createEmptyPolygon_r(geos.ctx);
      return geos.take("GEOSGeom_createEmptyPolygon_r", g as GeomPtr | null, arena ?? undefined);
    }
    default: {
      const g = geos.native.geos.GEOSGeom_createEmptyCollection_r(geos.ctx, collectionTypeId(kind));
      return geos.take("GEOSGeom_createEmptyCollection_r", g as GeomPtr | null, arena ?? undefined);
    }
  }
}
