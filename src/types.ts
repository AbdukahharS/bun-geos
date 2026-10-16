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
