/**
 * Unit: I/O layer — WKT / WKB(+EWKB) / GeoJSON / Arrow adapters (M6), the
 * error-quality table (io.md §7), and boundary rules (no aliasing, owned
 * strings freed, pooled readers).
 */
import { describe, expect, it } from "bun:test";
import { Geos } from "../../src/index.ts";
import { toHex } from "../helpers.ts";

const POLY = "POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0), (1 1, 3 1, 3 3, 1 3, 1 1))";

describe("WKT", () => {
  it("roundtrips trimmed WKT by default (Shapely-2 style)", () => {
    using geos = new Geos();
    const g = geos.fromWKT(POLY);
    expect(geos.toWKT(g)).toBe(POLY);
  });

  it("writer options apply (precision, dimension, old3D)", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT Z (1.23456 2.34567 3.45678)");
    expect(geos.toWKT(g, { precision: 2, outputDimension: 3 })).toBe("POINT Z (1.23 2.35 3.46)");
    expect(geos.toWKT(g, { outputDimension: 3, old3D: true })).toMatch(
      /POINT \(1\.23456 2\.34567 3\.45678\)/,
    );
  });

  it("Z/M detection survives the roundtrip", () => {
    using geos = new Geos();
    const z = geos.fromWKT("POINT Z (1 2 3)");
    expect(z.hasZ).toBe(true);
    expect(z.hasM).toBe(false);
    const zm = geos.fromWKT("POINT ZM (1 2 3 4)");
    expect(zm.hasZ).toBe(true);
    expect(zm.hasM).toBe(true);
  });
});

describe("WKB", () => {
  it("roundtrips byte-identically at fixed settings, both byte orders", () => {
    using geos = new Geos();
    const g = geos.fromWKT(POLY);
    for (const byteOrder of ["little", "big"] as const) {
      const bytes = geos.toWKB(g, { byteOrder });
      const back = geos.fromWKB(bytes);
      const again = geos.toWKB(back, { byteOrder });
      expect(toHex(again)).toBe(toHex(bytes));
    }
  });

  it("EWKB SRID rides along natively (PostGIS bytea shape)", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT (1 2)");
    geos.setSrid(g, 4326);
    const ewkb = geos.toWKB(g, { includeSRID: true, flavor: "extended", byteOrder: "little" });
    // EWKB header: little-endian byte 0x01, type | 0x20000000 (SRID flag), srid, x, y
    expect(ewkb.length).toBe(25);
    const view = new DataView(ewkb.buffer, ewkb.byteOffset, ewkb.byteLength);
    expect(view.getUint8(0)).toBe(1);
    expect(view.getUint32(1, true) & 0x20000000).not.toBe(0);
    expect(view.getUint32(5, true)).toBe(4326);
    const back = geos.fromWKB(ewkb);
    expect(geos.srid(back)).toBe(4326);
    expect(geos.equalsIdentical(back, g)).toBe(true);
  });

  it("includeSRID without extended flavor is a programming error (D13)", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT (0 0)");
    expect(() => geos.toWKB(g, { includeSRID: true })).toThrow(RangeError);
  });

  it("malformed WKB throws GeosError with the GEOS message", () => {
    using geos = new Geos();
    const junk = new Uint8Array([1, 2, 3]);
    expect(() => geos.fromWKB(junk)).toThrow(/GEOSWKBReader_read_r/);
  });

  it("output never aliases C memory (two writes give independent buffers)", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT (1 1)");
    const w1 = geos.toWKB(g);
    const w2 = geos.toWKB(g);
    expect(w1).not.toBe(w2); // distinct JS objects…
    expect(toHex(w1)).toBe(toHex(w2)); // …same content
  });
});

describe("GeoJSON", () => {
  it("roundtrips all geometry types", () => {
    using geos = new Geos();
    const cases = [
      "POINT (1 2)",
      "LINESTRING (0 0, 1 1, 2 0)",
      POLY,
      "MULTIPOINT ((0 0), (2 2))",
      "MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))",
      "MULTIPOLYGON (((0 0, 1 0, 0 1, 0 0)), ((2 0, 3 0, 2 1, 2 0)))",
      "GEOMETRYCOLLECTION (POINT (1 1), LINESTRING (0 0, 1 1))",
    ];
    for (const wkt of cases) {
      const g = geos.fromWKT(wkt);
      const back = geos.fromGeoJSON(geos.toGeoJSON(g));
      expect(geos.equalsIdentical(g, back), wkt).toBe(true);
    }
  });

  it("preserves Z as 3-length positions", () => {
    using geos = new Geos();
    const g = geos.fromWKT("LINESTRING Z (0 0 1, 1 1 2)");
    const gj = geos.toGeoJSON(g);
    expect(gj.coordinates).toEqual([
      [0, 0, 1],
      [1, 1, 2],
    ]);
    const back = geos.fromGeoJSON(gj);
    expect(back.hasZ).toBe(true);
  });

  it("feature members survive round-trips via userData (io.md §3)", () => {
    using geos = new Geos();
    const feature = {
      type: "Feature" as const,
      geometry: { type: "Point", coordinates: [7, 8] },
      properties: { name: "depot" },
      id: 42,
    };
    const g = geos.fromGeoJSON(feature);
    expect(g.userData).toEqual({ properties: { name: "depot" }, id: 42 });
    const out = geos.toGeoJSON(g);
    expect(out.id).toBe(42);
    expect(out.properties).toEqual({ name: "depot" });
    expect(out.type).toBe("Point");
    expect(out.coordinates).toEqual([7, 8]);
  });

  it("winding is preserved as input (no silent normalization)", () => {
    using geos = new Geos();
    // RFC 7946 recommends CCW exteriors; feed CW and expect CW back.
    const cw = "POLYGON ((0 0, 0 1, 1 1, 1 0, 0 0))";
    const g = geos.fromGeoJSON(geos.toGeoJSON(geos.fromWKT(cw)));
    expect(geos.equalsIdentical(g, geos.fromWKT(cw))).toBe(true);
  });

  it("empty coordinates produce typed empties", () => {
    using geos = new Geos();
    expect(geos.toWKT(geos.fromGeoJSON({ type: "Point", coordinates: [] }))).toBe("POINT EMPTY");
    expect(geos.toWKT(geos.fromGeoJSON({ type: "Polygon", coordinates: [] }))).toBe(
      "POLYGON EMPTY",
    );
  });

  it("data errors carry JSON paths and indices (io.md §7)", () => {
    using geos = new Geos();
    expect(() =>
      geos.fromGeoJSON({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 1],
          ],
        ],
      }),
    ).toThrow(/ring 0 has 2 positions; need ≥ 3/);
    expect(() =>
      geos.fromGeoJSON({
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
          ],
        ],
      }),
    ).not.toThrow(); // 3 positions auto-close into a valid ring (M5 policy)
    expect(() => geos.fromGeoJSON({ type: "Point", coordinates: [0, "x"] })).toThrow(
      /coordinates\[1\]/,
    );
    expect(() => geos.fromGeoJSON({ type: "Point", coordinates: [Number.NaN, 0] })).toThrow(
      /finite/,
    );
    expect(() => geos.fromGeoJSON({ type: "Circle", coordinates: [] })).toThrow(
      /unknown GeoJSON type/,
    );
    expect(() => geos.fromGeoJSON({ type: "Feature", geometry: null })).toThrow(/null geometry/);
  });
});

describe("GeoArrow (Phase 1 shapes)", () => {
  it("roundtrips point/multipoint/lines/polygons", () => {
    using geos = new Geos();
    const point = geos.fromWKT("POINT (1 2)");
    expect(geos.equalsIdentical(geos.fromArrow(geos.toArrow(point)), point)).toBe(true);

    const mp = geos.fromWKT("MULTIPOINT ((0 0), (2 2))");
    expect(geos.equalsIdentical(geos.fromArrow(geos.toArrow(mp)), mp)).toBe(true);

    const ls = geos.fromWKT("LINESTRING (0 0, 1 1, 2 0)");
    expect(geos.equalsIdentical(geos.fromArrow(geos.toArrow(ls)), ls)).toBe(true);

    const ml = geos.fromWKT("MULTILINESTRING ((0 0, 1 1), (2 2, 3 3))");
    expect(geos.equalsIdentical(geos.fromArrow(geos.toArrow(ml)), ml)).toBe(true);

    const poly = geos.fromWKT(POLY);
    expect(geos.equalsIdentical(geos.fromArrow(geos.toArrow(poly)), poly)).toBe(true);

    const mpoly = geos.fromWKT("MULTIPOLYGON (((0 0, 1 0, 0 1, 0 0)), ((2 0, 3 0, 2 1, 2 0)))");
    expect(geos.equalsIdentical(geos.fromArrow(geos.toArrow(mpoly)), mpoly)).toBe(true);
  });

  it("GeometryCollection is rejected honestly (Phase 5 conformance)", () => {
    using geos = new Geos();
    const col = geos.fromWKT("GEOMETRYCOLLECTION (POINT (1 1))");
    expect(() => geos.toArrow(col)).toThrow(/Phase 5/);
  });

  it("validation errors name the offending structure", () => {
    using geos = new Geos();
    expect(() =>
      geos.fromArrow({ coords: new Float64Array([0, 0, 1]), n: 2, hasZ: false, hasM: false }),
    ).toThrow(/coords length 3/);
    expect(() =>
      geos.fromArrow({
        coords: new Float64Array([0, 0, 1, 1]),
        lineOffsets: Int32Array.of(1),
        hasZ: false,
        hasM: false,
      }),
    ).toThrow(/line 0 has 1 positions/);
  });
});
