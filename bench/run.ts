/**
 * The benchmark suite (testing.md §4; Phase 3 exit criteria). Manual trigger
 * (`bun run bench`); results land in bench/results.json and render to
 * docs/benchmarks.md via `bun run bench:report`.
 *
 * The parallel-pool suite runs as a SEPARATE process (bench/parallel.ts):
 * on Bun 1.4.3, worker dispatch from a large fragmented heap can deadlock
 * the parent (engine flake — see parallel.ts header), and isolation is the
 * better benchmarking methodology regardless. Its results merge into the
 * same results.json.
 *
 * Claims measured (positioning rule: never headline trivial ops):
 *   1. prepared scan      — RelateNG prepared + masks vs unprepared
 *   2. spatial index      — tree vs naive JS scan, plus the fused filter
 *   3. unionAll ladder    — strategy dispatch (coverage/disjoint/unary/auto)
 *   4. batch vs singular  — the Phase 3 batch layer on 10⁵-geometry workloads
 *   5. ingest             — fromWKBMany vs per-geometry reads; WKT/GeoJSON/WKB
 *   6. repair at scale    — makeValid + coverageClean
 *   (parallel scaling lives in bench/parallel.ts)
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Geos } from "../src/index.ts";
import { bowties, pointRing, squareGrid, tiles, wobble } from "./lib/gen.ts";

interface Result {
  name: string;
  unit: string;
  values: Record<string, number>;
  note?: string;
}

/** Best-of-N wall time in ms (warm-up first — JIT + FFI trampolines). */
function timeMs(fn: () => void, repeats = 5): number {
  fn();
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
// Observable side-effect across all benches: prevents dead-code elimination.
let checksum = 0;
console.log("bun-geos benchmarks —", geos.version, `(${navigator.hardwareConcurrency} hw threads)`);

/* ---------------------------------------------------- 1. prepared predicate scan
 * 1 wobbly 720-vertex polygon × 100k points: unprepared singular (baseline),
 * prepared singular (RelateNG), prepared batch mask (one FFI crossing). */
{
  const N = 100_000;
  const points = pointRing(N).map((w) => geos.fromWKT(w));
  using poly = geos.fromWKT(wobble(720));
  using prep = poly.prepare();

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

  results.push({
    name: "prepared scan (1 polygon × 100k points)",
    unit: "ms",
    values: { unprepared: unpreparedMs, prepared: preparedMs, "prepared+batch": batchMs },
    note: `prepared ${Math.max(1, Math.round(unpreparedMs / preparedMs))}× vs unprepared`,
  });
  for (const p of points) p.dispose();
}

/* ---------------------------------------------------- 2. spatial index
 * 100k items, 1k query envelopes: tree vs naive JS envelope scan, plus the
 * fused query+prepared filter (one crossing). */
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
  const filt = geos.fromWKT("POLYGON ((0 0, 90 0, 90 90, 0 90, 0 0))");
  const prep = filt.prepare();

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
  const fusedMs = timeMs(() => {
    let hits = 0;
    for (const q of queries) hits += tree.queryFilter(q, prep).length;
    checksum += hits;
  });

  results.push({
    name: `STRtree query (${M} items × ${Q} envelopes)`,
    unit: "ms",
    values: { "naive JS envelope scan": naiveMs, strtree: treeMs, "strtree+fused filter": fusedMs },
    note: `${Math.max(1, Math.round(naiveMs / treeMs))}× vs naive scan`,
  });

  tree.dispose();
  prep.dispose();
  for (const q of queries) q.dispose();
  for (const it of items) it.dispose();
  filt.dispose();
}

/* ---------------------------------------------------- 3. unionAll strategy ladder
 * 961-tile aligned coverage: coverage vs disjointSubset vs unary vs auto. */
{
  const tilesWkt = tiles(31); // 31×31 = 961
  const tilesG = tilesWkt.map((w) => geos.fromWKT(w));
  const run: Record<string, number> = {};
  const arena = geos.arena();
  try {
    for (const strategy of ["coverage", "disjointSubset", "unary", "auto"] as const) {
      run[strategy] = timeMs(() => {
        checksum += geos.area(geos.unionAll(tilesG, { strategy, arena }));
      });
    }
  } finally {
    arena.dispose();
  }
  results.push({
    name: `unionAll ladder (${tilesG.length} aligned tiles)`,
    unit: "ms",
    values: run,
    note: `coverage ${Math.max(1, Math.round(run.unary! / run.coverage!))}× vs unary`,
  });
  for (const t of tilesG) t.dispose();
}

/* ---------------------------------------------------- 4. batch vs singular (10⁵)
 * The Phase 3 shim batch layer vs per-object calls. Honest axes: overlays
 * (GEOS-bound), masks + measures (call-bound), ingest (I/O). */
{
  const N = 100_000;
  const wktSquares = squareGrid(N);
  const inputs = wktSquares.map((w) => geos.fromWKT(w));
  using clip = geos.fromWKT(wobble(720));

  const overlaySingularMs = timeMs(() => {
    using _arena = geos.arena();
    for (const g of inputs) checksum += geos.area(geos.intersection(clip, g));
  }, 3);
  const overlayBatchMs = timeMs(() => {
    using _arena = geos.arena();
    for (const g of geos.intersectionAll(clip, inputs, { arena: _arena })) checksum += geos.area(g);
  }, 3);

  const maskSingularMs = timeMs(() => {
    let hits = 0;
    for (const g of inputs) if (geos.intersects(clip, g)) hits++;
    checksum += hits;
  }, 3);
  const maskBatchMs = timeMs(() => {
    let hits = 0;
    for (const v of geos.intersectsAll(clip, inputs)) hits += v;
    checksum += hits;
  }, 3);

  const measureSingularMs = timeMs(() => {
    for (const g of inputs) checksum += geos.area(g);
  }, 3);
  const measureBatchMs = timeMs(() => {
    for (const v of geos.areaAll(inputs)) checksum += v;
  }, 3);

  const wkbs = inputs.map((g) => geos.toWKB(g));
  const total = wkbs.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  const offs = new Uint32Array(N);
  let off = 0;
  for (let i = 0; i < N; i++) {
    buf.set(wkbs[i]!, off);
    off += wkbs[i]!.length;
    offs[i] = off;
  }
  const readSingularMs = timeMs(() => {
    using _arena = geos.arena();
    for (const p of wkbs) geos.fromWKB(p).dispose();
  }, 3);
  const readBatchMs = timeMs(() => {
    using _arena = geos.arena();
    for (const g of geos.fromWKBMany(buf, offs, { arena: _arena })) g.dispose();
  }, 3);

  results.push({
    name: "batch vs singular (10⁵ squares)",
    unit: "ms",
    values: {
      "overlay singular": overlaySingularMs,
      "overlay batch": overlayBatchMs,
      "mask singular": maskSingularMs,
      "mask batch": maskBatchMs,
      "measure singular": measureSingularMs,
      "measure batch": measureBatchMs,
      "wkbRead singular": readSingularMs,
      "wkbRead batch": readBatchMs,
    },
    note: "engine-native FFI makes per-object calls cheap; batch = one crossing + C loops (D22 note)",
  });
  for (const g of inputs) g.dispose();
}

/* ---------------------------------------------------- 5. ingest
 * PostGIS-dump-shaped reads: WKB per-geometry vs read-many; WKT and GeoJSON
 * (JS-side parse) for scale context. */
{
  const N = 20_000;
  const inputs = squareGrid(N).map((w) => geos.fromWKT(w));
  const wkbs = inputs.map((g) => geos.toWKB(g));
  const total = wkbs.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  const offs = new Uint32Array(N);
  let off = 0;
  for (let i = 0; i < N; i++) {
    buf.set(wkbs[i]!, off);
    off += wkbs[i]!.length;
    offs[i] = off;
  }
  const wktMs = timeMs(() => {
    using _arena = geos.arena();
    for (const w of squareGrid(N)) geos.fromWKT(w).dispose();
  }, 1);
  const geojsonMs = timeMs(() => {
    using _arena = geos.arena();
    for (let i = 0; i < N; i++) {
      const x = (i % 320) * 0.2;
      const y = Math.floor(i / 320) * 0.2;
      geos
        .fromGeoJSON({
          type: "Polygon",
          coordinates: [
            [
              [x, y],
              [x + 0.15, y],
              [x + 0.15, y + 0.15],
              [x, y + 0.15],
              [x, y],
            ],
          ],
        })
        .dispose();
    }
  }, 1);
  const wkbSingMs = timeMs(() => {
    using _arena = geos.arena();
    for (const p of wkbs) geos.fromWKB(p).dispose();
  }, 1);
  const wkbManyMs = timeMs(() => {
    using _arena = geos.arena();
    for (const g of geos.fromWKBMany(buf, offs, { arena: _arena })) g.dispose();
  }, 1);
  results.push({
    name: `ingest (${N} squares)`,
    unit: "ms",
    values: {
      WKT: wktMs,
      GeoJSON: geojsonMs,
      "WKB per-geometry": wkbSingMs,
      "WKB read-many": wkbManyMs,
    },
    note: `${Math.round((wkbSingMs / wkbManyMs) * 10) / 10}× read-many vs per-geometry`,
  });
  for (const g of inputs) g.dispose();
}

/* ---------------------------------------------------- 6. repair at scale
 * makeValid (calling-thread) + coverageClean on a dirty coverage. */
{
  const bow = bowties(1_000).map((w) => geos.fromWKT(w));
  const makeValidMs = timeMs(() => {
    let valid = 0;
    for (const b of bow) {
      using f = geos.makeValid(b);
      if (geos.isValid(f)) valid++;
    }
    checksum += valid;
  });
  results.push({
    name: "makeValid (1,000 bowties)",
    unit: "ms",
    values: { makeValid: makeValidMs },
    note: `${(1000 / makeValidMs).toFixed(0)} geoms/s`,
  });
  for (const b of bow) b.dispose();

  const dirty: ReturnType<Geos["fromWKT"]>[] = [];
  for (let i = 0; i < 20; i++) {
    for (let j = 0; j < 20; j++) {
      const x = i + (i + j) * 0.01;
      const y = j;
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
  results.push({
    name: "coverageClean (dirty 20×20 coverage)",
    unit: "ms",
    values: { coverageClean: cleanMs },
  });
  for (const d of dirty) d.dispose();
}

/* ------------------------------------------ 7. parallel suite (subprocess) */
{
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "parallel.ts")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    console.error(
      `[bench] parallel suite failed:\n${new TextDecoder().decode(proc.stderr).slice(-2000)}`,
    );
  } else {
    const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as { results: Result[] };
    results.push(...parsed.results);
  }
}

/* --------------------------------------------------------------- report */
console.table(results.map((r) => ({ benchmark: r.name, ...r.values, note: r.note })));

let commit = "";
try {
  commit = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // not a checkout — metadata is best-effort
}
const os = await import("node:os");
if (checksum < 0) throw new Error("unreachable"); // keeps every bench loop observable
const meta = {
  when: new Date().toISOString(),
  geos: geos.version,
  bun: Bun.version,
  cpu: os.cpus()[0]?.model ?? "unknown",
  hwThreads: navigator.hardwareConcurrency,
  commit,
  schema: 2,
};

const outDir = join(import.meta.dir, "..", "bench");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "results.json"), `${JSON.stringify({ ...meta, results }, null, 2)}\n`);
console.log("written: bench/results.json");
geos.dispose();
