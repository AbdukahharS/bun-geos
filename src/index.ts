/**
 * @shzd/bun-geos — Bun-native TypeScript bindings for GEOS 3.14.
 *
 * Planar CRS only (GEOS is Cartesian 2D — project before using, or buffer
 * in degrees and get garbage). One `Geos` per thread; geometries never
 * cross contexts/workers — transfer WKB/GeoJSON/Arrow copies instead (D11).
 */

export { Arena } from "./arena.ts";
export type { EmptyKind, FromPartsOptions } from "./construct.ts";
export {
  GeosError,
  type GeosErrorDetail,
  type GeosErrorDiagnostics,
  LoaderError,
} from "./errors.ts";
export { Geometry } from "./geometry.ts";
export { Geos, type GeosStats } from "./geos.ts";
export type { OpOptions } from "./interrupt.ts";
export type { GeoJSONFeature, GeoJSONGeometryObject, GeoJSONOptions } from "./io/geojson.ts";
export type { FromWKBManyOptions, WKBOptions } from "./io/wkb.ts";
export type { WKTOptions } from "./io/wkt.ts";
export type {
  BatchInput,
  BatchOptions,
  BufferAllOptions,
  UnpreparedPredName,
} from "./ops/batch.ts";
export type { BufferOptions } from "./ops/buffer.ts";
export type {
  CoverageCleanOptions,
  CoverageIsValidOptions,
  CoverageSimplifyOptions,
  CoverageValidity,
} from "./ops/coverage.ts";
export type { UnionAllOptions, UnionAllStrategy } from "./ops/overlay.ts";
export type { SetPrecisionOptions } from "./ops/precision.ts";
export type { MakeValidOptions, SimpleDetail, ValidityDetail } from "./ops/repair.ts";
export { GeosParallelError, type ParallelOptions } from "./parallel/pool.ts";
export type {
  BufferParams,
  ParallelOp,
  UnionParams,
} from "./parallel/protocol.ts";
export { Prepared } from "./spatial/prepared.ts";
export { type PreparedPredName, STRtree } from "./spatial/strtree.ts";
export type {
  ArrowArray,
  ByteOrder,
  CollectionKind,
  CoverageCleanParamsPtr,
  FlatCoords,
  GeoTypeId,
  LineArray,
  MakeValidParamsPtr,
  Polygonal,
  PreparedPtr,
  StrTreePtr,
} from "./types.ts";
// Value+type pairs: one export statement carries both declarations
// (PreparedPred/UnionStrategy and the Phase 3 op tables are exported here as
// values — users need the numeric ids to pin against the shim ABI).
export {
  GeoType,
  geoTypeName,
  MakeValidMethod,
  MeasureOp,
  OverlapMergeStrategy,
  OverlayOp,
  PrecisionMode,
  PreparedPred,
  UnionStrategy,
  UnpreparedPred,
} from "./types.ts";
