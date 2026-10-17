/**
 * Shared types: branded FFI pointer handles (D15.3) and the canonical
 * flat-buffer currency (D9).
 *
 * Pointer handles extend bun:ffi's `Pointer` (itself a branded number), so a
 * branded handle flows into any `ptr` argument without casts — but distinct
 * handle types are NOT mutually assignable. Passing a `GeosShim*` where a
 * `GEOSContextHandle_t` belongs is a compile error: that is the structural
 * fix for the F8 wrapper-pointer segfault class.
 */
import type { Pointer } from "bun:ffi";

declare const __ctx: unique symbol;
declare const __shim: unique symbol;
declare const __geom: unique symbol;
declare const __coordseq: unique symbol;
declare const __wktReader: unique symbol;
declare const __wktWriter: unique symbol;
declare const __wkbReader: unique symbol;
declare const __wkbWriter: unique symbol;
declare const __bufferParams: unique symbol;
declare const __prepared: unique symbol;
declare const __strtree: unique symbol;
declare const __makeValidParams: unique symbol;
declare const __coverageCleanParams: unique symbol;
declare const __ownedStr: unique symbol;

/** `GEOSContextHandle_t` — pass to every `geos_c` `_r` function. */
export type GeosCtx = Pointer & { readonly [__ctx]: "GEOSContextHandle_t" };
/** `GeosShim*` — pass ONLY to `geos_shim_*` functions (F8 rule). */
export type ShimPtr = Pointer & { readonly [__shim]: "GeosShim" };
/** `GEOSGeometry*` — owned unless marked borrowed at the wrapper boundary. */
export type GeomPtr = Pointer & { readonly [__geom]: "GEOSGeometry" };
/** `GEOSCoordSequence*` — transient; usually transferred into a geometry. */
export type CoordSeqPtr = Pointer & { readonly [__coordseq]: "GEOSCoordSequence" };
/** `GEOSWKTReader*` / `GEOSWKTWriter*` — pooled per `Geos` (memory.md §2). */
export type WktReaderPtr = Pointer & { readonly [__wktReader]: "GEOSWKTReader" };
export type WktWriterPtr = Pointer & { readonly [__wktWriter]: "GEOSWKTWriter" };
/** `GEOSWKBReader*` / `GEOSWKBWriter*` — pooled per `Geos`. */
export type WkbReaderPtr = Pointer & { readonly [__wkbReader]: "GEOSWKBReader" };
export type WkbWriterPtr = Pointer & { readonly [__wkbWriter]: "GEOSWKBWriter" };
/** `GEOSBufferParams*` — created per buffer call, always destroyed. */
export type BufferParamsPtr = Pointer & { readonly [__bufferParams]: "GEOSBufferParams" };
/** `const GEOSPreparedGeometry*` — indexed predicate structure (3.13 RelateNG). */
export type PreparedPtr = Pointer & { readonly [__prepared]: "GEOSPreparedGeometry" };
/** `GEOSSTRtree*` — items are integer ids (D16), never geometry pointers. */
export type StrTreePtr = Pointer & { readonly [__strtree]: "GEOSSTRtree" };
/** `GEOSMakeValidParams*` — pooled per `Geos`, values re-set per call. */
export type MakeValidParamsPtr = Pointer & { readonly [__makeValidParams]: "GEOSMakeValidParams" };
/** `GEOSCoverageCleanParams*` — pooled per `Geos` (3.14). */
export type CoverageCleanParamsPtr = Pointer & {
  readonly [__coverageCleanParams]: "GEOSCoverageCleanParams";
};
/** A GEOS-owned `char*` awaiting `GEOSFree_r`. Never escape one from a helper. */
export type OwnedStrPtr = Pointer & { readonly [__ownedStr]: "GEOSFree me" };

/** GEOS geometry type ids (`GEOSGeomTypeId_r` / the `GEOSGeomTypes` enum). */
export const GeoType = {
  Point: 0,
  LineString: 1,
  LinearRing: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
  GeometryCollection: 7,
} as const;
export type GeoTypeId = (typeof GeoType)[keyof typeof GeoType];

export type CollectionKind =
  | "multipoint"
  | "multilinestring"
  | "multipolygon"
  | "geometrycollection";

/** Collection kind → `GEOSGeom_createCollection` type id. */
export function collectionTypeId(kind: CollectionKind): GeoTypeId {
  switch (kind) {
    case "multipoint":
      return GeoType.MultiPoint;
    case "multilinestring":
      return GeoType.MultiLineString;
    case "multipolygon":
      return GeoType.MultiPolygon;
    case "geometrycollection":
      return GeoType.GeometryCollection;
  }
}

/** Geometry type id → WKT-style name (as GEOS reports it). */
export function geoTypeName(id: GeoTypeId): string {
  const names: Record<number, string> = {
    [GeoType.Point]: "Point",
    [GeoType.LineString]: "LineString",
    [GeoType.LinearRing]: "LinearRing",
    [GeoType.Polygon]: "Polygon",
    [GeoType.MultiPoint]: "MultiPoint",
    [GeoType.MultiLineString]: "MultiLineString",
    [GeoType.MultiPolygon]: "MultiPolygon",
    [GeoType.GeometryCollection]: "GeometryCollection",
  };
  return names[id] ?? `Unknown(${id})`;
}

/**
 * The canonical currency (io.md §1): interleaved X Y [Z [M]] coordinates —
 * literally the layout of `GEOSCoordSeq_copyFromBuffer` and GeoArrow.
 */
export interface FlatCoords {
  /** Interleaved coordinates: X Y [Z [M]] × n. */
  coords: Float64Array;
  /** Coordinate count. */
  n: number;
  hasZ: boolean;
  hasM: boolean;
}

/**
 * Ring/part structure as offsets into coordinate space (io.md §1).
 * Ring i spans `[ringOffsets[i-1], ringOffsets[i])` coordinates; polygon j
 * spans rings `[partOffsets[j-1], partOffsets[j])`. Offsets are end-indices
 * (first element is exclusive of zero — i.e. inclusive end).
 */
export interface Polygonal {
  coords: Float64Array;
  ringOffsets: Int32Array;
  /** End-ring of each polygon. Length 1 → single polygon; > 1 → multipolygon. */
  partOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
}

/** Linear structure with per-line offsets (multilinestring interchange). */
export interface LineArray {
  coords: Float64Array;
  /** End-index of each line, in coordinates. */
  lineOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
}

/* ── Phase 5 GeoArrow shapes v2 (io.md §5, D28) ───────────────────────────
 * Tagged, spec-shaped interchange values: `kind` names the GeoArrow
 * extension type (`geoarrow.<kind>`), offsets mirror the spec's list
 * nesting, and `validity` is the Arrow LSB bitmap (1 = non-null slot,
 * absent = all-valid). The Phase 1 untagged shapes (FlatCoords/LineArray/
 * Polygonal) remain accepted as LEGACY input — inferred by shape — and
 * `toArrow` emits only tagged values. */

/** A null-slot bitmap in Arrow canonical form (LSB-first; absent = all-valid). */
export type ArrowValidity = Uint8Array;

/** geoarrow.point — one geometry. */
export interface PointArray {
  kind: "point";
  coords: Float64Array;
  hasZ: boolean;
  hasM: boolean;
}

/** geoarrow.linestring — one geometry. */
export interface LineStringArray {
  kind: "linestring";
  coords: Float64Array;
  /** End-index of the line, in coordinates. Length 1. */
  lineOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
}

/** geoarrow.polygon — one geometry. */
export interface PolygonArray {
  kind: "polygon";
  coords: Float64Array;
  /** End-index of each ring, in coordinates. */
  ringOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
}

/** geoarrow.multipoint — members are the points. */
export interface MultiPointArray {
  kind: "multipoint";
  coords: Float64Array;
  /** End-coordinate-slot of each point. Length 0 → MULTIPOINT EMPTY. */
  pointOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
  validity?: ArrowValidity;
}

/**
 * geoarrow.multilinestring — members are the linestrings (a single
 * geometry reads all members as one MULTILINESTRING; a batch treats each
 * member as one slot, so a batch of multi-members is not representable —
 * pass `Geometry[]` for that).
 */
export interface MultiLineStringArray {
  kind: "multilinestring";
  coords: Float64Array;
  /** End-index of each member line, in coordinates. Length 0 → EMPTY. */
  lineOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
  validity?: ArrowValidity;
}

/**
 * geoarrow.multipolygon — members are the polygons (a single geometry
 * reads all members as one MULTIPOLYGON; a batch treats each member as
 * one slot).
 */
export interface MultiPolygonArray {
  kind: "multipolygon";
  coords: Float64Array;
  /** End-index of each ring, in coordinates (concatenated across members). */
  ringOffsets: Int32Array;
  /** End-ring of each member polygon. Length 0 → EMPTY. */
  partOffsets: Int32Array;
  hasZ: boolean;
  hasM: boolean;
  validity?: ArrowValidity;
}

/**
 * geoarrow.geometry — the dense-union emulation: slot i lives in child
 * `types[i]` at position `offsets[i]`. Children are homogeneous typed
 * arrays (any of the six above, in any order); empty children may be
 * omitted. `hasZ`/`hasM` are per-child.
 */
export interface GeometryCollectionArray {
  kind: "geometrycollection";
  /** Child index per slot (dense-union type ids). */
  types: Int32Array;
  /** Position within the child per slot. */
  offsets: Int32Array;
  children: ArrowArray[];
  validity?: ArrowValidity;
}

/** Tagged GeoArrow shapes v2 — what `toArrow` emits and `fromArrow` accepts. */
export type ArrowArray =
  | PointArray
  | LineStringArray
  | PolygonArray
  | MultiPointArray
  | MultiLineStringArray
  | MultiPolygonArray
  | GeometryCollectionArray;

/** Legacy (Phase 1) untagged shapes — still accepted, inferred by shape. */
export type LegacyArrow = FlatCoords | LineArray | Polygonal;

/** Everything the Arrow I/O and batch entry points accept. */
export type ArrowInput = ArrowArray | LegacyArrow;

/** WKB byte order (GEOS_WKB_XDR = big-endian, GEOS_WKB_NDR = little-endian). */
export type ByteOrder = "little" | "big";

export function byteOrderToId(order: ByteOrder): number {
  return order === "big" ? 0 : 1; // GEOS_WKB_XDR / GEOS_WKB_NDR
}

/* ===================== Phase 2 (ROADMAP: differentiators) ===================== */

/** `GEOSMakeValidMethods` enum values (geos_c.h). */
export const MakeValidMethod = { linework: 0, structure: 1 } as const;
export type MakeValidMethod = (typeof MakeValidMethod)[keyof typeof MakeValidMethod];

/** `GEOSPrecisionRules` enum values (geos_c.h). */
export const PrecisionMode = { validOutput: 0, noTopo: 1, keepCollapsed: 2 } as const;
export type PrecisionMode = (typeof PrecisionMode)[keyof typeof PrecisionMode];

/** `GEOSOverlapMerge` enum values (geos_c.h, 3.14 CoverageClean). */
export const OverlapMergeStrategy = {
  longestBorder: 0,
  maxArea: 1,
  minArea: 2,
  minIndex: 3,
} as const;
export type OverlapMergeStrategy = (typeof OverlapMergeStrategy)[keyof typeof OverlapMergeStrategy];

/**
 * Prepared predicate ids — the `predId` argument of
 * `geos_shim_prepared_pred_all`. MUST match the shim's `SHIM_PREP_*` enum
 * (native/shim.c): a mismatch is a silent wrong-predicate bug, so the
 * selftest pins every id against a known-answer fixture set (6 fixtures ×
 * 10 ids — a swapped id cannot pass).
 */
export const PreparedPred = {
  intersects: 0,
  contains: 1,
  containsProperly: 2,
  coveredBy: 3,
  covers: 4,
  crosses: 5,
  disjoint: 6,
  overlaps: 7,
  touches: 8,
  within: 9,
} as const;
export type PreparedPred = (typeof PreparedPred)[keyof typeof PreparedPred];

/** `geos_shim_union_all` strategy ids — MUST match `SHIM_UNION_*` in the shim. */
export const UnionStrategy = { auto: 0, coverage: 1, disjointSubset: 2, unary: 3 } as const;
export type UnionStrategy = (typeof UnionStrategy)[keyof typeof UnionStrategy];

/* ===================== Phase 3 (ROADMAP: performance & scale) ===================== */

/**
 * `geos_shim_overlay_all` op ids — MUST match `SHIM_OVERLAY_*` in the shim
 * (native/shim.c). The `*Prec` ids take the grid size; plain ids ignore it.
 * Pinned by known-answer selftests (the PreparedPred discipline).
 */
export const OverlayOp = {
  intersection: 0,
  union: 1,
  difference: 2,
  symDifference: 3,
  intersectionPrec: 4,
  unionPrec: 5,
  differencePrec: 6,
  symDifferencePrec: 7,
} as const;
export type OverlayOp = (typeof OverlayOp)[keyof typeof OverlayOp];

/**
 * `geos_shim_pred_all` (unprepared batch masks) ids — MUST match
 * `SHIM_PRED_*` in the shim. Numbering is independent of `PreparedPred`
 * (no containsProperly unprepared); pinned by its own known-answer table.
 */
export const UnpreparedPred = {
  intersects: 0,
  contains: 1,
  coveredBy: 2,
  covers: 3,
  crosses: 4,
  disjoint: 5,
  overlaps: 6,
  touches: 7,
  within: 8,
} as const;
export type UnpreparedPred = (typeof UnpreparedPred)[keyof typeof UnpreparedPred];

/** `geos_shim_measure_all` op ids — MUST match `SHIM_MEASURE_*` in the shim. */
export const MeasureOp = {
  area: 0,
  length: 1,
  distance: 2,
  hausdorff: 3,
  frechet: 4,
} as const;
export type MeasureOp = (typeof MeasureOp)[keyof typeof MeasureOp];

/**
 * `geos_shim_unary_all` (Phase 5 construction batch, D27) ids — MUST match
 * `SHIM_UNARY_*` in the shim; pinned by known-answer selftests.
 */
export const UnaryOp = {
  convexHull: 0,
  simplifyDP: 1,
  simplifyTP: 2,
  centroid: 3,
  boundary: 4,
  interiorPoint: 5,
  node: 6,
  lineMerge: 7,
  clipByRect: 8,
} as const;
export type UnaryOp = (typeof UnaryOp)[keyof typeof UnaryOp];

/** `geos_shim_binary_all` ids — MUST match `SHIM_BINARY_*` in the shim. */
export const BinaryOp = {
  snap: 0,
  sharedPaths: 1,
} as const;
export type BinaryOp = (typeof BinaryOp)[keyof typeof BinaryOp];
