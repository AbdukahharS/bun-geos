/**
 * Unit: the operation surface — predicates, overlays, buffer, measures,
 * envelope/accessors — against hand-computed known answers (M7).
 */
import { describe, expect, it } from "bun:test";
import { Geos } from "../../src/index.ts";

/** Unit square (0,0)-(2,2) and its overlap square (1,1)-(3,3). */
const SQ_A = "POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))";
const SQ_B = "POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))";

describe("predicates (unprepared)", () => {
  it("agrees with hand-computed DE-9IM facts", () => {
    using geos = new Geos();
    const a = geos.fromWKT(SQ_A);
    const b = geos.fromWKT(SQ_B);
    expect(geos.intersects(a, b)).toBe(true);
    expect(geos.disjoint(a, b)).toBe(false);
    expect(geos.touches(a, b)).toBe(false); // interiors intersect
    expect(geos.contains(a, b)).toBe(false);
    expect(geos.within(a, b)).toBe(false);
    expect(geos.overlaps(a, b)).toBe(true);
    expect(geos.covers(a, geos.intersection(a, b))).toBe(true);
    expect(geos.coveredBy(a, b)).toBe(false);
    expect(geos.equals(a, b)).toBe(false);
  });

  it("covers vs contains on the boundary (the classic gotcha)", () => {
    using geos = new Geos();
    const a = geos.fromWKT(SQ_A);
    const edge = geos.fromWKT("LINESTRING (0 0, 2 0)");
    expect(geos.contains(a, edge)).toBe(false); // boundary is not interior
    expect(geos.covers(a, edge)).toBe(true);
  });

  it("equalsIdentical is exact; equals is topological", () => {
    using geos = new Geos();
    const a = geos.fromWKT("POINT (1 1)");
    const b = geos.fromWKT("POINT (1.0 1.0)");
    expect(geos.equalsIdentical(a, b)).toBe(true);
    // Topological equality ignores order: same ring, different start.
    const p1 = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
    const p2 = geos.fromWKT("POLYGON ((0 2, 0 0, 2 0, 2 2, 0 2))");
    expect(geos.equals(p1, p2)).toBe(true);
    expect(geos.equalsIdentical(p1, p2)).toBe(false);
    void a;
    void b;
  });

  it("relateMatrix matches the pattern form", () => {
    using geos = new Geos();
    const a = geos.fromWKT(SQ_A);
    const b = geos.fromWKT(SQ_B);
    const matrix = geos.relateMatrix(a, b);
    expect(matrix).toBe("212101212");
    expect(geos.relatesPattern(a, b, "2********")).toBe(true);
    expect(geos.relatesPattern(a, b, matrix)).toBe(true);
  });
});

describe("overlays (OverlayNGRobust)", () => {
  it("intersection/union/difference/symDifference known answers", () => {
    using geos = new Geos();
    const a = geos.fromWKT(SQ_A);
    const b = geos.fromWKT(SQ_B);
    expect(geos.area(geos.intersection(a, b))).toBeCloseTo(1, 12);
    expect(geos.area(geos.union(a, b))).toBeCloseTo(7, 12);
    expect(geos.area(geos.difference(a, b))).toBeCloseTo(3, 12);
    expect(geos.area(geos.symDifference(a, b))).toBeCloseTo(6, 12);
  });

  it("overlay outputs are valid on valid inputs (robustness contract)", () => {
    using geos = new Geos();
    const a = geos.fromWKT(SQ_A);
    const b = geos.fromWKT(SQ_B);
    for (const out of [
      geos.intersection(a, b),
      geos.union(a, b),
      geos.difference(a, b),
      geos.symDifference(a, b),
    ]) {
      expect(geos.isValid(out)).toBe(true);
    }
  });

  it("unaryUnion dissolves a touching pair", () => {
    using geos = new Geos();
    const twoSquares = geos.fromWKT(
      "MULTIPOLYGON (((0 0, 1 0, 1 1, 0 1, 0 0)), ((1 0, 2 0, 2 1, 1 1, 1 0)))",
    );
    const merged = geos.unaryUnion(twoSquares);
    expect(geos.typeId(merged)).toBe(3); // Polygon
    expect(geos.area(merged)).toBeCloseTo(2, 12);
  });
});

describe("buffer", () => {
  it("round buffer area matches the analytic estimate", () => {
    using geos = new Geos();
    const sq = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
    const b = geos.buffer(sq, 0.5, { quadSegs: 32 });
    // 1 + perimeter·d + πd²
    expect(geos.area(b)).toBeCloseTo(1 + 4 * 0.5 + Math.PI * 0.25, 2);
  });

  it("mitre buffer is exact for a square", () => {
    using geos = new Geos();
    const sq = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
    const b = geos.buffer(sq, 1, { join: "mitre", mitreLimit: 2 });
    expect(geos.area(b)).toBeCloseTo(9, 10); // (1 + 2·1)²
  });

  it("buffer options accept bevel and singleSided without error", () => {
    using geos = new Geos();
    const line = geos.fromWKT("LINESTRING (0 0, 4 0)");
    const single = geos.buffer(line, 0.5, { singleSided: true });
    expect(geos.area(single)).toBeCloseTo(2, 6); // 4 × 0.5, one side
    const bevel = geos.buffer(line, 0.5, { join: "bevel" });
    expect(geos.area(bevel)).toBeGreaterThan(0);
  });
});

describe("measures", () => {
  it("area/length/distance/hausdorff/frechet known answers", () => {
    using geos = new Geos();
    const tri = geos.fromWKT("POLYGON ((0 0, 4 0, 0 3, 0 0))");
    expect(geos.area(tri)).toBeCloseTo(6, 12);
    expect(geos.length(tri)).toBeCloseTo(12, 10); // 4 + 3 + 5
    const far = geos.fromWKT("POINT (3 4)");
    const origin = geos.fromWKT("POINT (0 0)");
    expect(geos.distance(far, origin)).toBeCloseTo(5, 12);
    const l1 = geos.fromWKT("LINESTRING (0 0, 0 1)");
    const l2 = geos.fromWKT("LINESTRING (10 0, 10 1)");
    expect(geos.hausdorff(l1, l2)).toBeCloseTo(10, 6);
    expect(geos.frechet(l1, l2)).toBeCloseTo(10, 6);
  });
});

describe("envelope & accessors", () => {
  it("envelope of a triangle is its bounding box", () => {
    using geos = new Geos();
    const tri = geos.fromWKT("POLYGON ((1 1, 5 2, 2 4, 1 1))");
    const env = geos.envelope(tri);
    expect(geos.toWKT(env, { precision: 0 })).toBe("POLYGON ((1 1, 5 1, 5 4, 1 4, 1 1))");
  });

  it("structure accessors walk polygons and collections", () => {
    using geos = new Geos();
    const col = geos.fromWKT(
      "GEOMETRYCOLLECTION (POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0)), POINT (5 5))",
    );
    expect(geos.numGeometries(col)).toBe(2);
    const first = geos.getGeometryN(col, 0);
    expect(first.owned).toBe(false); // borrowed view
    expect(geos.geomType(first)).toBe("Polygon");
    expect(geos.numInteriorRings(first)).toBe(0);
    const ring = geos.exteriorRing(first);
    expect(geos.numPoints(ring)).toBe(5);
    expect(geos.isEmpty(first)).toBe(false);
  });

  it("SRID round-trips natively (GEOSGetSRID_r / GEOSSetSRID_r)", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT (0 0)");
    expect(geos.srid(g)).toBeNull();
    geos.setSrid(g, 3857);
    expect(geos.srid(g)).toBe(3857);
    geos.setSrid(g, null);
    expect(geos.srid(g)).toBeNull();
  });

  it("coordinates() extracts the canonical flat buffer", () => {
    using geos = new Geos();
    const ls = geos.fromWKT("LINESTRING (0 0, 1 2)");
    const { coords, n, hasZ, hasM } = geos.coordinates(ls);
    expect(n).toBe(2);
    expect(hasZ).toBe(false);
    expect(hasM).toBe(false);
    expect([...coords]).toEqual([0, 0, 1, 2]);
    const poly = geos.fromWKT(SQ_A);
    expect(() => geos.coordinates(poly)).toThrow(/toArrow|toGeoJSON/);
  });
});
