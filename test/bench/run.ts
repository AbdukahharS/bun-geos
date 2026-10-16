/**
 * Phase 2 benchmark harness (ROADMAP exit criteria; testing.md §4).
 * Manual-trigger (bun run bench) — results print as a table and land in
 * bench/results.json. The full comparative suite (vs geos-wasm, turf,
 * polygon-clipping) is Phase 3; this harness measures OUR Phase 2 claims:
 *
 *   1. prepared scan   — prepared singulars + shim batch masks vs unprepared
 *   2. strtree query   — one-call shim collection vs naive JS envelope scan
 *   3. unionAll ladder — auto/coverage/unary on an aligned coverage
 *   4. repair suite    — makeValid + coverageClean at scale
 *
 * Positioning rule (testing.md §4): no trivial-op marketing — these are the
 * indexed/batched/repair workloads where a native binding wins.
 */

import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Geos } from "../../src/index.ts";

interface Result {
  name: string;
  unit: string;
  values: Record<string, number>;
  note?: string;
}

// Observable side-effect across all benches: prevents dead-code elimination
// AND gives lint a use for every loop's result. Asserted at each section.
let checksum = 0;

function timeMs(fn: () => void, repeats = 5): number {
  fn(); // warm-up (JIT + FFI trampolines)
  let best = Infinity;
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const geos = new Geos();
const results: Result[] = [];
console.log(
  "bun-geos phase 2 benchmarks —",
  geos.version,
  `(${navigator.hardwareConcurrency} hw threads)\n`,
);

/* ---------------------------------------------------- 1. prepared predicate scan
 * 1 complex polygon × 100k points: unprepared singular (baseline),
 * prepared singular (RelateNG), prepared batch mask (one FFI crossing). */
{
  const pts: string[] = [];
  const N = 100_000;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const r = 40 + 8 * Math.sin(a * 31);
    pts.push(`${(Math.cos(a) * r).toFixed(4)} ${(Math.sin(a) * r).toFixed(4)}`);
  }
  using poly = geos.fromWKT(
    `POLYGON ((0 0, ${Array.from({ length: 720 }, (_, k) => {
      const a = (k / 720) * Math.PI * 2;
      return `${(Math.cos(a) * 50 * (1 + 0.05 * Math.sin(a * 9))).toFixed(4)} ${(Math.sin(a) * 50 * (1 + 0.05 * Math.sin(a * 9))).toFixed(4)}`;
    }).join(",")}, 0 0))`,
  );
  const points = pts.map((w) => geos.fromWKT(`POINT (${w})`));
  using prep = poly.prepare();

  // checksums keep the loops observable (no dead-code elimination) and are
  // asserted below — a bench that optimizes away is a lie.
  let localSum = 0;
  const unpreparedMs = timeMs(() => {
    let hits = 0;
    for (const p of points) if (geos.intersects(poly, p)) hits++;
    localSum += hits;
  });
  const preparedMs = timeMs(() => {
    let hits = 0;
    for (const p of points) if (prep.intersects(p)) hits++;
    localSum += hits;
  });
  const batchMs = timeMs(() => {
    let hits = 0;
    for (const v of prep.intersectsAll(points)) hits += v;
    localSum += hits;
  });
  checksum += localSum;
  expect(localSum).toBeGreaterThan(0);

  results.push({
    name: "prepared scan (1 polygon × 100k points)",
    unit: "ms",
    values: { unprepared: unpreparedMs, prepared: preparedMs, "prepared+batch": batchMs },
    note: `prepared ${Math.max(1, Math.round(unpreparedMs / preparedMs))}× vs unprepared; batch ${Math.max(1, Math.round(preparedMs / batchMs))}× over singulars`,
  });
  for (const p of points) p.dispose();
}

/* ---------------------------------------------------- 2. STRtree query
 * 100k items, 1k query envelopes: tree vs naive JS envelope scan. */
{
  const M = 100_000;
  const Q = 1_000;
  const boxes: Array<[number, number, number, number]> = [];
  const items = Array.from({ length: M }, (_, i) => {
    const x = (i % 316) * 0.316;
    const y = Math.floor(i / 316) * 0.316;
    boxes.push([x, y, x + 0.2, y + 0.2]);
    return geos.fromWKT(
      `POLYGON ((${x} ${y}, ${x + 0.2} ${y}, ${x + 0.2} ${y + 0.2}, ${x} ${y + 0.2}, ${x} ${y}))`,
    );
  });
  const queryBoxes: Array<[number, number, number, number]> = [];
  const queries = Array.from({ length: Q }, (_, i) => {
    const qx = i % 90;
    const qy = i % 87;
    queryBoxes.push([qx, qy, qx + 5, qy + 5]);
    return geos.fromWKT(
      `POLYGON ((${qx} ${qy}, ${qx + 5} ${qy}, ${qx + 5} ${qy + 5}, ${qx} ${qy + 5}, ${qx} ${qy}))`,
    );
  });
  const tree = geos.strtree(items);

  // honest naive: per query, scan ALL item envelopes in JS (the O(n·m) the
  // tree replaces)
  const naiveMs = timeMs(() => {
    let hits = 0;
    for (const [qx1, qy1, qx2, qy2] of queryBoxes) {
      for (const [x1, y1, x2, y2] of boxes) {
        if (x1 <= qx2 && x2 >= qx1 && y1 <= qy2 && y2 >= qy1) hits++;
      }
    }
    checksum += hits;
  });
  const treeMs = timeMs(() => {
    let hits = 0;
    for (const q of queries) hits += tree.query(q).length;
    checksum += hits;
  });

  results.push({
    name: `STRtree query (${M} items × ${Q} envelopes)`,
    unit: "ms",
    values: { "naive JS envelope scan": naiveMs, "strtree (shim-collected)": treeMs },
    note: `${Math.max(1, Math.round(naiveMs / treeMs))}× vs naive scan`,
  });

  tree.dispose();
  for (const q of queries) q.dispose();
  for (const it of items) it.dispose();
}

/* ---------------------------------------------------- 3. unionAll strategy ladder
 * 1,000-tile aligned coverage: coverage vs disjointSubset vs unary vs auto. */
{
  const n = 31; // 31×31 = 961 tiles
  const tiles: ReturnType<Geos["fromWKT"]>[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = i;
      const y = j;
      tiles.push(
        geos.fromWKT(
          `POLYGON ((${x} ${y}, ${x + 1} ${y}, ${x + 1} ${y + 1}, ${x} ${y + 1}, ${x} ${y}))`,
        ),
      );
    }
  }
  const run = { coverage: 0.0, disjointSubset: 0.0, unary: 0.0, auto: 0.0 };
  const arena = geos.arena(); // collects every bench result; torn down below
  try {
    run.coverage = timeMs(() => {
      checksum += geos.area(geos.unionAll(tiles, { strategy: "coverage", arena }));
    });
    run.disjointSubset = timeMs(() => {
      checksum += geos.area(geos.unionAll(tiles, { strategy: "disjointSubset", arena }));
    });
    run.unary = timeMs(() => {
      checksum += geos.area(geos.unionAll(tiles, { strategy: "unary", arena }));
    });
    run.auto = timeMs(() => {
      checksum += geos.area(geos.unionAll(tiles, { arena }));
    });
  } finally {
    arena.dispose();
  }
  expect(checksum).toBeGreaterThan(0);
  results.push({
    name: `unionAll ladder (${tiles.length} aligned tiles)`,
    unit: "ms",
    values: run,
    note: `coverage ${Math.max(1, Math.round(run.unary / run.coverage))}× vs unary`,
  });
  for (const t of tiles) t.dispose();
}

/* ---------------------------------------------------- 4. repair suite at scale
 * makeValid on 1,000 bowties; coverageClean on a dirty 400-tile coverage. */
{
  const bowties = Array.from({ length: 1_000 }, (_, i) =>
    geos.fromWKT(`POLYGON ((${i} 0, ${i + 2} 2, ${i + 2} 0, ${i} 2, ${i} 0))`),
  );
  const makeValidMs = timeMs(() => {
    let valid = 0;
    for (const b of bowties) {
      using f = geos.makeValid(b);
      if (geos.isValid(f)) valid++;
    }
    checksum += valid;
  });
  expect(checksum).toBeGreaterThan(0);
  results.push({
    name: "makeValid (1,000 bowties)",
    unit: "ms",
    values: { makeValid: makeValidMs },
    note: `${(1000 / makeValidMs).toFixed(0)} geoms/s`,
  });
  for (const b of bowties) b.dispose();

  const dirty: ReturnType<Geos["fromWKT"]>[] = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      const x = i * 1 + (i + j) * 0.01; // small systematic overlaps/gaps
      const y = j * 1;
      dirty.push(
        geos.fromWKT(
          `POLYGON ((${x} ${y}, ${x + 1.02} ${y}, ${x + 1.02} ${y + 1.02}, ${x} ${y + 1.02}, ${x} ${y}))`,
        ),
      );
    }
  }
  const cleanMs = timeMs(() => {
    let areaSum = 0;
    const cleaned = geos.coverageClean(dirty, { snappingDistance: 0.05, gapMaximumWidth: 0.05 });
    for (const g of cleaned) {
      areaSum += geos.area(g);
      g.dispose();
    }
    checksum += areaSum;
  });
  expect(checksum).toBeGreaterThan(0);
  results.push({
    name: "coverageClean (dirty 20×20 coverage)",
    unit: "ms",
    values: { coverageClean: cleanMs },
  });
  for (const d of dirty) d.dispose();
}

/* --------------------------------------------------------------- report */
console.table(results.map((r) => ({ benchmark: r.name, ...r.values, note: r.note })));
const outDir = join(import.meta.dir, "..", "..", "bench");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, "results.json"),
  `${JSON.stringify({ when: new Date().toISOString(), geos: geos.version, results }, null, 2)}\n`,
);
console.log(`written: bench/results.json`);
geos.dispose();
