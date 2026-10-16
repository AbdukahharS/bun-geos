/**
 * Parallel-pool benchmarks (bench/run.ts spawns this as its own process).
 *
 * Run in isolation deliberately: on Bun 1.4.3, dispatching worker-thread
 * jobs from a parent with a large fragmented heap can deadlock the parent
 * in an engine-internal futex wait (measured repeatedly; workers die
 * pre-handshake, parent spins in a native lock — an engine-level flake, not
 * a shim/binding bug: the same ops pass from a fresh heap). A dedicated
 * small-heap process sidesteps it and isolates pool measurements anyway.
 */

import { Geos } from "../src/index.ts";
import { bowties, squareGrid, wobble } from "./lib/gen.ts";

interface Result {
  name: string;
  unit: string;
  values: Record<string, number>;
  note?: string;
}

async function timeMsAsync(fn: () => Promise<void>, repeats = 3): Promise<number> {
  await fn();
  let best = Infinity;
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

function timeMs(fn: () => void, repeats = 3): number {
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
let checksum = 0;
void checksum;
console.error(`[parallel-bench] ${geos.version} (${navigator.hardwareConcurrency} hw threads)`);

/* ------------------------- repair at scale: calling thread vs worker pool
 * 10⁵ geometries — the exit-criterion workload (≥5× axis, D23). */
{
  const N = 100_000;
  const bow = bowties(N).map((w) => geos.fromWKT(w));
  const localMs = await timeMsAsync(async () => {
    for (const b of bow) {
      using f = geos.makeValid(b);
      checksum += geos.area(f);
    }
  }, 3);
  const poolMs = await timeMsAsync(async () => {
    const outs = await geos.parallel.makeValid(bow, { concurrency: 12, chunkFactor: 3 });
    for (const o of outs) checksum += geos.area(o);
    for (const o of outs) o.dispose();
  }, 3);
  results.push({
    name: `parallel makeValid (${N} bowties)`,
    unit: "ms",
    values: { "calling thread": localMs, "worker pool": poolMs },
    note: `${Math.max(1, Math.round(localMs / poolMs))}× vs per-object calls (concurrency 12, chunkFactor 3 — the ≥5× exit axis, D23; WKB serialization bounds the pool at high ratios)`,
  });

  using clip = geos.fromWKT(wobble(720));
  const masksLocalMs = timeMs(() => {
    let hits = 0;
    for (const b of bow) if (geos.intersects(clip, b)) hits++;
    checksum += hits;
  }, 1);
  const masksPoolMs = await timeMsAsync(async () => {
    const mask = await geos.parallel.intersectsAll(clip, bow);
    for (const v of mask) checksum += v;
  }, 1);
  results.push({
    name: `parallel mask scan (${N} bowties × 1 polygon)`,
    unit: "ms",
    values: { "calling thread": masksLocalMs, "worker pool": masksPoolMs },
    note: `${Math.max(1, Math.round(masksLocalMs / masksPoolMs))}× (WKB transfer bounds light ops)`,
  });
  for (const b of bow) b.dispose();
}

/* ------------------------- parallel scaling ladder on overlay batches */
{
  const N = 100_000;
  const inputs = squareGrid(N).map((w) => geos.fromWKT(w));
  using clip = geos.fromWKT(wobble(720));
  const values: Record<string, number> = {};
  for (const size of [1, 2, 4, 8]) {
    values[`${size} worker${size > 1 ? "s" : ""}`] = await timeMsAsync(async () => {
      const outs = await geos.parallel.intersectionAll(clip, inputs, { concurrency: size });
      checksum += outs.length;
      for (const o of outs) o.dispose();
    }, 1);
  }
  results.push({
    name: `parallel overlay scaling (10⁵ squares × wobble(720))`,
    unit: "ms",
    values,
    note: "serialization-bound: the main thread builds 100k chunk WKBs per op (~1s) — cheap-geometry overlays don't parallelize past it; heavy per-item ops do",
  });
  for (const g of inputs) g.dispose();
}

geos.parallel.dispose();
process.stdout.write(JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
geos.dispose();
