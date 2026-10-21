/**
 * GeoJSON I/O (io.md §3) — parsed and assembled JS-side DELIBERATELY (D9):
 * conversion in JS yields data-shaped errors with JSON paths and ring/vertex
 * indices instead of C-level "ParseException" text (D13).
 *
 * RFC 7946 notes: ring winding is preserved as input (use an orient helper —
 * Phase 2 — rather than silent normalization); members other than
 * `type`/`coordinates`/`geometries` survive round-trips through
 * `geometry.userData`. Typed empties are produced for `[]`-valued
 * coordinates (`"POINT EMPTY"` style, Shapely-2.0 behavior).
 */
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
import type { Polygonal } from "../types.ts";
import { GeoType } from "../types.ts";

/** Side-channel for non-GeoJSON members preserved across round-trips (io.md §3). */
export interface GeoJSONGeometryObject {
  type: string;
  coordinates?: unknown;
  geometries?: unknown[];
  [member: string]: unknown;
}

export interface GeoJSONFeature {
  type: "Feature";
  geometry: GeoJSONGeometryObject | null;
  properties?: unknown;
  [member: string]: unknown;
}

/** Alias a position: 2–4 finite numbers. */
function expectPosition(value: unknown, path: string, op: string): number[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new GeosError(op, `expected a position of 2–4 numbers`, { jsonPath: path });
  }
  const out: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new GeosError(op, `expected a finite number`, { jsonPath: `${path}[${i}]` });
    }
    out.push(v);
  }
  return out;
}

/** Dim inferred from position length: 2=XY, 3=XYZ, 4=XYZM. */
function dimOfLen(len: number): number {
  return len;
}

type Pos = number[];

interface ParsedRings {
  flat: Polygonal;
}

/** Flatten polygon rings (one polygon) into the canonical Polygonal shape. */
function parsePolygonRings(rings: unknown, path: string, op: string): ParsedRings {
  if (!Array.isArray(rings) || rings.length === 0) {
    throw new GeosError(op, `polygon needs at least one ring`, { jsonPath: path });
  }
  const lens: number[] = [];
  const ringPos: Pos[][] = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    if (!Array.isArray(ring)) {
      throw new GeosError(op, `expected an array of positions`, { jsonPath: `${path}[${r}]` });
    }
    const positions = ring.map((p, i) => expectPosition(p, `${path}[${r}][${i}]`, op));
    if (positions.length < 3) {
      throw new GeosError(op, `polygon ring ${r} has ${positions.length} positions; need ≥ 3`, {
        jsonPath: `${path}[${r}]`,
        ring: r,
      });
    }
    lens.push(dimOfLen(positions[0]!.length));
    ringPos.push(positions);
  }
  const dim = lens[0]!;
  for (let r = 0; r < lens.length; r++) {
    if (lens[r] !== dim) {
      throw new GeosError(
        op,
        `mixed position dimensions (ring 0 has ${dim}, ring ${r} has ${lens[r]})`,
        {
          jsonPath: path,
          ring: r,
        },
      );
    }
  }
  const ringOffsets = new Int32Array(ringPos.length);
  let total = 0;
  for (let r = 0; r < ringPos.length; r++) {
    total += ringPos[r]!.length;
    ringOffsets[r] = total;
  }
  const coords = new Float64Array(total * dim);
  let k = 0;
  for (const ring of ringPos) {
    for (const pos of ring) {
      for (let d = 0; d < dim; d++) coords[k * dim + d] = pos[d]!;
      k++;
    }
  }
  return {
    flat: {
      coords,
      ringOffsets,
      partOffsets: Int32Array.of(ringPos.length),
      hasZ: dim > 2,
      hasM: dim > 3,
    },
  };
}

/** Flatten a MultiPolygon into one canonical Polygonal buffer. */
function parseMultiPolygonCoords(polys: unknown, path: string, op: string): ParsedRings {
  if (!Array.isArray(polys) || polys.length === 0) {
    throw new GeosError(op, `multipolygon needs at least one polygon`, { jsonPath: path });
  }
  const ringBufs: ParsedRings[] = [];
  let dim: number | null = null;
  for (let p = 0; p < polys.length; p++) {
    const parsed = parsePolygonRings(polys[p], `${path}[${p}]`, op);
    if (dim === null) dim = parsed.flat.hasZ ? (parsed.flat.hasM ? 4 : 3) : 2;
    ringBufs.push(parsed);
  }
  const d = dim!;
  const ringOffsets: number[] = [];
  const partOffsets: number[] = [];
  const coordChunks: Float64Array[] = [];
  let totalCoords = 0;
  let totalRings = 0;
  for (const rb of ringBufs) {
    const nRings = rb.flat.ringOffsets.length;
    for (let r = 0; r < nRings; r++) {
      totalRings++;
      totalCoords += rb.flat.ringOffsets[r]! - (r === 0 ? 0 : rb.flat.ringOffsets[r - 1]!);
      ringOffsets.push(totalCoords);
    }
    partOffsets.push(totalRings);
    coordChunks.push(rb.flat.coords);
  }
  const coords = new Float64Array(totalCoords * d);
  let off = 0;
  for (const chunk of coordChunks) {
    coords.set(chunk, off);
    off += chunk.length;
  }
  return {
    flat: {
      coords,
      ringOffsets: Int32Array.from(ringOffsets),
      partOffsets: Int32Array.from(partOffsets),
      hasZ: d > 2,
      hasM: d > 3,
    },
  };
}

/** Parse a GeoJSON geometry object (or Feature) into an owned geometry. */
export function fromGeoJSON(geos: Geos, value: GeoJSONGeometryObject | GeoJSONFeature): Geometry {
  geos.assertOpen("fromGeoJSON");
  const op = "fromGeoJSON";
  if (!value || typeof value !== "object") {
    throw new GeosError(op, "expected a GeoJSON geometry object or Feature");
  }
  let geomObj: GeoJSONGeometryObject;
  let userData: Record<string, unknown> | undefined;
  if (value.type === "Feature") {
    const feature = value as GeoJSONFeature;
    if (!feature.geometry) {
      throw new GeosError(
        op,
        "Feature has null geometry ( RFC 7946 §3.2 allows it; pass a geometry explicitly)",
      );
    }
    geomObj = feature.geometry;
    userData = {};
    for (const [k, v] of Object.entries(feature)) {
      if (k !== "type" && k !== "geometry") userData[k] = v;
    }
  } else {
    geomObj = value;
  }
  if (userData === undefined) {
    const extras: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(geomObj)) {
      if (k !== "type" && k !== "coordinates" && k !== "geometries") extras[k] = v;
    }
    if (Object.keys(extras).length > 0) userData = extras;
  }
  const geom = parseGeometry(geos, geomObj, "geometry", op);
  if (userData !== undefined) geom.userData = userData;
  return geom;
}

function parseGeometry(geos: Geos, obj: GeoJSONGeometryObject, path: string, op: string): Geometry {
  if (!obj || typeof obj !== "object" || typeof obj.type !== "string") {
    throw new GeosError(op, `expected { type, coordinates }`, { jsonPath: path });
  }
  const coords = obj.coordinates;
  switch (obj.type) {
    case "Point": {
      if (!Array.isArray(coords)) {
        throw new GeosError(op, `expected a position`, { jsonPath: `${path}.coordinates` });
      }
      if (coords.length === 0) return geos.empty("point");
      const pos = expectPosition(coords, `${path}.coordinates`, op);
      return fromCoords(geos, flatOf([pos]), "point");
    }
    case "MultiPoint": {
      if (!Array.isArray(coords)) {
        throw new GeosError(op, `expected an array of positions`, {
          jsonPath: `${path}.coordinates`,
        });
      }
      if (coords.length === 0) return geos.empty("multipoint");
      const positions: number[][] = [];
      for (let i = 0; i < coords.length; i++) {
        positions.push(expectPosition(coords[i], `${path}.coordinates[${i}]`, op));
      }
      const parts: Geometry[] = [];
      try {
        for (const pos of positions) parts.push(fromCoords(geos, flatOf([pos]), "point"));
      } catch (err) {
        for (const p of parts) p.dispose(); // error-path cleanup (audit M2)
        throw err;
      }
      return fromParts(geos, "multipoint", parts, { transfer: true });
    }
    case "LineString": {
      if (!Array.isArray(coords)) {
        throw new GeosError(op, `expected an array of positions`, {
          jsonPath: `${path}.coordinates`,
        });
      }
      const positions = coords.map((p, i) => expectPosition(p, `${path}.coordinates[${i}]`, op));
      if (positions.length === 0) return geos.empty("linestring");
      if (positions.length < 2) {
        throw new GeosError(op, `linestring needs ≥ 2 positions, got ${positions.length}`, {
          jsonPath: `${path}.coordinates`,
        });
      }
      return fromCoords(geos, flatOf(positions), "linestring");
    }
    case "MultiLineString": {
      if (!Array.isArray(coords)) {
        throw new GeosError(op, `expected an array of lines`, { jsonPath: `${path}.coordinates` });
      }
      if (coords.length === 0) return geos.empty("multilinestring");
      const lines = coords.map((line, li) => {
        if (!Array.isArray(line)) {
          throw new GeosError(op, `expected an array of positions`, {
            jsonPath: `${path}.coordinates[${li}]`,
          });
        }
        const positions = line.map((p, i) =>
          expectPosition(p, `${path}.coordinates[${li}][${i}]`, op),
        );
        if (positions.length < 2) {
          throw new GeosError(op, `linestring ${li} needs ≥ 2 positions`, {
            jsonPath: `${path}.coordinates[${li}]`,
          });
        }
        return fromCoords(geos, flatOf(positions), "linestring");
      });
      return fromParts(geos, "multilinestring", lines, { transfer: true });
    }
    case "Polygon": {
      if (Array.isArray(coords) && coords.length === 0) return geos.empty("polygon");
      const { flat } = parsePolygonRings(coords, `${path}.coordinates`, op);
      return fromPolygonal(geos, flat);
    }
    case "MultiPolygon": {
      if (Array.isArray(coords) && coords.length === 0) return geos.empty("multipolygon");
      const { flat } = parseMultiPolygonCoords(coords, `${path}.coordinates`, op);
      return fromPolygonal(geos, flat);
    }
    case "GeometryCollection": {
      const geoms = obj.geometries;
      if (!Array.isArray(geoms)) {
        throw new GeosError(op, `expected an array of geometries`, {
          jsonPath: `${path}.geometries`,
        });
      }
      if (geoms.length === 0) return geos.empty("geometrycollection");
      const parts = geoms.map((g, i) => {
        if (!g || typeof g !== "object") {
          throw new GeosError(op, `expected a geometry object`, {
            jsonPath: `${path}.geometries[${i}]`,
          });
        }
        return parseGeometry(geos, g as GeoJSONGeometryObject, `${path}.geometries[${i}]`, op);
      });
      return fromParts(geos, "geometrycollection", parts, { transfer: true });
    }
    default:
      throw new GeosError(op, `unknown GeoJSON type "${obj.type}"`, { jsonPath: `${path}.type` });
  }
}

function flatOf(positions: Pos[]): import("../types.ts").FlatCoords {
  const dim = dimOfLen(positions[0]!.length);
  const coords = new Float64Array(positions.length * dim);
  for (let i = 0; i < positions.length; i++) {
    for (let d = 0; d < dim; d++) coords[i * dim + d] = positions[i]![d]!;
  }
  return { coords, n: positions.length, hasZ: dim > 2, hasM: dim > 3 };
}

// ------------------------------------------------------------------ output

export interface GeoJSONOptions {
  /** Emit 3-length positions when Z is present (default true). */
  includeZ?: boolean;
}

/** Assemble a GeoJSON geometry object (JS-side; Z kept as 3-length positions unless `includeZ: false`). */
export function toGeoJSON(
  geos: Geos,
  g: Geometry,
  opts: GeoJSONOptions = {},
): GeoJSONGeometryObject {
  g.requireSame(geos);
  geos.assertOpen("toGeoJSON");
  const { hasZ } = dimensionsOf(geos, g);
  const outDim = opts.includeZ === false ? 2 : hasZ ? 3 : 2;
  const obj = assemble(geos, g, outDim);
  if (g.userData && typeof g.userData === "object") {
    return { ...g.userData, ...obj } as GeoJSONGeometryObject;
  }
  return obj;
}

function linePositions(geos: Geos, g: Geometry, outDim: number): number[][] {
  const { coords, n } = coordinates(geos, g);
  const { hasZ, hasM } = dimensionsOf(geos, g);
  const stride = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  const dim = Math.min(outDim, stride);
  const out: number[][] = [];
  for (let i = 0; i < n; i++) {
    const pos: number[] = [];
    for (let d = 0; d < dim; d++) pos.push(coords[i * stride + d]!);
    out.push(pos);
  }
  return out;
}

function positionOf(geos: Geos, g: Geometry, outDim: number): number[] {
  const { coords } = coordinates(geos, g);
  const { hasZ } = dimensionsOf(geos, g);
  const stride = 2 + (hasZ ? 1 : 0);
  const dim = Math.min(outDim, stride);
  const out: number[] = [];
  for (let d = 0; d < dim; d++) out.push(coords[d]!);
  return out;
}

function assemble(geos: Geos, g: Geometry, outDim: number): GeoJSONGeometryObject {
  const typeId = geomTypeId(geos, g);
  switch (typeId) {
    case GeoType.Point: {
      if (isEmpty(geos, g)) {
        return { type: "Point", coordinates: [] };
      }
      return { type: "Point", coordinates: positionOf(geos, g, outDim) };
    }
    case GeoType.LineString: {
      if (isEmpty(geos, g)) {
        return { type: "LineString", coordinates: [] };
      }
      return { type: "LineString", coordinates: linePositions(geos, g, outDim) };
    }
    case GeoType.Polygon: {
      if (isEmpty(geos, g)) {
        return { type: "Polygon", coordinates: [] };
      }
      const rings: number[][][] = [linePositions(geos, importRing(geos, g), outDim)];
      const nHoles = numInteriorRings(geos, g);
      for (let h = 0; h < nHoles; h++) {
        rings.push(
          linePositions(
            geos,
            ringView(geos.native.geos.GEOSGetInteriorRingN_r(geos.ctx, g.ptr, h), geos, g),
            outDim,
          ),
        );
      }
      return { type: "Polygon", coordinates: rings };
    }
    case GeoType.MultiPoint:
    case GeoType.MultiLineString:
    case GeoType.MultiPolygon: {
      const n = numGeometries(geos, g);
      if (n === 0) {
        return { type: geomName(typeId), coordinates: [] };
      }
      // GeoJSON Multi* coordinates are nested positions (not nested objects).
      const items: unknown[] = [];
      for (let i = 0; i < n; i++)
        items.push(assemble(geos, childView(geos, g, i), outDim).coordinates);
      return { type: geomName(typeId), coordinates: items };
    }
    case GeoType.GeometryCollection: {
      const n = numGeometries(geos, g);
      const geoms: GeoJSONGeometryObject[] = [];
      for (let i = 0; i < n; i++) geoms.push(assemble(geos, childView(geos, g, i), outDim));
      return { type: "GeometryCollection", geometries: geoms };
    }
    default:
      throw new GeosError(
        "toGeoJSON",
        `unsupported geometry type id ${typeId} (curved types are rejected at the readers — D31)`,
      );
  }
}

function importRing(geos: Geos, polygon: Geometry): Geometry {
  // Borrowed exterior ring view — coordinates() accepts LinearRing ids.
  return geos.borrow(
    geos.native.geos.GEOSGetExteriorRing_r(geos.ctx, polygon.ptr) as
      | import("../types.ts").GeomPtr
      | null,
    "GEOSGetExteriorRing_r",
    polygon,
  );
}

function ringView(ptr: import("bun:ffi").Pointer | null, geos: Geos, parent: Geometry): Geometry {
  return geos.borrow(ptr as import("../types.ts").GeomPtr, "GEOSGetInteriorRingN_r", parent);
}

function childView(geos: Geos, parent: Geometry, i: number): Geometry {
  return geos.borrow(
    geos.native.geos.GEOSGetGeometryN_r(geos.ctx, parent.ptr, i) as
      | import("../types.ts").GeomPtr
      | null,
    "GEOSGetGeometryN_r",
  );
}

function geomName(typeId: number): string {
  const names: Record<number, string> = {
    [GeoType.Point]: "Point",
    [GeoType.LineString]: "LineString",
    [GeoType.Polygon]: "Polygon",
    [GeoType.MultiPoint]: "MultiPoint",
    [GeoType.MultiLineString]: "MultiLineString",
    [GeoType.MultiPolygon]: "MultiPolygon",
    [GeoType.GeometryCollection]: "GeometryCollection",
  };
  return names[typeId] ?? "Unknown";
}

// Re-exported type for callers building typed payloads.
export type { Polygonal };
