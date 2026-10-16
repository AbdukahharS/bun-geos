/**
 * Phase 2 soak: prepared predicates, STRtree build/query cycles, and
 * unionAll/repair loops must return `geos.stats` to baseline — the leak net
 * for the new C objects (GEOSPreparedGeometry, GEOSSTRtree, shim-bound
 * id→geom tables, pooled params objects).
 */
import { describe, expect, it } from "bun:test";
import { Geos } from "../../src/index.ts";

describe("phase 2 soak", () => {
  it("50k prepared create/test/dispose cycles return to baseline", () => {
    using geos = new Geos();
    const base = geos.fromWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
    using probe = geos.point(5, 5);
    const before = geos.stats.liveGeoms;
    for (let i = 0; i < 50_000; i++) {
      using p = base.prepare();
      p.intersects(probe);
    }
    expect(geos.stats.liveGeoms).toBe(before);
    base.dispose();
  }, 60_000);

  it("500 STRtree build/query/nearest/dispose cycles stay flat", () => {
    using geos = new Geos();
    const before = geos.stats.liveGeoms;
    for (let cycle = 0; cycle < 500; cycle++) {
      using tree = geos.strtree();
      const pts: ReturnType<Geos["point"]>[] = [];
      for (let i = 0; i < 100; i++) {
        const p = geos.point(i, i);
        pts.push(p);
        tree.insert(p);
      }
      using q = geos.point(cycle % 100, cycle % 100);
      tree.query(q);
      tree.nearest(q);
      tree.dispose(); // releases pins + frees the id→geom table
      for (const p of pts) p.dispose();
    }
    expect(geos.stats.liveGeoms).toBe(before);
  }, 60_000);

  it("10k unionAll + makeValid + coverage cycles stay at baseline", () => {
    using geos = new Geos();
    const a = geos.fromWKT("POLYGON ((0 0, 2 0, 2 2, 0 2, 0 0))");
    const b = geos.fromWKT("POLYGON ((1 1, 3 1, 3 3, 1 3, 1 1))");
    const bowtie = geos.fromWKT("POLYGON ((0 0, 2 2, 2 0, 0 2, 0 0))");
    const tiles = [
      geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))"),
      geos.fromWKT("POLYGON ((1 0, 2 0, 2 1, 1 1, 1 0))"),
      geos.fromWKT("POLYGON ((0 1, 1 1, 1 2, 0 2, 0 1))"),
      geos.fromWKT("POLYGON ((1 1, 2 1, 2 2, 1 2, 1 1))"),
    ];
    const before = geos.stats.liveGeoms;
    for (let i = 0; i < 10_000; i++) {
      if (i % 3 === 0) {
        using u = geos.unionAll(tiles);
        geos.area(u);
      } else if (i % 3 === 1) {
        using f = geos.makeValid(bowtie);
        geos.isValid(f);
      } else {
        const v = geos.coverageIsValid(tiles);
        if (v.errorEdges) for (const e of v.errorEdges) e.dispose();
      }
    }
    expect(geos.stats.liveGeoms).toBe(before);
    for (const t of tiles) t.dispose();
    bowtie.dispose();
    b.dispose();
    a.dispose();
  }, 60_000);
});
