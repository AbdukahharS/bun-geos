/**
 * Repair suite (Phase 2): makeValid, isValidDetail/isSimpleDetail, coverage
 * algebra, orientPolygons.
 */
import { describe, expect, it } from "bun:test";
import { type Geometry, Geos } from "../../src/index.ts";
import { withGeos } from "../helpers.ts";

const BOWTIE = "POLYGON ((0 0, 2 2, 2 0, 0 2, 0 0))";

function tile(geos: Parameters<Parameters<typeof withGeos>[0]>[0], i: number, j: number): Geometry {
  const x = i;
  const y = j;
  return geos.fromWKT(
    `POLYGON ((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`,
  );
}

describe("makeValid", () => {
  it("repairs a bowtie into a valid geometry with the expected area", () =>
    withGeos((geos) => {
      using bowtie = geos.fromWKT(BOWTIE);
      expect(geos.isValid(bowtie)).toBe(false);
      using fixed = geos.makeValid(bowtie);
      expect(geos.isValid(fixed)).toBe(true);
      expect(geos.area(fixed)).toBeCloseTo(2, 9); // two triangles
    }));

  it("linework vs structure methods both produce valid output", () =>
    withGeos((geos) => {
      using bowtie = geos.fromWKT(BOWTIE);
      using linework = geos.makeValid(bowtie, { method: "linework" });
      using structure = geos.makeValid(bowtie, { method: "structure" });
      expect(geos.isValid(linework)).toBe(true);
      expect(geos.isValid(structure)).toBe(true);
      expect(geos.area(linework)).toBeCloseTo(geos.area(structure), 9);
    }));

  it("pooled params reset per call: a plain makeValid after a structured one uses linework", () =>
    withGeos((geos) => {
      using bowtie = geos.fromWKT(BOWTIE);
      // first call sets non-default options on the POOLED params object…
      using structured = geos.makeValid(bowtie, { method: "structure", keepCollapsed: true });
      // …the second, options-less call must NOT inherit them (audited
      // stale-pool bug: only provided options used to be re-set).
      using plain = geos.makeValid(bowtie);
      // a fresh context gives the true linework answer (WKT-compare: outputs
      // are deterministic; geometries from different contexts can't be mixed)
      using fresh = new Geos();
      using bowtie2 = fresh.fromWKT(BOWTIE);
      using expected = fresh.makeValid(bowtie2);
      expect(geos.toWKT(plain)).toBe(fresh.toWKT(expected));
      expect(geos.area(plain)).toBeCloseTo(fresh.area(expected), 9);
      void structured;
    }));

  it("keepCollapsed preserves a zero-length line as a point (structure method)", () =>
    withGeos((geos) => {
      using collapsed = geos.fromWKT("LINESTRING (0 0, 0 0)");
      using keep = geos.makeValid(collapsed, { method: "structure", keepCollapsed: true });
      expect(geos.toWKT(keep)).toBe("POINT (0 0)");
      using drop = geos.makeValid(collapsed, { method: "structure", keepCollapsed: false });
      expect(geos.isEmpty(drop)).toBe(true);
    }));
});

describe("isValidDetail / isSimpleDetail diagnostics", () => {
  it("valid geometry: valid=true, no reason, no location", () =>
    withGeos((geos) => {
      using ok = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
      const d = geos.isValidDetail(ok);
      expect(d.valid).toBe(true);
      expect(d.reason).toBeNull();
      expect(d.location).toBeNull();
    }));

  it("bowtie: valid=false + reason + owned location geometry", () =>
    withGeos((geos) => {
      using bowtie = geos.fromWKT(BOWTIE);
      const d = geos.isValidDetail(bowtie);
      expect(d.valid).toBe(false);
      expect(d.reason).toContain("Self-intersection");
      expect(d.location).not.toBeNull();
      if (d.location) {
        expect(geos.geomType(d.location)).toBe("Point");
        d.location.dispose();
      }
    }));

  it("self-intersecting line: not simple, location is a MULTIPOINT with findAll", () =>
    withGeos((geos) => {
      using line = geos.fromWKT("LINESTRING (0 0, 2 2, 2 0, 0 2)");
      const d = geos.isSimpleDetail(line, { findAll: true });
      expect(d.simple).toBe(false);
      expect(d.location).not.toBeNull();
      if (d.location) {
        // GEOS hands back a Point when there is exactly one non-simple node,
        // a MultiPoint for several — accept either, both are owned.
        const t = geos.geomType(d.location);
        expect(t === "Point" || t === "MultiPoint").toBe(true);
        d.location.dispose();
      }
      using simple = geos.fromWKT("LINESTRING (0 0, 1 1)");
      expect(geos.isSimpleDetail(simple).simple).toBe(true);
      expect(geos.isSimpleDetail(simple).location).toBeNull();
    }));
});

describe("coverageIsValid / coverageClean / coverageSimplifyVW", () => {
  it("an aligned grid is a valid coverage with no error edges", () =>
    withGeos((geos) => {
      const ts = [tile(geos, 0, 0), tile(geos, 1, 0), tile(geos, 0, 1), tile(geos, 1, 1)];
      try {
        const v = geos.coverageIsValid(ts);
        expect(v.valid).toBe(true);
        expect(v.errorEdges).toBeUndefined();
      } finally {
        for (const t of ts) t.dispose();
      }
    }));

  it("overlapping input is invalid and reports per-input error edges", () =>
    withGeos((geos) => {
      const a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      const b = geos.fromWKT("POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))");
      try {
        const v = geos.coverageIsValid([a, b]);
        expect(v.valid).toBe(false);
        expect(v.errorEdges).toBeDefined();
        expect(v.errorEdges!.length).toBe(2); // aligned with the input
        for (const e of v.errorEdges!) {
          const t = geos.geomType(e);
          expect(t === "LineString" || t === "MultiLineString").toBe(true);
          e.dispose();
        }
      } finally {
        a.dispose();
        b.dispose();
      }
    }));

  it("gapWidth flags narrow gaps as invalidity (GEOS: gaps narrower than gapWidth are errors)", () =>
    withGeos((geos) => {
      const a = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
      const b = geos.fromWKT("POLYGON ((1.05 0, 2 0, 2 1, 1.05 1, 1.05 0))"); // 0.05 gap
      try {
        // gapWidth 0 (default): no gap tolerance — a 0.05 gap is NOT an error,
        // only overlaps/mismatched edges are.
        expect(geos.coverageIsValid([a, b]).valid).toBe(true);
        // gapWidth 0.1: the 0.05 gap is narrower → flagged invalid.
        const v = geos.coverageIsValid([a, b], { gapWidth: 0.1 });
        expect(v.valid).toBe(false);
        if (v.errorEdges) for (const e of v.errorEdges) e.dispose();
      } finally {
        a.dispose();
        b.dispose();
      }
    }));

  it("coverageClean removes overlaps; output passes coverageIsValid", () =>
    withGeos((geos) => {
      const a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      const b = geos.fromWKT("POLYGON ((1.9 0, 4 0, 4 2, 1.9 2, 1.9 0))"); // small overlap
      try {
        const cleaned = geos.coverageClean([a, b], { snappingDistance: 0.3, gapMaximumWidth: 0.3 });
        expect(cleaned.length).toBe(2);
        const v = geos.coverageIsValid(cleaned, { gapWidth: 0.3 });
        expect(v.valid).toBe(true);
        const areaSum = cleaned.reduce((s, g) => s + geos.area(g), 0);
        expect(areaSum).toBeGreaterThan(7.5); // almost the full 8 minus the overlap band
        for (const g of cleaned) g.dispose();
      } finally {
        a.dispose();
        b.dispose();
      }
    }));

  it("coverageSimplifyVW keeps the member count and coverage topology", () =>
    withGeos((geos) => {
      const ts = [tile(geos, 0, 0), tile(geos, 1, 0), tile(geos, 0, 1), tile(geos, 1, 1)];
      try {
        const simplified = geos.coverageSimplifyVW(ts, 0.2);
        expect(simplified.length).toBe(4);
        // validate BEFORE disposing anything
        const v = geos.coverageIsValid(simplified);
        expect(v.valid).toBe(true);
        if (v.errorEdges) for (const e of v.errorEdges) e.dispose();
        for (const g of simplified) {
          expect(geos.isValid(g)).toBe(true);
          g.dispose();
        }
      } finally {
        for (const t of ts) t.dispose();
      }
    }));

  it("coverageClean resets pooled params per call (stale-pool regression)", () =>
    withGeos((geos) => {
      const a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
      const b = geos.fromWKT("POLYGON ((1.9 0, 4 0, 4 2, 1.9 2, 1.9 0))");
      try {
        // first call: non-default strategy on the POOLED params object
        const withMinArea = geos.coverageClean([a, b], { overlapStrategy: "minArea" });
        // second, options-less call must use the fresh default strategy…
        const plain = geos.coverageClean([a, b]);
        // …verified against a FRESH context that never saw minArea
        using other = new Geos();
        const a2 = other.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
        const b2 = other.fromWKT("POLYGON ((1.9 0, 4 0, 4 2, 1.9 2, 1.9 0))");
        const expected = other.coverageClean([a2, b2]);
        expect(plain.length).toBe(expected.length);
        for (let i = 0; i < plain.length; i++) {
          expect(geos.area(plain[i]!)).toBeCloseTo(other.area(expected[i]!), 9);
        }
        for (const g of withMinArea) g.dispose();
        for (const g of plain) g.dispose();
        for (const g of expected) g.dispose();
        a2.dispose();
        b2.dispose();
      } finally {
        a.dispose();
        b.dispose();
      }
    }));

  it("empty input arrays throw RangeError", () =>
    withGeos((geos) => {
      expect(() => geos.coverageIsValid([])).toThrow(RangeError);
      expect(() => geos.coverageClean([])).toThrow(RangeError);
      expect(() => geos.coverageSimplifyVW([], 1)).toThrow(RangeError);
    }));
});

describe("orientPolygons", () => {
  it("CCW exterior becomes CW-exterior with dir 'cw' and vice versa", () =>
    withGeos((geos) => {
      using cw = geos.fromWKT("POLYGON ((0 0, 0 1, 1 1, 1 0, 0 0))"); // CW exterior
      using ccw = geos.orientPolygons(cw, "ccw");
      expect(geos.toWKT(ccw)).toBe("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
      using cwAgain = geos.orientPolygons(ccw, "cw");
      expect(geos.toWKT(cwAgain)).toBe("POLYGON ((0 0, 0 1, 1 1, 1 0, 0 0))");
    }));

  it("does not mutate the input (clone-then-orient)", () =>
    withGeos((geos) => {
      const wkt = "POLYGON ((0 0, 0 1, 1 1, 1 0, 0 0))";
      using input = geos.fromWKT(wkt);
      using _out = geos.orientPolygons(input, "ccw");
      expect(geos.toWKT(input)).toBe(wkt);
    }));
});
