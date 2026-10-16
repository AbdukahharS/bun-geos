/**
 * Unit: construction from flat buffers — builders, ring-closure
 * normalization, validation errors, typed empties (M5).
 */
import { describe, expect, it } from "bun:test";
import { Geos, GeoType } from "../../src/index.ts";

describe("fromCoords", () => {
  it("builds points and linestrings (one shim crossing)", () => {
    using geos = new Geos();
    const pt = geos.fromCoords(
      { coords: new Float64Array([1, 2]), n: 1, hasZ: false, hasM: false },
      "point",
    );
    expect(geos.toWKT(pt)).toBe("POINT (1 2)");
    const ls = geos.fromCoords({
      coords: new Float64Array([0, 0, 3, 0, 3, 4]),
      n: 3,
      hasZ: false,
      hasM: false,
    });
    expect(geos.toWKT(ls)).toBe("LINESTRING (0 0, 3 0, 3 4)");
    expect(geos.length(ls)).toBe(7); // 3 + 4
  });

  it("point(x, y) convenience matches fromCoords", () => {
    using geos = new Geos();
    const a = geos.point(5, 6);
    const b = geos.fromCoords(
      { coords: new Float64Array([5, 6]), n: 1, hasZ: false, hasM: false },
      "point",
    );
    expect(geos.equalsIdentical(a, b)).toBe(true);
  });

  it("preserves Z (io.md §6: nothing silently downsamples)", () => {
    using geos = new Geos();
    const g = geos.fromCoords(
      {
        coords: new Float64Array([1, 2, 3]),
        n: 1,
        hasZ: true,
        hasM: false,
      },
      "point",
    );
    expect(g.hasZ).toBe(true);
    expect(g.hasM).toBe(false);
    expect(geos.toWKT(g, { outputDimension: 3 })).toBe("POINT Z (1 2 3)");
  });

  it("rejects non-finite coordinates with vertex detail (D13)", () => {
    using geos = new Geos();
    expect(() =>
      geos.fromCoords({
        coords: new Float64Array([0, 0, Number.NaN, 1]),
        n: 2,
        hasZ: false,
        hasM: false,
      }),
    ).toThrow(/position 1/);
    expect(() =>
      geos.fromCoords({ coords: new Float64Array([0, 0, 1]), n: 2, hasZ: false, hasM: false }),
    ).toThrow(/coords length 3/);
    expect(() =>
      geos.fromCoords({ coords: new Float64Array([0, 0]), n: 1, hasZ: false, hasM: false }),
    ).toThrow(/linestring needs at least 2/);
  });
});

describe("fromPolygonal", () => {
  it("builds a polygon from closed rings, shell + hole", () => {
    using geos = new Geos();
    const g = geos.fromPolygonal({
      coords: new Float64Array([0, 0, 4, 0, 4, 4, 0, 4, 0, 0, 1, 1, 3, 1, 3, 3, 1, 3, 1, 1]),
      ringOffsets: Int32Array.of(5, 10),
      partOffsets: Int32Array.of(2),
      hasZ: false,
      hasM: false,
    });
    expect(geos.isValid(g)).toBe(true);
    expect(geos.area(g)).toBe(12); // 16 − 4
    expect(geos.numInteriorRings(g)).toBe(1);
  });

  it("auto-closes unclosed rings (frozen M5 policy)", () => {
    using geos = new Geos();
    const g = geos.fromPolygonal({
      coords: new Float64Array([0, 0, 4, 0, 4, 4, 0, 4, 1, 1, 3, 1, 3, 3, 1, 3]),
      ringOffsets: Int32Array.of(4, 8),
      partOffsets: Int32Array.of(2),
      hasZ: false,
      hasM: false,
    });
    expect(geos.isValid(g)).toBe(true);
    expect(geos.area(g)).toBe(12);
    // Ring closure is real: the exterior ring starts and ends at (0, 0).
    const ring = geos.exteriorRing(g);
    const { coords, n } = geos.coordinates(ring);
    expect(n).toBe(5);
    expect(coords[0]).toBe(coords[8]);
    expect(coords[1]).toBe(coords[9]);
  });

  it("builds a multipolygon from partOffsets", () => {
    using geos = new Geos();
    const g = geos.fromPolygonal({
      coords: new Float64Array([0, 0, 2, 0, 1, 2, 3, 0, 5, 0, 4, 2]),
      ringOffsets: Int32Array.of(3, 6),
      partOffsets: Int32Array.of(1, 2),
      hasZ: false,
      hasM: false,
    });
    expect(geos.typeId(g)).toBe(GeoType.MultiPolygon);
    expect(geos.numGeometries(g)).toBe(2);
    expect(geos.area(g)).toBeCloseTo(4, 10); // 2 + 2
  });

  it("rejects degenerate rings with precise messages", () => {
    using geos = new Geos();
    const twoPoints = {
      coords: new Float64Array([0, 0, 1, 1]),
      ringOffsets: Int32Array.of(2),
      partOffsets: Int32Array.of(1),
      hasZ: false,
      hasM: false,
    };
    expect(() => geos.fromPolygonal(twoPoints)).toThrow(/ring 0 has 2 positions; need ≥ 3/);
    const badOffsets = {
      coords: new Float64Array([0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0]),
      ringOffsets: Int32Array.of(3, 3),
      partOffsets: Int32Array.of(2),
      hasZ: false,
      hasM: false,
    };
    expect(() => geos.fromPolygonal(badOffsets)).toThrow(/strictly increasing/);
    const badParts = {
      coords: new Float64Array([0, 0, 1, 0, 1, 1]),
      ringOffsets: Int32Array.of(3),
      partOffsets: Int32Array.of(1, 1),
      hasZ: false,
      hasM: false,
    };
    expect(() => geos.fromPolygonal(badParts)).toThrow(/partOffsets/);
  });
});

describe("typed empties (io.md §3)", () => {
  it("creates typed empties per GEOS", () => {
    using geos = new Geos();
    expect(geos.toWKT(geos.empty("point"))).toBe("POINT EMPTY");
    expect(geos.toWKT(geos.empty("linestring"))).toBe("LINESTRING EMPTY");
    expect(geos.toWKT(geos.empty("polygon"))).toBe("POLYGON EMPTY");
    expect(geos.toWKT(geos.empty("multipoint"))).toBe("MULTIPOINT EMPTY");
    expect(geos.toWKT(geos.empty("geometrycollection"))).toBe("GEOMETRYCOLLECTION EMPTY");
  });

  it("empty polygon behaves consistently (Shapely-2 target)", () => {
    using geos = new Geos();
    const e = geos.empty("polygon");
    expect(geos.isEmpty(e)).toBe(true);
    expect(geos.area(e)).toBe(0);
    expect(geos.isValid(e)).toBe(true);
  });
});
