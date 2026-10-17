/**
 * GeoArrow-shaped interchange (io.md §5; Phase 5 shapes v2 — D28).
 *
 * The tagged shapes in types.ts mirror the GeoArrow spec: `kind` names the
 * extension type (`geoarrow.<kind>`), offsets mirror the spec's list
 * nesting over the interleaved coordinate buffer (the spec's
 * coord-fixed-size-list / interop profile), and `validity` is the Arrow
 * LSB null bitmap. Member rule across kinds: the multi* kinds' MEMBERS are
 * their leaf geometries — a single geometry reads all members as one
 * MULTI*, and a batch treats each member as one slot. Empty MULTI* are
 * representable (length-0 offsets, or a repeated offset for an empty
 * member); `geometrycollection` is the dense-union emulation
 * (`types`/`offsets` into `children`).
 *
 * The Phase 1 untagged shapes (FlatCoords/LineArray/Polygonal) remain
 * accepted everywhere as LEGACY input, inferred by shape. `toArrow` emits
 * tagged values only, never a validity bitmap (GEOS has no null geometry).
 * Null slots: `fromArrow` rejects them (a singular geometry cannot be
 * null); `geometriesFromArrow` honors `nullMode` ("throw" default, "skip"
 * omits — a cardinality change documented loudly for ingest paths).
 *
 * Conformance to the canonical spec bytes is differential: golden buffers
 * generated from a reference implementation (scripts/geoarrow-goldens.py,
 * geoarrow-pyarrow) are parsed and round-tripped in
 * test/differential/geoarrow-goldens.test.ts.
 */
import type { Arena } from "../arena.ts";
import { fromCoords, fromParts, fromPolygonal } from "../construct.ts";
import { GeosError } from "../errors.ts";
import type { Geometry } from "../geometry.ts";
import type { Geos } from "../geos.ts";
import {
  coordinates,
  dimensionsOf,
  geomTypeId,
  isEmpty,
  numGeometries,
  numInteriorRings,
} from "../ops/accessors.ts";
import type {
  ArrowArray,
  ArrowInput,
  FlatCoords,
  GeomPtr,
  GeoTypeId,
  LineArray,
  LineStringArray,
  MultiLineStringArray,
  MultiPointArray,
  MultiPolygonArray,
  PointArray,
  PolygonArray,
  Polygonal,
} from "../types.ts";
import { GeoType } from "../types.ts";

export interface FromArrowOptions {
  /**
   * Batch-slot null handling (validity bitmaps): "throw" (default) rejects
   * the first null with its slot index; "skip" OMITS null slots — the
   * output is shorter than the slot count, so downstream masks must be
   * compensated by the caller.
   */
  nullMode?: "throw" | "skip";
}

function hasKind(arr: ArrowInput): arr is ArrowArray {
  return "kind" in arr;
}

function strideOf(hasZ: boolean, hasM: boolean): number {
  return 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
}

/** Popcount of NULLED slots in an Arrow LSB validity bitmap. */
export function validityNullCount(validity: Uint8Array | undefined, n: number): number {
  if (validity === undefined) return 0;
  let nulls = 0;
  for (let i = 0; i < n; i++) {
    if ((validity[i >> 3]! & (1 << (i & 7))) === 0) nulls++;
  }
  return nulls;
}

function isValidSlot(validity: Uint8Array | undefined, i: number): boolean {
  return validity === undefined || (validity[i >> 3]! & (1 << (i & 7))) !== 0;
}

function checkValidityLength(
  op: string,
  field: string,
  validity: Uint8Array | undefined,
  n: number,
): void {
  if (validity === undefined) return;
  if (validity.length < (n + 7) >> 3) {
    throw new GeosError(
      op,
      `validity bitmap too short for ${n} slots (${field}: ${validity.length} bytes, need ${(n + 7) >> 3})`,
    );
  }
}

/** STRICTLY-increasing offset validation (rings/parts/lines: an empty slot
 * is a data error for these). */
function checkOffsets(
  op: string,
  field: string,
  offsets: Int32Array,
  limit: number,
  scale: number,
): void {
  let prev = 0;
  for (let i = 0; i < offsets.length; i++) {
    const end = offsets[i]!;
    if (end <= prev) {
      throw new GeosError(op, `${field} must increase from 0 (${field}[${i}] = ${end} <= ${prev})`);
    }
    prev = end;
  }
  if (prev * scale > limit) {
    throw new GeosError(op, `coords length ${limit} < last ${field} × stride (${prev} × ${scale})`);
  }
}

/** NON-decreasing offset validation (point slots: a repeated offset is a
 * legitimate POINT EMPTY member — Arrow list offsets are non-decreasing). */
function checkPointOffsets(op: string, offsets: Int32Array, limit: number, scale: number): void {
  let prev = 0;
  for (let i = 0; i < offsets.length; i++) {
    const end = offsets[i]!;
    if (end < prev) {
      throw new GeosError(
        op,
        `pointOffsets must be non-decreasing (pointOffsets[${i}] = ${end} < ${prev})`,
      );
    }
    prev = end;
  }
  if (prev * scale > limit) {
    throw new GeosError(
      op,
      `coords length ${limit} < last pointOffsets × stride (${prev} × ${scale})`,
    );
  }
}

/* ── legacy inference (Phase 1–3 shapes) ────────────────────────────────── */

function inferLegacy(arr: Exclude<ArrowInput, ArrowArray>): ArrowArray {
  if ("lineOffsets" in arr) {
    const lines: LineStringArray | MultiLineStringArray =
      arr.lineOffsets.length === 1
        ? {
            kind: "linestring",
            coords: arr.coords,
            lineOffsets: arr.lineOffsets,
            hasZ: arr.hasZ,
            hasM: arr.hasM,
          }
        : {
            kind: "multilinestring",
            coords: arr.coords,
            lineOffsets: arr.lineOffsets,
            hasZ: arr.hasZ,
            hasM: arr.hasM,
          };
    return lines;
  }
  if ("ringOffsets" in arr) {
    const polys: PolygonArray | MultiPolygonArray =
      arr.partOffsets.length === 1
        ? {
            kind: "polygon",
            coords: arr.coords,
            ringOffsets: arr.ringOffsets,
            hasZ: arr.hasZ,
            hasM: arr.hasM,
          }
        : {
            kind: "multipolygon",
            coords: arr.coords,
            ringOffsets: arr.ringOffsets,
            partOffsets: arr.partOffsets,
            hasZ: arr.hasZ,
            hasM: arr.hasM,
          };
    return polys;
  }
  // FlatCoords: n=1 → point, n=0 → POINT EMPTY (point), n>1 → multipoint
  const points: PointArray | MultiPointArray =
    arr.n === 1
      ? { kind: "point", coords: arr.coords, hasZ: arr.hasZ, hasM: arr.hasM }
      : {
          kind: "multipoint",
          coords: arr.coords,
          pointOffsets: Int32Array.from({ length: arr.n }, (_, i) => i + 1),
          hasZ: arr.hasZ,
          hasM: arr.hasM,
        };
  return points;
}

/** Build one line from coords[start..end) — the common per-member primitive. */
function lineFromRange(
  geos: Geos,
  coords: Float64Array,
  start: number,
  end: number,
  hasZ: boolean,
  hasM: boolean,
  op: string,
  index: number,
  arena?: Arena,
): Geometry {
  const stride = strideOf(hasZ, hasM);
  const n = end - start;
  if (n < 2) {
    throw new GeosError(op, `line ${index} has ${n} positions; need ≥ 2`, {
      jsonPath: `lineOffsets[${index}]`,
    });
  }
  return fromCoords(
    geos,
    { coords: coords.subarray(start * stride, end * stride), n, hasZ, hasM },
    "linestring",
    arena,
  );
}

/* ── singular path ──────────────────────────────────────────────────────── */

/** Build a geometry from a GeoArrow-shaped value (validate; one crossing per part). */
export function fromArrow(geos: Geos, input: ArrowInput): Geometry {
  geos.assertOpen("fromArrow");
  const arr = hasKind(input) ? input : inferLegacy(input);
  const op = "fromArrow";
  switch (arr.kind) {
    case "point": {
      if (arr.coords.length === 0) return geos.empty("point");
      const stride = strideOf(arr.hasZ, arr.hasM);
      if (arr.coords.length !== stride) {
        throw new GeosError(op, `point coords length ${arr.coords.length} != stride ${stride}`);
      }
      return fromCoords(
        geos,
        { coords: arr.coords, n: 1, hasZ: arr.hasZ, hasM: arr.hasM },
        "point",
      );
    }
    case "linestring": {
      if (arr.lineOffsets.length !== 1) {
        throw new GeosError(op, "linestring lineOffsets must have length 1");
      }
      return lineFromRange(geos, arr.coords, 0, arr.lineOffsets[0]!, arr.hasZ, arr.hasM, op, 0);
    }
    case "polygon": {
      if (arr.coords.length === 0) return geos.empty("polygon");
      return fromPolygonal(geos, {
        coords: arr.coords,
        ringOffsets: arr.ringOffsets,
        partOffsets: Int32Array.of(arr.ringOffsets.length),
        hasZ: arr.hasZ,
        hasM: arr.hasM,
      });
    }
    case "multipoint": {
      if (validityNullCount(arr.validity, arr.pointOffsets.length) > 0) {
        throw new GeosError(op, "null slot in a singular Arrow value (use the batch entry point)");
      }
      if (arr.pointOffsets.length === 0) return geos.empty("multipoint");
      const members = pointMembers(geos, arr.coords, arr.pointOffsets, arr.hasZ, arr.hasM, op);
      const built = members.filter((m): m is Geometry => m !== null);
      if (built.length === 1 && arr.pointOffsets.length === 1) return built[0]!;
      return fromParts(geos, "multipoint", built, { transfer: true });
    }
    case "multilinestring": {
      if (validityNullCount(arr.validity, arr.lineOffsets.length) > 0) {
        throw new GeosError(op, "null slot in a singular Arrow value (use the batch entry point)");
      }
      if (arr.lineOffsets.length === 0) return geos.empty("multilinestring");
      checkOffsets(
        op,
        "lineOffsets",
        arr.lineOffsets,
        arr.coords.length,
        strideOf(arr.hasZ, arr.hasM),
      );
      const members: Geometry[] = [];
      let start = 0;
      for (let l = 0; l < arr.lineOffsets.length; l++) {
        members.push(
          lineFromRange(geos, arr.coords, start, arr.lineOffsets[l]!, arr.hasZ, arr.hasM, op, l),
        );
        start = arr.lineOffsets[l]!;
      }
      if (members.length === 1) return members[0]!;
      return fromParts(geos, "multilinestring", members, { transfer: true });
    }
    case "multipolygon": {
      if (validityNullCount(arr.validity, arr.partOffsets.length) > 0) {
        throw new GeosError(op, "null slot in a singular Arrow value (use the batch entry point)");
      }
      if (arr.partOffsets.length === 0) return geos.empty("multipolygon");
      return fromPolygonal(geos, {
        coords: arr.coords,
        ringOffsets: arr.ringOffsets,
        partOffsets: arr.partOffsets,
        hasZ: arr.hasZ,
        hasM: arr.hasM,
      });
    }
    case "geometrycollection": {
      if (validityNullCount(arr.validity, arr.types.length) > 0) {
        throw new GeosError(op, "null slot in a singular Arrow value (use the batch entry point)");
      }
      const members = gcFromArrow(geos, arr, undefined, "throw");
      if (members.length === 0) return geos.empty("geometrycollection");
      return fromParts(geos, "geometrycollection", members, { transfer: true });
    }
  }
}

/* ── batch path (members = slots) ───────────────────────────────────────── */

/**
 * Expand one Arrow-shaped value into its member geometries — the batch
 * item array (api-surface Phase 3 note). Tagged kinds contribute their
 * members; legacy shapes keep the Phase 3 inference. Null slots follow
 * `opts.nullMode`.
 *
 * `arena` — where the built geometries register. Callers that dispose the
 * batch inputs themselves (the pool's UNPUSHED arena, `withBatchInputsAsync`)
 * MUST pass it explicitly (audited N1).
 */
export function geometriesFromArrow(
  geos: Geos,
  input: ArrowInput,
  arena?: Arena,
  opts: FromArrowOptions = {},
): Geometry[] {
  geos.assertOpen("geometriesFromArrow");
  const arr = hasKind(input) ? input : inferLegacy(input);
  const op = "geometriesFromArrow";
  const outArena = arena ?? undefined;
  const nullMode = opts.nullMode ?? "throw";
  switch (arr.kind) {
    case "point":
      return [
        fromCoords(
          geos,
          { coords: arr.coords, n: 1, hasZ: arr.hasZ, hasM: arr.hasM },
          "point",
          outArena,
        ),
      ];
    case "linestring": {
      if (arr.lineOffsets.length !== 1) {
        throw new GeosError(op, "linestring lineOffsets must have length 1");
      }
      return [
        lineFromRange(
          geos,
          arr.coords,
          0,
          arr.lineOffsets[0]!,
          arr.hasZ,
          arr.hasM,
          op,
          0,
          outArena,
        ),
      ];
    }
    case "polygon": {
      if (arr.coords.length === 0) return [geos.empty("polygon", outArena)];
      return polygonMembers(
        geos,
        arr.coords,
        arr.ringOffsets,
        Int32Array.of(arr.ringOffsets.length),
        arr.hasZ,
        arr.hasM,
        outArena,
        op,
      );
    }
    case "multipoint": {
      checkValidityLength(op, "pointOffsets", arr.validity, arr.pointOffsets.length);
      if (nullMode === "throw" && validityNullCount(arr.validity, arr.pointOffsets.length) > 0) {
        for (let i = 0; ; i++) {
          if (!isValidSlot(arr.validity, i)) {
            throw new GeosError(op, `null geometry slot ${i} (nullMode "throw")`);
          }
        }
      }
      if (arr.pointOffsets.length === 0) return [];
      // validity passes into the builder: null slots are never constructed
      // (their coord slots may hold padding, even NaN)
      const members = pointMembers(
        geos,
        arr.coords,
        arr.pointOffsets,
        arr.hasZ,
        arr.hasM,
        op,
        arr.validity,
      );
      if (arr.validity === undefined) return members as Geometry[]; // no validity → no null slots
      const out: Geometry[] = [];
      for (const m of members) {
        if (m !== null) out.push(m);
      }
      return out;
    }
    case "multilinestring": {
      checkValidityLength(op, "lineOffsets", arr.validity, arr.lineOffsets.length);
      const members = lineMembers(
        geos,
        arr.coords,
        arr.lineOffsets,
        arr.hasZ,
        arr.hasM,
        op,
        outArena,
      );
      if (arr.validity === undefined) return members;
      const out: Geometry[] = [];
      for (let i = 0; i < members.length; i++) {
        if (isValidSlot(arr.validity, i)) out.push(members[i]!);
        else members[i]!.dispose();
      }
      return out;
    }
    case "multipolygon": {
      checkValidityLength(op, "partOffsets", arr.validity, arr.partOffsets.length);
      if (nullMode === "throw" && validityNullCount(arr.validity, arr.partOffsets.length) > 0) {
        for (let i = 0; ; i++) {
          if (!isValidSlot(arr.validity, i)) {
            throw new GeosError(op, `null geometry slot ${i} (nullMode "throw")`);
          }
        }
      }
      const members = polygonMembers(
        geos,
        arr.coords,
        arr.ringOffsets,
        arr.partOffsets,
        arr.hasZ,
        arr.hasM,
        outArena,
        op,
      );
      if (arr.validity === undefined) return members;
      const out: Geometry[] = [];
      for (let i = 0; i < members.length; i++) {
        if (isValidSlot(arr.validity, i)) out.push(members[i]!);
        else members[i]!.dispose();
      }
      return out;
    }
    case "geometrycollection":
      return gcFromArrow(geos, arr, outArena, nullMode);
  }
}

/* ── GC (dense union) ───────────────────────────────────────────────────── */

/** Batch-shaped GC expansion (picked members; unreferenced members disposed). */
function gcFromArrow(
  geos: Geos,
  arr: Extract<ArrowArray, { kind: "geometrycollection" }>,
  outArena: Arena | undefined,
  nullMode: "throw" | "skip",
): Geometry[] {
  const op = "geometrycollection";
  const n = arr.types.length;
  checkValidityLength(op, "types", arr.validity, n);
  if (n === 0) return [];
  // Build each child's members ONCE, then pick slots in order.
  const built = arr.children.map((child) => {
    if (!hasKind(child)) throw new GeosError(op, "geometrycollection children must be tagged");
    if (child.kind === "geometrycollection") {
      throw new GeosError(op, "nested geometrycollection children are not representable");
    }
    return geometriesFromArrow(geos, child, outArena, { nullMode: "throw" });
  });
  const picked = new Set<string>();
  const out: Geometry[] = [];
  for (let i = 0; i < n; i++) {
    if (!isValidSlot(arr.validity, i)) {
      if (nullMode === "skip") continue;
      // all-or-nothing: dispose everything built before rethrowing
      for (const childMembers of built) {
        for (const m of childMembers) m.dispose();
      }
      throw new GeosError(op, `null geometry slot ${i} (nullMode "throw")`);
    }
    const childIdx = arr.types[i]!;
    const member = built[childIdx]?.[arr.offsets[i]!];
    if (member === undefined) {
      // all-or-nothing: dispose everything built before rethrowing
      for (const childMembers of built) {
        for (const m of childMembers) m.dispose();
      }
      throw new GeosError(
        op,
        `slot ${i} references child ${childIdx}[${arr.offsets[i]}] out of range (${built[childIdx]?.length ?? "no child"})`,
      );
    }
    picked.add(`${childIdx}:${arr.offsets[i]!}`);
    out.push(member);
  }
  // Members no slot references are disposed (ownership stays exact).
  for (let c = 0; c < built.length; c++) {
    for (let j = 0; j < built[c]!.length; j++) {
      if (!picked.has(`${c}:${j}`)) built[c]![j]!.dispose();
    }
  }
  return out;
}

/* ── member builders ────────────────────────────────────────────────────── */

function pointMembers(
  geos: Geos,
  coords: Float64Array,
  pointOffsets: Int32Array,
  hasZ: boolean,
  hasM: boolean,
  op: string,
  validity?: Uint8Array,
): (Geometry | null)[] {
  const stride = strideOf(hasZ, hasM);
  checkPointOffsets(op, pointOffsets, coords.length, stride);
  const out: (Geometry | null)[] = [];
  let start = 0;
  for (let i = 0; i < pointOffsets.length; i++) {
    const end = pointOffsets[i]!;
    if (!isValidSlot(validity, i)) {
      out.push(null); // null slot: never built (its coords may be padding)
      start = end;
      continue;
    }
    if (end === start) {
      out.push(geos.empty("point")); // repeated offset = POINT EMPTY member
      continue;
    }
    out.push(
      fromCoords(
        geos,
        { coords: coords.subarray(start * stride, end * stride), n: 1, hasZ, hasM },
        "point",
      ),
    );
    start = end;
  }
  return out;
}

function lineMembers(
  geos: Geos,
  coords: Float64Array,
  lineOffsets: Int32Array,
  hasZ: boolean,
  hasM: boolean,
  op: string,
  outArena?: Arena,
): Geometry[] {
  const n = lineOffsets.length;
  if (n === 0) return [];
  const stride = strideOf(hasZ, hasM);
  checkOffsets(op, "lineOffsets", lineOffsets, coords.length, stride);
  // ONE crossing via the shim's bulk builder (offsets are absolute, so a
  // preceding null slot's zero-width range simply contributes nothing).
  const out = new BigUint64Array(n);
  const r = geos.native.shim.geos_shim_build_linestrings_many(
    geos.shim,
    coords,
    lineOffsets,
    n,
    hasZ ? 1 : 0,
    hasM ? 1 : 0,
    out,
  );
  if (r !== 0) throw geos.fail("geos_shim_build_linestrings_many");
  return geos.takeMany("geos_shim_build_linestrings_many", out, outArena);
}

function polygonMembers(
  geos: Geos,
  coords: Float64Array,
  ringOffsets: Int32Array,
  partOffsets: Int32Array,
  hasZ: boolean,
  hasM: boolean,
  outArena: Arena | undefined,
  op: string,
): Geometry[] {
  if (ringOffsets.length === 0 || partOffsets.length === 0) {
    if (coords.length > 0) throw new GeosError(op, "empty offsets but non-empty coords");
    return outArena === undefined ? [geos.empty("polygon")] : [];
  }
  checkOffsets(op, "ringOffsets", ringOffsets, coords.length, strideOf(hasZ, hasM));
  let prevPart = 0;
  for (let i = 0; i < partOffsets.length; i++) {
    const end = partOffsets[i]!;
    if (end <= prevPart) {
      throw new GeosError(
        op,
        `partOffsets must increase from 0 (partOffsets[${i}] = ${end} <= ${prevPart})`,
      );
    }
    prevPart = end;
  }
  if (partOffsets[partOffsets.length - 1]! !== ringOffsets.length) {
    throw new GeosError(
      op,
      `partOffsets must end at the ring count (${partOffsets[partOffsets.length - 1]} != ${ringOffsets.length})`,
    );
  }
  const out = new BigUint64Array(partOffsets.length);
  const r = geos.native.shim.geos_shim_build_polygonal_many(
    geos.shim,
    coords,
    ringOffsets,
    ringOffsets.length,
    partOffsets,
    partOffsets.length,
    hasZ ? 1 : 0,
    hasM ? 1 : 0,
    out,
  );
  if (r !== 0) throw geos.fail("geos_shim_build_polygonal_many");
  return geos.takeMany("geos_shim_build_polygonal_many", out, outArena);
}

/* ── extraction (tagged output) ─────────────────────────────────────────── */

/** Extract a GeoArrow-shaped value from a geometry (tagged, D28). */
export function toArrow(geos: Geos, g: Geometry): ArrowArray {
  g.requireSame(geos);
  geos.assertOpen("toArrow");
  const typeId = geomTypeId(geos, g);
  switch (typeId) {
    case GeoType.Point: {
      if (isEmpty(geos, g)) {
        return { kind: "point", coords: new Float64Array(0), hasZ: false, hasM: false };
      }
      const c = coordinates(geos, g);
      return { kind: "point", coords: c.coords, hasZ: c.hasZ, hasM: c.hasM };
    }
    case GeoType.LineString: {
      const { coords, n, hasZ, hasM } = coordinates(geos, g);
      return { kind: "linestring", coords, lineOffsets: Int32Array.of(n), hasZ, hasM };
    }
    case GeoType.Polygon: {
      if (isEmpty(geos, g)) {
        return {
          kind: "polygon",
          coords: new Float64Array(0),
          ringOffsets: Int32Array.of(),
          hasZ: false,
          hasM: false,
        };
      }
      return polygonalToPolygonArray(geos, g);
    }
    case GeoType.MultiPoint: {
      const n = numGeometries(geos, g);
      if (n === 0) {
        return {
          kind: "multipoint",
          coords: new Float64Array(0),
          pointOffsets: Int32Array.of(),
          hasZ: false,
          hasM: false,
        };
      }
      return multiPointToArrow(geos, g, n);
    }
    case GeoType.MultiLineString: {
      const n = numGeometries(geos, g);
      if (n === 0) {
        return {
          kind: "multilinestring",
          coords: new Float64Array(0),
          lineOffsets: Int32Array.of(),
          hasZ: false,
          hasM: false,
        };
      }
      return multiLineToArrow(geos, g, n);
    }
    case GeoType.MultiPolygon: {
      const n = numGeometries(geos, g);
      if (n === 0) {
        return {
          kind: "multipolygon",
          coords: new Float64Array(0),
          ringOffsets: Int32Array.of(),
          partOffsets: Int32Array.of(),
          hasZ: false,
          hasM: false,
        };
      }
      return multiPolygonToArrow(geos, g, n);
    }
    default:
      return geometryCollectionToArrow(geos, g);
  }
}

function child(geos: Geos, parent: Geometry, i: number): Geometry {
  return geos.borrow(
    geos.native.geos.GEOSGetGeometryN_r(geos.ctx, parent.ptr, i) as GeomPtr | null,
    "GEOSGetGeometryN_r",
  );
}

function polygonalToPolygonArray(geos: Geos, poly: Geometry): PolygonArray {
  const p = polygonalOf(geos, poly);
  return {
    kind: "polygon",
    coords: p.coords,
    ringOffsets: p.ringOffsets,
    hasZ: p.hasZ,
    hasM: p.hasM,
  };
}

function multiPointToArrow(geos: Geos, mp: Geometry, n: number): MultiPointArray {
  const members = Array.from({ length: n }, (_, i) => child(geos, mp, i));
  const dims = checkHomogeneous(geos, members);
  const chunks: Float64Array[] = [];
  const pointOffsets = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!isEmpty(geos, members[i]!)) {
      chunks.push(coordinates(geos, members[i]!).coords);
      count++;
    }
    pointOffsets[i] = count; // empty member → repeated offset
  }
  return {
    kind: "multipoint",
    coords: concatCoords(chunks),
    pointOffsets,
    hasZ: dims.hasZ,
    hasM: dims.hasM,
  };
}

function multiLineToArrow(geos: Geos, ml: Geometry, n: number): MultiLineStringArray {
  const members = Array.from({ length: n }, (_, i) => child(geos, ml, i));
  const dims = checkHomogeneous(geos, members);
  const chunks: Float64Array[] = [];
  const lineOffsets = new Int32Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const c = coordinates(geos, members[i]!);
    chunks.push(c.coords);
    total += c.n;
    lineOffsets[i] = total;
  }
  return {
    kind: "multilinestring",
    coords: concatCoords(chunks),
    lineOffsets,
    hasZ: dims.hasZ,
    hasM: dims.hasM,
  };
}

function multiPolygonToArrow(geos: Geos, mp: Geometry, n: number): MultiPolygonArray {
  const members = Array.from({ length: n }, (_, i) => child(geos, mp, i));
  checkHomogeneous(geos, members);
  const parts: Polygonal[] = [];
  for (let i = 0; i < n; i++) {
    if (!isEmpty(geos, members[i]!)) parts.push(polygonalOf(geos, members[i]!));
  }
  return { kind: "multipolygon", ...concatPolygonal(parts) };
}

function geometryCollectionToArrow(geos: Geos, gc: Geometry): ArrowArray {
  const n = numGeometries(geos, gc);
  if (n === 0) {
    return {
      kind: "geometrycollection",
      types: Int32Array.of(),
      offsets: Int32Array.of(),
      children: [],
    };
  }
  // group members by type, first-appearance child order
  const order: GeoTypeId[] = [];
  const groups = new Map<GeoTypeId, number[]>();
  for (let i = 0; i < n; i++) {
    const t = geomTypeId(geos, child(geos, gc, i));
    let idxs = groups.get(t);
    if (idxs === undefined) {
      idxs = [];
      groups.set(t, idxs);
      order.push(t);
    }
    idxs.push(i);
  }
  const children: ArrowArray[] = [];
  const childSlotPos = new Map<number, { c: number; pos: number }>(); // slot → (child, position)
  for (let c = 0; c < order.length; c++) {
    const memberSlots = groups.get(order[c]!)!;
    const members = memberSlots.map((s) => child(geos, gc, s));
    switch (order[c]) {
      case GeoType.Point:
      case GeoType.MultiPoint:
        children[c] = membersToPointArray(geos, members, memberSlots, childSlotPos);
        break;
      case GeoType.LineString:
      case GeoType.MultiLineString:
        children[c] = membersToLineStringArray(geos, members, memberSlots, childSlotPos);
        break;
      case GeoType.Polygon:
      case GeoType.MultiPolygon:
        children[c] = membersToPolygonArray(geos, members, memberSlots, childSlotPos);
        break;
      default:
        throw new GeosError("toArrow", `unhandled member type ${order[c]} in a collection`);
    }
  }
  const types = new Int32Array(n);
  const offsets = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const ref = childSlotPos.get(i);
    if (ref === undefined) {
      throw new GeosError("toArrow", `collection member ${i} not placed in a child array`);
    }
    types[i] = ref.c;
    offsets[i] = ref.pos;
  }
  return { kind: "geometrycollection", types, offsets, children };
}

/* member-array builders for GC children (borrowed views — read-only) */

/** Audit H3: members with mixed coordinate dimensions share one buffer in
 * the Arrow shapes — silently striding them with the first member's stride
 * corrupts every following coordinate. Throw instead. */
function checkHomogeneous(geos: Geos, members: Geometry[]): { hasZ: boolean; hasM: boolean } {
  const first = dimensionsOf(geos, members[0]!);
  const stride = strideOf(first.hasZ, first.hasM);
  for (let i = 1; i < members.length; i++) {
    const d = dimensionsOf(geos, members[i]!);
    if (strideOf(d.hasZ, d.hasM) !== stride) {
      throw new GeosError(
        "toArrow",
        `mixed coordinate dimensions in a collection (member 0 has stride ${stride}, member ${i} has stride ${strideOf(d.hasZ, d.hasM)}) — normalize dimensions first`,
      );
    }
  }
  return first;
}

function membersToPointArray(
  geos: Geos,
  members: Geometry[],
  memberSlots: number[],
  childSlotPos: Map<number, { c: number; pos: number }>,
): MultiPointArray {
  const dims = checkHomogeneous(geos, members);
  const c = childCount(childSlotPos); // hoisted — the index is per-child, not per-member
  const chunks: Float64Array[] = [];
  const pointOffsets = new Int32Array(members.length);
  let count = 0;
  for (let i = 0; i < members.length; i++) {
    childSlotPos.set(memberSlots[i]!, { c, pos: i });
    if (!isEmpty(geos, members[i]!)) {
      chunks.push(coordinates(geos, members[i]!).coords);
      count++;
    }
    pointOffsets[i] = count;
  }
  return {
    kind: "multipoint",
    coords: concatCoords(chunks),
    pointOffsets,
    hasZ: dims.hasZ,
    hasM: dims.hasM,
  };
}

function membersToLineStringArray(
  geos: Geos,
  members: Geometry[],
  memberSlots: number[],
  childSlotPos: Map<number, { c: number; pos: number }>,
): MultiLineStringArray {
  const dims = checkHomogeneous(geos, members);
  const chunks: Float64Array[] = [];
  const lineOffsets = new Int32Array(members.length);
  let total = 0;
  const c = childCount(childSlotPos);
  for (let i = 0; i < members.length; i++) {
    childSlotPos.set(memberSlots[i]!, { c, pos: i });
    const coords = coordinates(geos, members[i]!);
    chunks.push(coords.coords);
    total += coords.n;
    lineOffsets[i] = total;
  }
  return {
    kind: "multilinestring",
    coords: concatCoords(chunks),
    lineOffsets,
    hasZ: dims.hasZ,
    hasM: dims.hasM,
  };
}

function membersToPolygonArray(
  geos: Geos,
  members: Geometry[],
  memberSlots: number[],
  childSlotPos: Map<number, { c: number; pos: number }>,
): MultiPolygonArray {
  const dims = checkHomogeneous(geos, members);
  const parts: Polygonal[] = [];
  const c = childCount(childSlotPos);
  for (let i = 0; i < members.length; i++) {
    childSlotPos.set(memberSlots[i]!, { c, pos: i });
    if (!isEmpty(geos, members[i]!)) parts.push(polygonalOf(geos, members[i]!));
  }
  // dims (not parts[0]) is the truth when every member is empty
  return { kind: "multipolygon", ...concatPolygonal(parts), hasZ: dims.hasZ, hasM: dims.hasM };
}

/** Which child index the next membersTo* call gets (call order = index). */
function childCount(childSlotPos: Map<number, { c: number; pos: number }>): number {
  // child index = number of distinct `c` values already assigned
  let max = -1;
  for (const v of childSlotPos.values()) {
    if (v.c > max) max = v.c;
  }
  return max + 1;
}

/* shared extraction helpers */

function polygonalOf(geos: Geos, poly: Geometry): Polygonal {
  const ext = geos.borrow(
    geos.native.geos.GEOSGetExteriorRing_r(geos.ctx, poly.ptr) as GeomPtr | null,
    "GEOSGetExteriorRing_r",
  );
  const ringViews = [ext];
  const nHoles = numInteriorRings(geos, poly);
  for (let h = 0; h < nHoles; h++) {
    ringViews.push(
      geos.borrow(
        geos.native.geos.GEOSGetInteriorRingN_r(geos.ctx, poly.ptr, h) as GeomPtr | null,
        "GEOSGetInteriorRingN_r",
      ),
    );
  }
  const { hasZ, hasM } = dimensionsOf(geos, poly);
  const ringOffsets = new Int32Array(ringViews.length);
  let total = 0;
  const chunks: Float64Array[] = [];
  for (let r = 0; r < ringViews.length; r++) {
    const c = coordinates(geos, ringViews[r]!);
    total += c.n;
    ringOffsets[r] = total;
    chunks.push(c.coords);
  }
  return {
    coords: concatCoords(chunks),
    ringOffsets,
    partOffsets: Int32Array.of(ringViews.length),
    hasZ,
    hasM,
  };
}

function concatCoords(chunks: Float64Array[]): Float64Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const coords = new Float64Array(total);
  let off = 0;
  for (const c of chunks) {
    coords.set(c, off);
    off += c.length;
  }
  return coords;
}

function concatPolygonal(parts: Polygonal[]): {
  coords: Float64Array;
  ringOffsets: Int32Array;
  partOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
} {
  const ringOffsets: number[] = [];
  const partOffsets: number[] = [];
  const chunks: Float64Array[] = [];
  let totalCoords = 0;
  let totalRings = 0;
  for (const p of parts) {
    for (let r = 0; r < p.ringOffsets.length; r++) {
      totalRings++;
      totalCoords += p.ringOffsets[r]! - (r === 0 ? 0 : p.ringOffsets[r - 1]!);
      ringOffsets.push(totalCoords);
    }
    partOffsets.push(totalRings);
    chunks.push(p.coords);
  }
  return {
    coords: concatCoords(chunks),
    ringOffsets: Int32Array.from(ringOffsets),
    partOffsets: Int32Array.from(partOffsets),
    hasZ: parts[0]?.hasZ ?? false,
    hasM: parts[0]?.hasM ?? false,
  };
}
