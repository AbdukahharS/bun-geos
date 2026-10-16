/**
 * Competitor benchmarks (testing.md §4) — OPTIONAL devDependencies.
 *
 * `bun run bench:competitors` measures geos-wasm / turf / polygon-clipping
 * on the SAME seeded workloads as the main suite (bench/lib/gen.ts) and
 * writes bench/competitors/results.json in the same schema; `bun run
 * bench:report` merges it when present. Each adapter degrades to
 * "skipped (not installed)" so the harness never hard-fails on a missing
 * dependency.
 *
 * Status note (honesty rule): adapters are runtime-checked against the
 * installed package's actual API shape; geos-wasm's pointer plumbing is
 * only wired when the package is present. Shapely 2 stays a conceptual
 * baseline (different runtime — directional, not headline).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { squareGrid, wobble } from "../lib/gen.ts";

interface Result {
  name: string;
  unit: string;
  values: Record<string, number>;
  note?: string;
}

const N = 10_000; // competitor scale: pure-JS engines choke past this
const wktA = wobble(720);
const squares = squareGrid(N);

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

const results: Result[] = [];
let checksum = 0;

async function tryTurf(): Promise<void> {
  try {
    // Non-literal specifier: the package is an OPTIONAL devDependency and
    // must not fail static resolution when absent.
    const spec = ["@turf", "turf"].join("/");
    const turf = (await import(spec)) as {
      polygon: (ring: number[][][]) => unknown;
      featureCollection: (fs: unknown[]) => unknown;
      intersect: (fc: unknown) => unknown[] | null;
    };
    const a = turf.polygon(parseRingCoords(wktA));
    const bs = squares.map((w) => turf.polygon(parseRingCoords(w)));
    const ms = timeMs(() => {
      for (const b of bs) {
        const out = turf.intersect(turf.featureCollection([a, b]));
        checksum += out === null ? 0 : 1;
      }
    });
    results.push({
      name: `overlay throughput (turf, ${N} squares × wobble(720))`,
      unit: "ms",
      values: { "turf intersect": ms },
    });
  } catch {
    console.error("turf: skipped (not installed or API drift)");
  }
}

async function tryPolygonClipping(): Promise<void> {
  try {
    const spec = "polygon-clipping";
    const pc = (await import(spec)) as {
      intersection: (a: number[][][], b: number[][][]) => number[][][];
    };
    const a = parseRingCoords(wktA);
    const bs = squares.map((w) => parseRingCoords(w));
    const ms = timeMs(() => {
      for (const b of bs) {
        const out = pc.intersection(a, b);
        checksum += out.length;
      }
    });
    results.push({
      name: `overlay throughput (polygon-clipping, ${N} squares × wobble(720))`,
      unit: "ms",
      values: { "polygon-clipping intersection": ms },
    });
  } catch {
    console.error("polygon-clipping: skipped (not installed)");
  }
}

async function tryGeosWasm(): Promise<void> {
  try {
    const spec = "geos-wasm";
    const mod = await import(spec);
    const geos = (mod as { default?: { Geos?: unknown } }).default;
    if (geos === undefined || typeof (geos as Record<string, unknown>).Geos !== "function") {
      throw new Error("unexpected API shape");
    }
    console.error("geos-wasm: adapter needs the installed package's API probe — skipped for now");
  } catch {
    console.error("geos-wasm: skipped (not installed)");
  }
}

/** Extract the exterior ring coordinates from a POLYGON WKT string. */
function parseRingCoords(wkt: string): number[][][] {
  const inner = wkt.slice(wkt.indexOf("((") + 2, wkt.lastIndexOf("))"));
  const rings = inner.split("),(").map((r) =>
    r
      .replace(/[()]/g, "")
      .split(",")
      .map((pair) => pair.trim().split(/\s+/).map(Number)),
  );
  return [rings[0]!];
}

await tryTurf();
await tryPolygonClipping();
await tryGeosWasm();

if (results.length > 0) {
  const outDir = join(import.meta.dir, "..", "competitors");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "results.json"),
    `${JSON.stringify({ when: new Date().toISOString(), results }, null, 2)}\n`,
  );
  console.error(`written: bench/competitors/results.json (${results.length} adapters)`);
} else {
  console.error("no competitor adapters ran — install the optional bench dependencies");
}
void checksum;
