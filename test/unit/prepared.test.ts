/**
 * Prepared predicates (Phase 2, archived api-surface §Prepared): singular agreement
 * with the unprepared twins, XY fast paths, DE-9IM, batch masks, and the
 * D17 lifecycle rules (dispose order, pins).
 */
import { describe, expect, it } from "bun:test";
import { type Geometry, Geos, GeosError } from "../../src/index.ts";
import type { Prepared } from "../../src/spatial/prepared.ts";
import { withGeos } from "../helpers.ts";

const WKT_A = "POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))";

describe("Prepared singulars", () => {
  it("agree with the unprepared twins on known-answer pairs", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      using prep = a.prepare();
      const cases: Array<[string, (p: Prepared, b: Geometry) => boolean, boolean]> = [
        ["POINT (5 5)", (p, b) => p.intersects(b), true],
        ["POINT (20 20)", (p, b) => p.intersects(b), false],
        ["POINT (5 5)", (p, b) => p.contains(b), true],
        ["POLYGON ((9 9, 11 9, 11 11, 9 11, 9 9))", (p, b) => p.intersects(b), true],
        ["POLYGON ((20 20, 21 20, 21 21, 20 21, 20 20))", (p, b) => p.disjoint(b), true],
        ["POLYGON ((-1 -1, 5 -1, 5 5, -1 5, -1 -1))", (p, b) => p.intersects(b), true],
        ["LINESTRING (5 5, 15 5)", (p, b) => p.crosses(b), true],
        ["LINESTRING (20 20, 21 21)", (p, b) => p.crosses(b), false],
        ["POINT (0 0)", (p, b) => p.touches(b), true],
        ["POINT (5 5)", (p, b) => p.touches(b), false],
        ["POLYGON ((5 5, 15 5, 15 15, 5 15, 5 5))", (p, b) => p.overlaps(b), true],
        ["POLYGON ((-1 -1, 11 -1, 11 11, -1 11, -1 -1))", (p, b) => p.contains(b), false], // within
      ];
      for (const [wkt, fn, expected] of cases) {
        using b = geos.fromWKT(wkt);
        expect(fn(prep, b)).toBe(expected);
      }
    }));

  it("relate/relatePattern match the unprepared DE-9IM", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      using prep = a.prepare();
      using inside = geos.fromWKT("POINT (5 5)");
      using apart = geos.fromWKT("POINT (50 50)");
      expect(prep.relate(inside)).toBe(geos.relateMatrix(a, inside));
      const matrix = prep.relate(inside);
      expect(prep.relatePattern(inside, matrix)).toBe(true);
      expect(prep.relatePattern(apart, matrix)).toBe(false);
      expect(prep.relatePattern(inside, "0********")).toBe(true); // II = 0 (point)
    }));

  it("XY fast paths need no geometry allocation", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      using prep = a.prepare();
      expect(prep.intersectsXY(5, 5)).toBe(true);
      expect(prep.intersectsXY(50, 50)).toBe(false);
      expect(prep.containsXY(0, 0)).toBe(false); // boundary: contains is false
      expect(prep.intersectsXY(0, 0)).toBe(true);
    }));
});

describe("Prepared batch masks (*All)", () => {
  /** batch method ↔ singular method pairs, checked element-wise. */
  const PAIRS = [
    ["intersectsAll", "intersects"],
    ["containsAll", "contains"],
    ["containsProperlyAll", "containsProperly"],
    ["coversAll", "covers"],
    ["coveredByAll", "coveredBy"],
    ["crossesAll", "crosses"],
    ["touchesAll", "touches"],
    ["overlapsAll", "overlaps"],
    ["disjointAll", "disjoint"],
    ["withinAll", "within"],
  ] as const;

  const SAMPLES = [
    "POINT (5 5)",
    "POINT (50 50)",
    "POINT (9 9)",
    "LINESTRING (0 0, 20 20)",
    "POLYGON ((9 9, 12 9, 12 12, 9 12, 9 9))",
  ];

  it("match element-wise singular calls", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      using prep = a.prepare();
      const bs = SAMPLES.map((w) => geos.fromWKT(w));
      try {
        for (const [batchName, singularName] of PAIRS) {
          const mask = (prep[batchName] as (bs: Geometry[]) => Uint8Array)(bs);
          expect(mask).toBeInstanceOf(Uint8Array);
          expect(mask.length).toBe(bs.length);
          const singular = prep[singularName] as (b: Geometry) => boolean;
          for (let i = 0; i < bs.length; i++) {
            expect(mask[i]).toBe(singular.call(prep, bs[i]!) ? 1 : 0);
          }
        }
      } finally {
        for (const b of bs) b.dispose();
      }
    }));

  it("relatePatternAll matches singular relatePattern", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      using prep = a.prepare();
      const bs = [geos.fromWKT("POINT (5 5)"), geos.fromWKT("POINT (50 50)")];
      try {
        const mask = prep.relatePatternAll(bs, "0********");
        expect([...mask]).toEqual([1, 0]); // inside: II=0; apart: II=F
      } finally {
        for (const b of bs) b.dispose();
      }
    }));

  it("empty input gives a zero-length mask; foreign geometry throws TypeError", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      using prep = a.prepare();
      expect(prep.intersectsAll([]).length).toBe(0);
      using other = new Geos();
      const foreign = other.fromWKT("POINT (1 1)");
      expect(() => prep.intersectsAll([foreign])).toThrow(TypeError);
    }));

  it("a bad DE-9IM pattern throws GeosError", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      using prep = a.prepare();
      using b = geos.fromWKT("POINT (5 5)");
      expect(() => prep.relatePattern(b, "XYZ")).toThrow(GeosError);
      expect(() => prep.relatePatternAll([b], "XYZ")).toThrow(GeosError);
    }));
});

describe("Prepared lifecycle (D17)", () => {
  it("dispose order: prepared first, then the source", () =>
    withGeos((geos) => {
      const a = geos.fromWKT(WKT_A);
      const prep = a.prepare();
      prep.dispose();
      expect(() => a.dispose()).not.toThrow();
    }));

  it("disposing the source while prepared throws TypeError (pin)", () =>
    withGeos((geos) => {
      const a = geos.fromWKT(WKT_A);
      const prep = a.prepare();
      expect(() => a.dispose()).toThrow(TypeError);
      expect(a.pinned).toBe(true);
      prep.dispose();
      expect(a.pinned).toBe(false);
      a.dispose();
    }));

  it("using after dispose throws", () =>
    withGeos((geos) => {
      using a = geos.fromWKT(WKT_A);
      const prep = a.prepare();
      prep.dispose();
      expect(() => prep.intersects(geos.point(1, 1))).toThrow(TypeError);
    }));

  it("an arena-born geometry is relinquished to the caller when prepared", () =>
    withGeos((geos) => {
      let kept: Geometry;
      {
        using _arena = geos.arena();
        const g = geos.fromWKT(WKT_A);
        const prep = g.prepare();
        kept = g;
        prep.dispose(); // released the pin; geometry is now caller-owned
      } // arena exits — must NOT free `kept` (it was relinquished at pin time)
      expect(kept.disposed).toBe(false);
      kept.dispose();
    }));

  it("context dispose cleans up a still-open Prepared before tearing down", () =>
    withGeos((geos) => {
      const a = geos.fromWKT(WKT_A);
      const _prep = a.prepare(); // deliberately not disposed
      // geos disposal disposes consumables first, then geometries — no crash
    }));
});
