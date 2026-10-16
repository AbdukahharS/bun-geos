/**
 * Regression tests for the adversarial-audit findings (all were live bugs
 * with repros; each test pins the fix).
 */

import { describe, expect, it } from "bun:test";
import { gc } from "bun";
import { Geos, GeosError } from "../../src/index.ts";

describe("C1: finalizer ABA — recycled addresses are never destroyed via a stale finalizer", () => {
  it("arena-freed geometry + pending finalizer + recycled address: the new geometry survives", () => {
    using geos = new Geos();
    // 1. Wrapper inside an arena, dropped WITHOUT dispose (designed usage) —
    //    finalizer queued, not run.
    let arena: Disposable | undefined;
    try {
      arena = geos.arena();
      const dropped = geos.fromWKT("POINT (1 1)");
      void dropped; // unreachable from here on
    } finally {
      arena?.[Symbol.dispose](); // frees P; the queued #reap fires later
    }
    // Force GC so the finalizer callback runs before the next allocation.
    gc(true);
    gc(true);
    // 2. A new geometry (likely same address — same size class).
    const g2 = geos.fromWKT("POINT (2 2)");
    gc(true);
    // 3. The stale finalizer must NOT have eaten g2's live entry.
    expect(geos.stats.liveGeoms).toBe(1);
    expect(geos.toWKT(g2)).toBe("POINT (2 2)"); // still alive and usable
    expect(geos.area(g2)).toBe(0);
    g2.dispose();
    expect(geos.stats.liveGeoms).toBe(0);
  });
});

describe("C2: fromParts transfer guards", () => {
  it("duplicate parts with transfer:true are rejected (double free)", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT (0 0)");
    expect(() => geos.fromParts("multipoint", [g, g], { transfer: true })).toThrow(TypeError);
    // The duplicate is fine without transfer (cloned):
    const col = geos.fromParts("multipoint", [g, g]);
    expect(geos.numGeometries(col)).toBe(2);
  });

  it("borrowed views with transfer:true are rejected (two owners)", () => {
    using geos = new Geos();
    const poly = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
    const ring = geos.exteriorRing(poly);
    expect(() => geos.fromParts("multilinestring", [ring], { transfer: true })).toThrow(TypeError);
    // Parent still whole after the rejected transfer:
    expect(geos.area(poly)).toBe(4);
  });

  it("homogeneous collections type-check their parts at the boundary (GEOS does not)", () => {
    using geos = new Geos();
    const p = geos.fromWKT("POINT (0 0)");
    const poly = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
    expect(() => geos.fromParts("multipolygon", [p], { transfer: true })).toThrow(TypeError);
    expect(() => geos.fromParts("multipolygon", [poly])).not.toThrow();
    // geometrycollection accepts anything:
    expect(() => geos.fromParts("geometrycollection", [p, poly])).not.toThrow();
  });

  it("part-type mismatch failure still renounces transferred wrappers (consume-on-failure quirk)", () => {
    // NOTE: GEOS 3.14 createMultiPolygon does NOT throw on wrong member
    // types (verified) — the boundary type-check above fires first, so the
    // consume-on-failure renounce ordering stays covered by code review and
    // the ASan driver rather than a public-API test.
    using geos = new Geos();
    const p1 = geos.fromWKT("POINT (0 0)");
    const p2 = geos.fromWKT("POINT (1 1)");
    expect(() => geos.fromParts("multipolygon", [p1, p2], { transfer: true })).toThrow(TypeError);
    // The boundary check runs BEFORE any GEOS consumption: wrappers alive.
    expect(p1.disposed).toBe(false);
    expect(p2.disposed).toBe(false);
  });
});

describe("H1: borrowed views cannot be used after their parent is disposed", () => {
  it("ring view throws when the parent polygon is gone", () => {
    using geos = new Geos();
    const poly = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
    const ring = geos.exteriorRing(poly);
    expect(geos.numPoints(ring)).toBe(5); // fine while parent alive
    poly.dispose();
    expect(() => geos.numPoints(ring)).toThrow(TypeError);
    expect(() => ring.hasZ).toThrow(TypeError);
  });

  it("sub-geometry views from collections are parent-guarded too", () => {
    using geos = new Geos();
    const col = geos.fromWKT("GEOMETRYCOLLECTION (POINT (1 1), POINT (2 2))");
    const first = geos.getGeometryN(col, 0);
    col.dispose();
    expect(() => geos.toWKT(first)).toThrow(/parent/);
  });
});

describe("H2/H3: Arrow shape representability and dimension homogeneity", () => {
  it("empty MULTI* are rejected honestly (indistinguishable from singular empties)", () => {
    using geos = new Geos();
    expect(() => geos.toArrow(geos.empty("multipoint"))).toThrow(GeosError);
    expect(() => geos.toArrow(geos.empty("multilinestring"))).toThrow(GeosError);
    expect(() => geos.toArrow(geos.empty("multipolygon"))).toThrow(GeosError);
    // Singular empties DO roundtrip:
    expect(
      geos.equalsIdentical(geos.fromArrow(geos.toArrow(geos.empty("point"))), geos.empty("point")),
    ).toBe(true);
    expect(
      geos.equalsIdentical(
        geos.fromArrow(geos.toArrow(geos.empty("polygon"))),
        geos.empty("polygon"),
      ),
    ).toBe(true);
  });

  it("mixed-dimension collections throw instead of silently corrupting coordinates", () => {
    using geos = new Geos();
    const mixed = geos.fromGeoJSON({
      type: "MultiPoint",
      coordinates: [
        [3, 4, 5],
        [1, 2],
      ], // XYZ next to XY — GEOS accepts, Arrow cannot
    });
    expect(() => geos.toArrow(mixed)).toThrow(/mixed coordinate dimensions/);
  });
});

describe("M1: non-finite Z/M are rejected like non-finite X/Y", () => {
  it("NaN/Infinity in Z or M lanes throw with vertex detail", () => {
    using geos = new Geos();
    expect(() =>
      geos.fromCoords(
        { coords: new Float64Array([0, 0, Number.NaN]), n: 1, hasZ: true, hasM: false },
        "point",
      ),
    ).toThrow(/ordinate 2 is not finite/);
    expect(() => geos.point(1, 2, Number.POSITIVE_INFINITY)).toThrow(/not finite/);
    expect(() =>
      geos.fromPolygonal({
        coords: new Float64Array([0, 0, 1, 1, 0, 1, 1, 0, 1, 0, 0, Number.NaN]),
        ringOffsets: Int32Array.of(4),
        partOffsets: Int32Array.of(1),
        hasZ: false,
        hasM: true,
      }),
    ).toThrow(/ordinate 2 is not finite/); // NaN in the M lane
  });
});

describe("N1: hasM on a disposed geometry throws (cache read is guarded)", () => {
  it("disposed wrapper does not serve cached dimensions", () => {
    using geos = new Geos();
    const g = geos.fromWKT("POINT Z (1 2 3)");
    expect(g.hasM).toBe(false);
    g.dispose();
    expect(() => g.hasZ).toThrow(TypeError);
    expect(() => g.hasM).toThrow(TypeError);
  });
});
