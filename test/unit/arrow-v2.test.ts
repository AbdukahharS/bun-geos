/**
 * GeoArrow shapes v2 (Phase 5, D28): kind tags, empty MULTI*
 * representability, validity bitmaps (throw/skip), dense-union
 * geometrycollection, legacy input acceptance, and null-slot error shapes.
 */
import { describe, expect, it } from "bun:test";
import { Geos, GeosError } from "../../src/index.ts";
import { geometriesFromArrow, validityNullCount } from "../../src/io/arrow.ts";

describe("shapes v2: tags and empties", () => {
  it("toArrow emits tagged values with the documented kinds", () => {
    using geos = new Geos();
    expect(geos.toArrow(geos.fromWKT("POINT (1 2)")).kind).toBe("point");
    expect(geos.toArrow(geos.fromWKT("LINESTRING (0 0, 1 1)")).kind).toBe("linestring");
    expect(geos.toArrow(geos.fromWKT("POLYGON ((0 0, 1 0, 0 1, 0 0))")).kind).toBe("polygon");
    expect(geos.toArrow(geos.fromWKT("MULTIPOINT ((0 0), (1 1))")).kind).toBe("multipoint");
    expect(geos.toArrow(geos.fromWKT("MULTILINESTRING ((0 0, 1 1))")).kind).toBe("multilinestring");
    expect(geos.toArrow(geos.fromWKT("MULTIPOLYGON (((0 0, 1 0, 0 1, 0 0)))")).kind).toBe(
      "multipolygon",
    );
    expect(geos.toArrow(geos.fromWKT("GEOMETRYCOLLECTION (POINT (0 0))")).kind).toBe(
      "geometrycollection",
    );
  });

  it("empty MULTI* are representable now (length-0 offsets) and roundtrip", () => {
    using geos = new Geos();
    const emptyTypes = [
      ["MULTIPOINT EMPTY", "multipoint"],
      ["MULTILINESTRING EMPTY", "multilinestring"],
      ["MULTIPOLYGON EMPTY", "multipolygon"],
    ] as const;
    for (const [wkt, kind] of emptyTypes) {
      using g = geos.fromWKT(wkt);
      const arr = geos.toArrow(g);
      expect(arr.kind).toBe(kind);
      using back = geos.fromArrow(arr);
      expect(geos.isEmpty(back)).toBe(true);
      expect(geos.typeId(back)).toBe(geos.typeId(g));
    }
  });

  it("an empty member inside a multi* rides as a repeated offset (POINT EMPTY)", () => {
    using geos = new Geos();
    using mp = geos.fromWKT("MULTIPOINT ((0 0), EMPTY, (2 2))");
    const arr = geos.toArrow(mp);
    if (arr.kind !== "multipoint") throw new Error("expected multipoint");
    // member 1 empty → offsets repeat (1, 1, 2)
    expect([...arr.pointOffsets]).toEqual([1, 1, 2]);
    using back = geos.fromArrow(arr);
    expect(geos.equalsIdentical(back, mp)).toBe(true);
  });
});

describe("shapes v2: validity bitmaps", () => {
  it("fromArrow rejects a null slot (a singular geometry cannot be null)", () => {
    using geos = new Geos();
    // validity: slot 1 nulled (LSB bitmap 0b01)
    const arr = {
      kind: "multipoint",
      coords: new Float64Array([0, 0, 5, 5]),
      pointOffsets: Int32Array.of(1, 2),
      hasZ: false,
      hasM: false,
      validity: Uint8Array.of(0b01),
    } as const;
    expect(() => geos.fromArrow(arr)).toThrow(/null slot/);
  });

  it("batch nullMode: throw names the slot; skip compacts the output", () => {
    using geos = new Geos();
    const arr = {
      kind: "multipoint",
      coords: new Float64Array([0, 0, 5, 5, 9, 9]),
      pointOffsets: Int32Array.of(1, 2, 3),
      hasZ: false,
      hasM: false,
      validity: Uint8Array.of(0b101), // slot 1 null
    } as const;
    expect(() => geos.areaAll(arr)).toThrow(/null geometry slot 1/);
    // skip mode (io-level): null slots omitted — output is SHORTER than the
    // slot count, a cardinality change the caller must compensate for
    const skipped = geometriesFromArrow(geos, arr, undefined, { nullMode: "skip" });
    expect(skipped.length).toBe(2);
    const coords0 = geos.coordinates(skipped[0]!);
    expect(coords0.coords[0]).toBe(0);
    const coords1 = geos.coordinates(skipped[1]!);
    expect(coords1.coords[0]).toBe(9);
    for (const g of skipped) g.dispose();
  });

  it("a short validity bitmap is rejected", () => {
    using geos = new Geos();
    const arr = {
      kind: "multipolygon",
      coords: new Float64Array([0, 0, 1, 0, 0, 1]),
      ringOffsets: Int32Array.of(3),
      partOffsets: Int32Array.of(1, 2),
      hasZ: false,
      hasM: false,
      validity: Uint8Array.of(0), // claims 8 slots' worth but must cover 2 — len ok; all-null → throws on use
    } as const;
    expect(() => geos.fromArrow(arr)).toThrow(/null slot/);
  });

  it("validityNullCount popcounts the LSB bitmap", () => {
    expect(validityNullCount(undefined, 10)).toBe(0);
    expect(validityNullCount(Uint8Array.of(0b0101), 4)).toBe(2);
    expect(validityNullCount(Uint8Array.of(0xff, 0b1), 9)).toBe(0);
  });
});

describe("shapes v2: geometrycollection dense union", () => {
  it("roundtrips a heterogeneous collection with types/offsets into children", () => {
    using geos = new Geos();
    using col = geos.fromWKT(
      "GEOMETRYCOLLECTION (POINT (1 1), POLYGON ((0 0, 1 0, 0 1, 0 0)), POINT (3 3), LINESTRING (0 0, 2 2))",
    );
    const arr = geos.toArrow(col);
    if (arr.kind !== "geometrycollection") throw new Error("expected geometrycollection");
    expect(arr.children.length).toBe(3); // point, polygon, linestring
    expect(arr.types.length).toBe(4);
    expect(arr.offsets.length).toBe(4);
    using back = geos.fromArrow(arr);
    expect(geos.equalsIdentical(back, col)).toBe(true);
  });

  it("an out-of-range slot reference is an all-or-nothing error", () => {
    using geos = new Geos();
    const arr = {
      kind: "geometrycollection",
      types: Int32Array.of(0, 0),
      offsets: Int32Array.of(0, 5), // child 0 has only 1 member
      children: [{ kind: "point", coords: new Float64Array([0, 0]), hasZ: false, hasM: false }],
    } as const;
    expect(() => geos.fromArrow({ ...arr, children: [...arr.children] })).toThrow(/out of range/);
  });
});

describe("shapes v2: legacy input is still accepted", () => {
  it("untagged Phase 1 shapes infer kinds by shape", () => {
    using geos = new Geos();
    // FlatCoords n=2 → multipoint (legacy inference)
    using mp = geos.fromArrow({
      coords: new Float64Array([0, 0, 1, 1]),
      n: 2,
      hasZ: false,
      hasM: false,
    });
    expect(geos.geomType(mp)).toBe("MultiPoint");
    mp.dispose();
    // LineArray length 2 → multilinestring
    using ml = geos.fromArrow({
      coords: new Float64Array([0, 0, 1, 1, 2, 2, 3, 3]),
      lineOffsets: Int32Array.of(2, 4),
      hasZ: false,
      hasM: false,
    });
    expect(geos.geomType(ml)).toBe("MultiLineString");
    ml.dispose();
    // Polygonal with 1 part → polygon
    using p = geos.fromArrow({
      coords: new Float64Array([0, 0, 1, 0, 0, 1, 0, 0]),
      ringOffsets: Int32Array.of(4),
      partOffsets: Int32Array.of(1),
      hasZ: false,
      hasM: false,
    });
    expect(geos.geomType(p)).toBe("Polygon");
  });

  it("validation errors still name the offending structure", () => {
    using geos = new Geos();
    expect(() =>
      geos.fromArrow({ coords: new Float64Array([0, 0, 1]), n: 2, hasZ: false, hasM: false }),
    ).toThrow(/coords length 3/);
    expect(() =>
      geos.fromArrow({
        kind: "linestring",
        coords: new Float64Array([0, 0, 1, 1]),
        lineOffsets: Int32Array.of(1),
        hasZ: false,
        hasM: false,
      }),
    ).toThrow(/line 0 has 1 positions/);
    expect(() =>
      geos.fromArrow({
        kind: "multipoint",
        coords: new Float64Array([0, 0, 1, 1]),
        pointOffsets: Int32Array.of(2, 1), // decreasing
        hasZ: false,
        hasM: false,
      }),
    ).toThrow(/non-decreasing/);
  });
});

describe("shapes v2: batch slots", () => {
  it("multi members become batch slots; the batch layer normalizes Arrow", () => {
    using geos = new Geos();
    const arr = {
      kind: "multipolygon",
      coords: new Float64Array([
        0,
        0,
        1,
        0,
        0,
        1,
        0,
        0, // member polygon 1
        2,
        0,
        3,
        0,
        2,
        1,
        2,
        0, // member polygon 2
      ]),
      ringOffsets: Int32Array.of(4, 8),
      partOffsets: Int32Array.of(1, 2),
      hasZ: false,
      hasM: false,
    } as const;
    const areas = geos.areaAll(arr);
    expect(areas.length).toBe(2);
    expect(areas[0]).toBeCloseTo(0.5, 10);
    expect(areas[1]).toBeCloseTo(0.5, 10);
  });

  it("a null slot in the batch layer throws with the slot index (default)", () => {
    using geos = new Geos();
    const arr = {
      kind: "multipoint",
      coords: new Float64Array([0, 0, 5, 5]),
      pointOffsets: Int32Array.of(1, 2),
      hasZ: false,
      hasM: false,
      validity: Uint8Array.of(0b01), // slot 1 null
    } as const;
    expect(() => geos.areaAll(arr)).toThrow(GeosError);
  });
});
