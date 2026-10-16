/**
 * GeoArrow-shaped interchange (io.md §5, Phase 1 scope).
 *
 * The canonical FlatCoords/Polygonal structs ARE the GeoArrow interleaved
 * layout, so `fromArrow`/`toArrow` are validate-and-build / extract-and-shape
 * operations — structure copies, not conversions. Spec conformance
 * (extension metadata, null bitmaps, unions) is the Phase 5 pass; this layer
 * is deliberately honest about that.
 *
 * Shapes:
 *   FlatCoords          → Point (n=1) / MultiPoint (n>1) / Point EMPTY (n=0)
 *   LineArray           → LineString (1 line) / MultiLineString (n lines)
 *   Polygonal           → Polygon (1 part) / MultiPolygon (n parts)
 *   Empty POINT / LINESTRING / POLYGON roundtrip; empty MULTI* are NOT
 *   representable (indistinguishable from their singular empty) → toArrow
 *   throws; same for GeometryCollection (heterogeneous). Phase 5 adds null
 *   bitmaps and full spec conformance.
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
import type { ArrowArray, FlatCoords, GeomPtr, LineArray, Polygonal } from "../types.ts";
import { GeoType } from "../types.ts";

function isPolygonal(a: ArrowArray): a is Polygonal {
  return "ringOffsets" in a && "partOffsets" in a;
}

function isLineArray(a: ArrowArray): a is LineArray {
  return "lineOffsets" in a;
}

function strideOf(hasZ: boolean, hasM: boolean): number {
  return 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
}

/**
 * Audit H3: parts with mixed dimensions (an XYZ point next to an XY point)
 * share one buffer in the Arrow shapes — silently striding them with the
 * first part's stride corrupts every following coordinate. GEOS tolerates
 * such collections; the Arrow shapes do not. Throw instead.
 */
function checkHomogeneous(parts: readonly { hasZ: boolean; hasM: boolean }[]): number {
  const first = parts[0]!;
  const stride = strideOf(first.hasZ, first.hasM);
  for (let i = 1; i < parts.length; i++) {
    if (strideOf(parts[i]!.hasZ, parts[i]!.hasM) !== stride) {
      throw new GeosError(
        "toArrow",
        `mixed coordinate dimensions in a collection (part 0 has stride ${stride}, part ${i} has stride ${strideOf(parts[i]!.hasZ, parts[i]!.hasM)}) — normalize dimensions first`,
      );
    }
  }
  return stride;
}

/** Build a geometry from a GeoArrow-shaped value (validate; one crossing per part). */
export function fromArrow(geos: Geos, arr: ArrowArray): Geometry {
  geos.assertOpen("fromArrow");
  const op = "fromArrow";
  if (isPolygonal(arr)) {
    // Empty convention (mirrors FlatCoords n=0 → POINT EMPTY).
    if (arr.ringOffsets.length === 0 || arr.partOffsets.length === 0) {
      if (arr.coords.length > 0) {
        throw new GeosError(op, "empty offsets but non-empty coords");
      }
      return geos.empty("polygon");
    }
    return fromPolygonal(geos, arr);
  }

  if (isLineArray(arr)) {
    const { coords, lineOffsets, hasZ, hasM } = arr;
    const stride = strideOf(hasZ, hasM);
    if (lineOffsets.length === 0) {
      throw new GeosError(op, "lineOffsets must not be empty", { jsonPath: "lineOffsets" });
    }
    if (lineOffsets[lineOffsets.length - 1]! * stride > coords.length) {
      throw new GeosError(
        op,
        `coords length ${coords.length} < last lineOffset × stride (${lineOffsets[lineOffsets.length - 1]} × ${stride})`,
      );
    }
    const lines: Geometry[] = [];
    let start = 0;
    for (let l = 0; l < lineOffsets.length; l++) {
      const end: number = lineOffsets[l]!;
      const n = end - start;
      if (n < 2) {
        throw new GeosError(op, `line ${l} has ${n} positions; need ≥ 2`, {
          jsonPath: `lineOffsets[${l}]`,
        });
      }
      lines.push(
        fromCoords(
          geos,
          { coords: coords.subarray(start * stride, end * stride), n, hasZ, hasM },
          "linestring",
        ),
      );
      start = end;
    }
    if (lines.length === 1) return lines[0]!;
    return fromParts(geos, "multilinestring", lines, { transfer: true });
  }

  // FlatCoords → Point (n=1), MultiPoint (n>1), or POINT EMPTY (n=0).
  const { coords, n, hasZ, hasM } = arr;
  const stride = strideOf(hasZ, hasM);
  if (coords.length !== n * stride) {
    throw new GeosError(op, `coords length ${coords.length} != n × stride (${n} × ${stride})`);
  }
  if (n === 0) return geos.empty("point");
  if (n === 1) return fromCoords(geos, arr, "point");
  const points: Geometry[] = [];
  for (let i = 0; i < n; i++) {
    points.push(
      fromCoords(
        geos,
        { coords: coords.subarray(i * stride, (i + 1) * stride), n: 1, hasZ, hasM },
        "point",
      ),
    );
  }
  return fromParts(geos, "multipoint", points, { transfer: true });
}

/** Extract a GeoArrow-shaped value from a geometry. */
export function toArrow(geos: Geos, g: Geometry): ArrowArray {
  g.requireSame(geos);
  geos.assertOpen("toArrow");
  const typeId = geomTypeId(geos, g);
  switch (typeId) {
    case GeoType.Point: {
      if (isEmpty(geos, g)) {
        return { coords: new Float64Array(0), n: 0, hasZ: false, hasM: false };
      }
      return coordinates(geos, g);
    }
    case GeoType.MultiPoint: {
      const n = numGeometries(geos, g);
      // MULTIPOINT EMPTY is indistinguishable from POINT EMPTY in the flat
      // shape — reject rather than silently return a different geometry.
      if (n === 0) {
        throw new GeosError(
          "toArrow",
          "MULTIPOINT EMPTY is not representable in the Phase 1 Arrow shapes (indistinguishable from POINT EMPTY) — Phase 5 adds null bitmaps",
        );
      }
      const flats: FlatCoords[] = [];
      for (let i = 0; i < n; i++) flats.push(coordinates(geos, child(geos, g, i)));
      return concatFlats(flats);
    }
    case GeoType.LineString: {
      const { coords, n, hasZ, hasM } = coordinates(geos, g);
      return { coords, lineOffsets: Int32Array.of(n), hasZ, hasM };
    }
    case GeoType.MultiLineString: {
      const n = numGeometries(geos, g);
      // Representable as an empty LineArray — but fromArrow's empty-offsets
      // rule makes the roundtrip asymmetric, so reject it like MultiPoint.
      if (n === 0) {
        throw new GeosError(
          "toArrow",
          "MULTILINESTRING EMPTY is not representable in the Phase 1 Arrow shapes — Phase 5 adds null bitmaps",
        );
      }
      const parts: LineArray[] = [];
      for (let i = 0; i < n; i++) {
        const { coords, n: cN, hasZ, hasM } = coordinates(geos, child(geos, g, i));
        parts.push({ coords, lineOffsets: Int32Array.of(cN), hasZ, hasM });
      }
      return concatLines(parts);
    }
    case GeoType.Polygon: {
      if (isEmpty(geos, g)) {
        return {
          coords: new Float64Array(0),
          ringOffsets: Int32Array.of(),
          partOffsets: Int32Array.of(),
          hasZ: false,
          hasM: false,
        };
      }
      return polygonalOf(geos, g);
    }
    case GeoType.MultiPolygon: {
      const n = numGeometries(geos, g);
      // Same representability rule as the other empty Multi*: the shape
      // cannot distinguish MULTIPOLYGON EMPTY from POLYGON EMPTY.
      if (n === 0) {
        throw new GeosError(
          "toArrow",
          "MULTIPOLYGON EMPTY is not representable in the Phase 1 Arrow shapes (indistinguishable from POLYGON EMPTY) — Phase 5 adds null bitmaps",
        );
      }
      const parts: Polygonal[] = [];
      for (let i = 0; i < n; i++) parts.push(polygonalOf(geos, child(geos, g, i)));
      return concatPolygons(parts);
    }
    default:
      throw new GeosError(
        "toArrow",
        "GeometryCollection is not representable in the Phase 1 Arrow shapes — extract parts individually (Phase 5 adds full conformance)",
      );
  }
}

function child(geos: Geos, parent: Geometry, i: number): Geometry {
  return geos.borrow(
    geos.native.geos.GEOSGetGeometryN_r(geos.ctx, parent.ptr, i) as GeomPtr | null,
    "GEOSGetGeometryN_r",
  );
}

function concatFlats(parts: FlatCoords[]): FlatCoords {
  const stride = checkHomogeneous(parts);
  const hasZ = parts[0]!.hasZ;
  const hasM = parts[0]!.hasM;
  let total = 0;
  for (const p of parts) total += p.n;
  const coords = new Float64Array(total * stride);
  let off = 0;
  for (const p of parts) {
    coords.set(p.coords, off);
    off += p.coords.length;
  }
  return { coords, n: total, hasZ, hasM };
}

function concatLines(parts: LineArray[]): LineArray {
  const stride = checkHomogeneous(parts);
  const hasZ = parts[0]!.hasZ;
  const hasM = parts[0]!.hasM;
  let totalCoords = 0;
  for (const p of parts) totalCoords += p.lineOffsets[p.lineOffsets.length - 1]!;
  const coords = new Float64Array(totalCoords * stride);
  const lineOffsets = new Int32Array(parts.length);
  let off = 0;
  let count = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    coords.set(p.coords, off);
    off += p.coords.length;
    count += p.lineOffsets[p.lineOffsets.length - 1]!;
    lineOffsets[i] = count;
  }
  return { coords, lineOffsets, hasZ, hasM };
}

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
  const stride = strideOf(hasZ, hasM);
  const ringOffsets = new Int32Array(ringViews.length);
  let total = 0;
  const chunks: Float64Array[] = [];
  for (let r = 0; r < ringViews.length; r++) {
    const c = coordinates(geos, ringViews[r]!);
    total += c.n;
    ringOffsets[r] = total;
    chunks.push(c.coords);
  }
  const coords = new Float64Array(total * stride);
  let off = 0;
  for (const c of chunks) {
    coords.set(c, off);
    off += c.length;
  }
  return { coords, ringOffsets, partOffsets: Int32Array.of(ringViews.length), hasZ, hasM };
}

function concatPolygons(parts: Polygonal[]): Polygonal {
  const stride = checkHomogeneous(parts);
  const hasZ = parts[0]!.hasZ;
  const hasM = parts[0]!.hasM;
  const ringOffsets: number[] = [];
  const partOffsets: number[] = [];
  let totalCoords = 0;
  let totalRings = 0;
  const chunks: Float64Array[] = [];
  for (const p of parts) {
    // Part coords concatenate in order; ring offsets accumulate globally.
    for (let r = 0; r < p.ringOffsets.length; r++) {
      totalRings++;
      totalCoords += p.ringOffsets[r]! - (r === 0 ? 0 : p.ringOffsets[r - 1]!);
      ringOffsets.push(totalCoords);
    }
    partOffsets.push(totalRings);
    chunks.push(p.coords);
  }
  const coords = new Float64Array(totalCoords * stride);
  let off = 0;
  for (const c of chunks) {
    coords.set(c, off);
    off += c.length;
  }
  return {
    coords,
    ringOffsets: Int32Array.from(ringOffsets),
    partOffsets: Int32Array.from(partOffsets),
    hasZ,
    hasM,
  };
}
