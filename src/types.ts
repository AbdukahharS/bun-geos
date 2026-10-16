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

/** GeoArrow-shaped interchange values accepted by `fromArrow` / `toArrow` (Phase 1). */
export type ArrowArray = FlatCoords | LineArray | Polygonal;

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
