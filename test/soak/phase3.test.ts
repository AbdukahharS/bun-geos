/**
 * Phase 3 long-run leak soak (ROADMAP Phase 3; testing.md §3, D24): batch
 * ops, parallel-pool ops, and mixed churn must return `stats` (and
 * `statsPrecise`) to baseline with RSS bounded.
 *
 * Default scale runs in seconds (part of `bun test`); `SOAK_SCALE=large`
 * (the CI soak job / `bun run test:soak`) scales the cycles up to the
 * testing.md thresholds (10M create/destroy cycles, longer parallel run).
 */
import { describe, expect, it } from "bun:test";
import { Geos } from "../../src/index.ts";

const LARGE = process.env.SOAK_SCALE === "large";

function rssMB(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}

const UNIT = (i: number): string => {
  const x = i % 32;
  const y = Math.floor(i / 32) % 32;
  return `POLYGON ((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`;
};

describe("phase 3 soak", () => {
  it(
    "batch-op arena churn: outputs + inputs recycle cleanly",
    () => {
      using geos = new Geos();
      using clip = geos.fromWKT("POLYGON ((0 0, 40 0, 40 40, 0 40, 0 0))");
      const ROUNDS = LARGE ? 400 : 40;
      const N = 256;
      const baseline = rssMB();
      const growth: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const inputs = Array.from({ length: N }, (_, i) =>
          geos.fromWKT(UNIT((round * N + i) % 1024)),
        );
        using arena = geos.arena();
        const outs = geos.intersectionAll(clip, inputs, { arena });
        const areas = geos.areaAll(outs);
        let sum = 0;
        for (const a of areas) sum += a;
        if (sum < 0) throw new Error("unreachable"); // keep the loop observable
        const masks = geos.intersectsAll(clip, inputs);
        if (masks.length !== N) throw new Error("unreachable");
        arena.dispose();
        for (const g of inputs) g.dispose();
        if ((round + 1) % (ROUNDS / 8) === 0) growth.push(rssMB() - baseline);
      }
      expect(geos.stats.liveGeoms, "only the clip remains").toBe(1);
      const precise = geos.statsPrecise();
      expect(precise.liveGeoms).toBe(1);
      const firstHalf = growth[Math.floor(growth.length / 2) - 1]!;
      const last = growth[growth.length - 1]!;
      expect(last).toBeLessThan(150);
      expect(last).toBeLessThanOrEqual(firstHalf + 20);
    },
    LARGE ? 300_000 : 60_000,
  );

  it(
    "parallel pool soak: repeated pooled ops leave stats and RSS flat",
    async () => {
      using geos = new Geos();
      using clip = geos.fromWKT("POLYGON ((0 0, 40 0, 40 40, 0 40, 0 0))");
      const ROUNDS = LARGE ? 120 : 12;
      const N = 300;
      const baseline = rssMB();
      const growth: number[] = [];
      for (let round = 0; round < ROUNDS; round++) {
        const inputs = Array.from({ length: N }, (_, i) =>
          geos.fromWKT(UNIT((round * N + i) % 1024)),
        );
        const mask = await geos.parallel.intersectsAll(clip, inputs);
        if (mask.length !== N) throw new Error("unreachable");
        const outs = await geos.parallel.intersectionAll(clip, inputs);
        const areas = await geos.parallel.areaAll(outs);
        if (areas.length !== outs.length) throw new Error("unreachable");
        for (const g of [...outs, ...inputs]) g.dispose();
        if ((round + 1) % (ROUNDS / 4) === 0) growth.push(rssMB() - baseline);
      }
      expect(geos.stats.liveGeoms, "only the clip remains").toBe(1);
      const firstHalf = growth[Math.floor(growth.length / 2) - 1]!;
      const last = growth[growth.length - 1]!;
      expect(last).toBeLessThan(200);
      expect(last).toBeLessThanOrEqual(firstHalf + 30);
      geos.parallel.dispose();
    },
    LARGE ? 600_000 : 120_000,
  );

  it("statsPrecise tracks actual geometry weight, not the floor", () => {
    using geos = new Geos();
    const floorBefore = geos.stats.heapBytesApprox;
    // one dense line: floor says 64 bytes; precise counts its vertices
    const coords = Array.from({ length: 10_000 }, (_, i) => `${i % 100} ${Math.floor(i / 100)}`);
    const dense = geos.fromWKT(`LINESTRING (${coords.join(", ")})`);
    expect(geos.stats.heapBytesApprox).toBe(floorBefore + 64);
    const precise = geos.statsPrecise();
    expect(precise.heapBytesApprox).toBe(64 + 10_000 * 2 * 8);
    dense.dispose();
    expect(geos.statsPrecise().liveGeoms).toBe(0);
  });

  it("arena high-water mark reflects the deepest concurrent arena load", () => {
    using geos = new Geos();
    expect(geos.stats.arenaHighWater).toBe(0);
    {
      using arena = geos.arena();
      for (let i = 0; i < 10; i++) geos.fromWKT(UNIT(i));
      expect(geos.stats.arenaHighWater).toBe(10);
      {
        using inner = geos.arena();
        for (let i = 0; i < 5; i++) geos.fromWKT(UNIT(i));
        expect(geos.stats.arenaHighWater).toBe(15);
        inner.dispose();
      }
      arena.dispose();
    }
    expect(geos.stats.liveGeoms).toBe(0);
    expect(geos.stats.arenaHighWater).toBe(15); // high-water, not current
  });
});
