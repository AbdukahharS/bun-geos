/**
 * @shzd/bun-geos — Bun-native TypeScript bindings for GEOS 3.14 (Phase 1).
 *
 * Planar CRS only (GEOS is Cartesian 2D — project before using, or buffer
 * in degrees and get garbage). One `Geos` per thread; geometries never
 * cross contexts/workers — transfer WKB/GeoJSON/Arrow copies instead (D11).
 */

export { Arena } from "./arena.ts";
export type { EmptyKind, FromPartsOptions } from "./construct.ts";
export { GeosError, type GeosErrorDetail, LoaderError } from "./errors.ts";
export { Geometry } from "./geometry.ts";
export { Geos, type GeosStats } from "./geos.ts";
export type {
  GeoJSONFeature,
  GeoJSONGeometryObject,
  GeoJSONOptions,
} from "./io/geojson.ts";
export type { WKBOptions } from "./io/wkb.ts";
export type { WKTOptions } from "./io/wkt.ts";
export type { BufferOptions } from "./ops/buffer.ts";
export type {
  ArrowArray,
  ByteOrder,
  CollectionKind,
  FlatCoords,
  GeoTypeId,
  LineArray,
  Polygonal,
} from "./types.ts";
export { GeoType, geoTypeName } from "./types.ts";
