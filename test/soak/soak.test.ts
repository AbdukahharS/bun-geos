/**
 * Leak soak (Phase 1 exit criterion #2, testing.md §3): 100k
 * create/op/destroy cycles must return `geos.stats` to baseline with RSS
 * bounded — the spike's assertion thresholds (spike-results "Soak numbers").
 * Also: the error path degrades nothing (1k consecutive parse failures).
 */
import { describe, expect, it } from "bun:test";
import { Geos } from "../../src/index.ts";

function rssMB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

describe("create/op/destroy soak", () => {
  it("100k cycles: stats return to baseline, RSS flatlines", () => {
    using geos = new Geos();
    const a = geos.fromWKT("POLYGON ((0 0, 2 0, 0 2, 0 0))");
    const b = geos.fromWKT("POLYGON ((2 0, 2 2, 0 2, 2 0))");
    const baseline = rssMB();

    const CYCLES = 100_000;
    const epoch = CYCLES / 10;
    const growth: number[] = [];
    {
      using _arena = geos.arena();
      for (let i = 1; i <= CYCLES; i++) {
        using _out = geos.intersection(a, b);
        if (i % epoch === 0) growth.push(rssMB() - baseline);
      }
    }
    expect(geos.stats.liveGeoms, "everything but the inputs is freed").toBe(2);
    expect(geos.stats.finalized, "no finalizer reaping needed on the happy path").toBe(0);

    // Spike thresholds: total growth < 150 MB; second half ≤ first half + 20 MB.
    const totalGrowth = growth[growth.length - 1]!;
    const firstHalf = growth[4]!;
    const secondHalf = growth[9]!;
    expect(totalGrowth).toBeLessThan(150);
    expect(secondHalf).toBeLessThanOrEqual(firstHalf + 20);
    a.dispose();
    b.dispose();
  }, 60_000);

  it("no leak signature without arenas either (dispose-driven)", () => {
    using geos = new Geos();
    const a = geos.fromWKT("POINT (0 0)");
    const before = geos.stats.liveGeoms;
    for (let i = 0; i < 50_000; i++) {
      const g = geos.fromWKT(`POINT (${i % 100} ${i % 100})`);
      g.dispose();
    }
    expect(geos.stats.liveGeoms).toBe(before);
    a.dispose();
  }, 60_000);
});

describe("error-path soak (spike: 1000 consecutive failures, no degradation)", () => {
  it("1000 malformed inputs throw GeosError; valid ops unaffected after", () => {
    using geos = new Geos();
    for (let i = 0; i < 1000; i++) {
      expect(() => geos.fromWKT(`LINESTRING (${`1 2, `.repeat(3)}`)).toThrow();
    }
    const ok = geos.fromWKT("POLYGON ((0 0, 1 0, 1 1, 0 1, 0 0))");
    expect(geos.area(ok)).toBeCloseTo(1, 12);
    expect(geos.stats.liveGeoms).toBe(1);
  });
});
