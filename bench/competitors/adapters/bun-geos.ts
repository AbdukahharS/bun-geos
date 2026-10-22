/**
 * bun-geos reference adapter — the comparison column every competitor row is
 * measured against. Runs in the SAME orchestrator process as the JS engines
 * at the SAME sizes with the SAME fingerprint rules, so speedups are
 * same-machine, same-input, same-methodology numbers.
 */

import { Geos } from "../../../src/index.ts";
import type { ScenarioOutput } from "../../lib/metrics.ts";
import { timeMs } from "../../lib/metrics.ts";
import {
  type Adapter,
  type BufferInputs,
  FIXED,
  type IngestInputs,
  type MakeValidInputs,
  type OverlayInputs,
  type PreparedInputs,
  type StrtreeInputs,
  type UnionInputs,
} from "../../lib/scenarios.ts";

/**
 * Fingerprint accumulation via the batch measure API — the symmetric
 * counterpart of Shapely's vectorized `area(out).sum()` inside its timed
 * region (testing.md §3.1: each engine accumulates through its own batch
 * measure op). Returns [non-empty count, Σ area]: for polygon×polygon
 * overlays an output has area > 0 iff it is non-empty, so no separate
 * per-output isEmpty crossing is needed.
 */
function accumulateAreas(
  g: Geos,
  outs: readonly ReturnType<Geos["intersection"]>[],
): [number, number] {
  const areas = g.areaAll(outs);
  let count = 0;
  let areaSum = 0;
  for (let i = 0; i < areas.length; i++) {
    const a = areas[i]!;
    if (a > 0) count++;
    areaSum += a;
  }
  sink(count, areaSum);
  return [count, areaSum];
}

let geos: Geos | null = null;
// Observable side-effect across all benches: prevents dead-code elimination
// of the accumulators inside timed closures (main-suite pattern).
let checksum = 0;

function sink(...values: number[]): void {
  for (const v of values) checksum += v;
  if (checksum < 0) throw new Error("unreachable");
}

function get(): Geos {
  if (geos === null) geos = new Geos();
  return geos;
}

export function bunGeosVersion(): string {
  return `GEOS ${get().version} / bun-geos 0.1.0`;
}

export function disposeBunGeos(): void {
  geos?.dispose();
  geos = null;
}

function overlayRepeats(size: number): number {
  return size >= 100_000 ? 2 : 3;
}

export default {
  engine: "bun-geos",
  boundary: "native-ffi",
  reportNote: "reference column — native FFI to GEOS 3.14",

  probe() {
    return Promise.resolve(bunGeosVersion());
  },

  overlay({ size, clipWkt, squareWkts }: OverlayInputs): ScenarioOutput {
    const g = get();
    const repeats = overlayRepeats(size);
    using clip = g.fromWKT(clipWkt);
    const inputs = squareWkts.map((w) => g.fromWKT(w));

    const singularMs = timeMs(() => {
      using _arena = g.arena();
      const outs: ReturnType<Geos["intersection"]>[] = [];
      for (const s of inputs) outs.push(g.intersection(clip, s));
      accumulateAreas(g, outs);
    }, repeats);

    const batchMs = timeMs(() => {
      using arena = g.arena();
      accumulateAreas(g, g.intersectionAll(clip, inputs, { arena }));
    }, repeats);

    // Reference fingerprint: one more singular pass, numbers captured.
    using _arena = g.arena();
    const outs: ReturnType<Geos["intersection"]>[] = [];
    for (const s of inputs) outs.push(g.intersection(clip, s));
    const [count, areaSum] = accumulateAreas(g, outs);
    for (const s of inputs) s.dispose();
    return {
      variants: { singular: singularMs, batch: batchMs },
      repeats,
      fingerprint: { count, areaSum },
    };
  },

  union({ tileWkts }: UnionInputs): ScenarioOutput {
    const g = get();
    const tilesG = tileWkts.map((w) => g.fromWKT(w));
    const run: Record<string, number> = {};
    let areaSum = 0;
    let count = 0;
    // `coverage-safe` = unionAll's validate-then-union (D20): CoverageUnion is
    // SILENTLY WRONG on a non-coverage, so the safe strategy pays
    // GEOSCoverageIsValid first. Shapely's coverage_union_all and the C++
    // baseline do NOT check — that difference IS the ~9× gap, so both rows
    // are measured: `coverage-raw` is the like-for-like union-only row.
    const safeMs = timeMs(() => {
      using arena = g.arena();
      const out = g.unionAll(tilesG, { strategy: "coverage", arena });
      areaSum = g.area(out);
      count = g.numGeometries(out);
    });
    run["coverage-safe"] = safeMs;

    const rawMs = timeMs(() => {
      using arena = g.arena();
      const out = g.coverageUnion(tilesG, { arena });
      areaSum = g.area(out);
      count = g.numGeometries(out);
    });
    run["coverage-raw"] = rawMs;

    run.unary = timeMs(() => {
      using arena = g.arena();
      const out = g.unionAll(tilesG, { strategy: "unary", arena });
      areaSum = g.area(out);
      count = g.numGeometries(out);
    });
    run.auto = timeMs(() => {
      using arena = g.arena();
      const out = g.unionAll(tilesG, { strategy: "auto", arena });
      areaSum = g.area(out);
      count = g.numGeometries(out);
    });
    for (const t of tilesG) t.dispose();
    return {
      variants: run,
      repeats: 3,
      fingerprint: { count, areaSum },
      note: "coverage-safe = validate+union (GEOSCoverageIsValid first — CoverageUnion is silently wrong on non-coverages); coverage-raw = union only, the parity row vs Shapely/cpp",
    };
  },

  "prepared-scan"({ size, polyWkt, pointWkts }: PreparedInputs): ScenarioOutput {
    const g = get();
    const repeats = size >= 100_000 ? 1 : 3;
    using poly = g.fromWKT(polyWkt);
    const points = pointWkts.map((w) => g.fromWKT(w));
    using prep = poly.prepare();

    const unpreparedMs = timeMs(() => {
      let hits = 0;
      for (const p of points) if (g.intersects(poly, p)) hits++;
      if (hits < 0) throw new Error("unreachable");
    }, repeats);

    const preparedMs = timeMs(() => {
      let hits = 0;
      for (const p of points) if (prep.intersects(p)) hits++;
      if (hits < 0) throw new Error("unreachable");
    }, repeats);

    const batchMs = timeMs(() => {
      let hits = 0;
      for (const v of prep.intersectsAll(points)) hits += v;
      if (hits < 0) throw new Error("unreachable");
    }, repeats);

    let hits = 0;
    for (const p of points) if (prep.intersects(p)) hits++;
    for (const p of points) p.dispose();
    return {
      variants: { unprepared: unpreparedMs, prepared: preparedMs, "prepared+batch": batchMs },
      repeats,
      fingerprint: { areaSum: null, hits },
    };
  },

  strtree({ boxes, queries }: StrtreeInputs): ScenarioOutput {
    const g = get();
    const wkt = (b: { minX: number; minY: number; maxX: number; maxY: number }): string =>
      `POLYGON ((${b.minX} ${b.minY}, ${b.maxX} ${b.minY}, ${b.maxX} ${b.maxY}, ${b.minX} ${b.maxY}, ${b.minX} ${b.minY}))`;
    const items = boxes.map((b) => g.fromWKT(wkt(b)));
    const queryGeoms = queries.map((b) => g.fromWKT(wkt(b)));
    using filt = g.fromWKT("POLYGON ((0 0, 90 0, 90 90, 0 90, 0 0))");
    using prep = filt.prepare();

    let hits = 0;
    const buildMs = timeMs(() => {
      const tree = g.strtree(items);
      tree.build();
      tree.dispose();
    }, 3);

    const tree = g.strtree(items);
    const queryMs = timeMs(() => {
      hits = 0;
      for (const q of queryGeoms) hits += tree.query(q).length;
      if (hits < 0) throw new Error("unreachable");
    }, 5);

    const batchQueryMs = timeMs(() => {
      const { ids } = tree.queryAll(queryGeoms);
      hits = ids.length;
      if (hits < 0) throw new Error("unreachable");
    }, 5);

    const fusedMs = timeMs(() => {
      let fused = 0;
      for (const q of queryGeoms) fused += tree.queryFilter(q, prep).length;
      if (fused < 0) throw new Error("unreachable");
    }, 5);

    tree.dispose();
    for (const q of queryGeoms) q.dispose();
    for (const it of items) it.dispose();
    // `filt`/`prep` release via `using` (prep pins filt — D17).
    return {
      variants: {
        build: buildMs,
        query: queryMs,
        "query-batch": batchQueryMs,
        "query+fused": fusedMs,
      },
      repeats: 5,
      fingerprint: { areaSum: null, hits },
    };
  },

  ingest({ size, squareWkts, wkb, offs }: IngestInputs): ScenarioOutput {
    const g = get();
    const repeats = 2;
    const geojsonObjs = squareRingsToGeoJSON(squareWkts);

    const wktMs = timeMs(() => {
      using _arena = g.arena();
      for (const w of squareWkts) g.fromWKT(w);
    }, repeats);
    const geojsonMs = timeMs(() => {
      using _arena = g.arena();
      for (const o of geojsonObjs) g.fromGeoJSON(o);
    }, repeats);
    const wkbMs = timeMs(() => {
      using _arena = g.arena();
      for (let i = 0; i < size; i++) {
        const start = i === 0 ? 0 : offs[i - 1]!;
        g.fromWKB(wkb.subarray(start, offs[i]!));
      }
    }, repeats);
    const wkbBatchMs = timeMs(() => {
      using arena = g.arena();
      g.fromWKBMany(wkb, offs, { arena });
    }, repeats);

    let count = 0;
    using _arena = g.arena();
    for (const w of squareWkts) {
      g.fromWKT(w);
      count++;
    }
    return {
      variants: { wkt: wktMs, geojson: geojsonMs, wkb: wkbMs, "wkb-batch": wkbBatchMs },
      repeats,
      fingerprint: { count, areaSum: null },
    };
  },

  makevalid({ bowtieWkts }: MakeValidInputs): ScenarioOutput {
    const g = get();
    const inputs = bowtieWkts.map((w) => g.fromWKT(w));
    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      count = 0;
      areaSum = 0;
      using arena = g.arena();
      const outs: ReturnType<Geos["makeValid"]>[] = [];
      for (const b of inputs) {
        const f = g.makeValid(b, { arena });
        if (g.isValid(f)) count++; // no batch validity op — 1k crossings, negligible here
        outs.push(f);
      }
      const areas = g.areaAll(outs, { arena });
      for (let i = 0; i < areas.length; i++) areaSum += areas[i]!;
      sink(count, areaSum);
    }, 3);
    for (const b of inputs) b.dispose();
    return { variants: { makevalid: ms }, repeats: 3, fingerprint: { count, areaSum } };
  },

  buffer({ wobbleWkts }: BufferInputs): ScenarioOutput {
    const g = get();
    const inputs = wobbleWkts.map((w) => g.fromWKT(w));
    let count = 0;
    let areaSum = 0;
    const ms = timeMs(() => {
      using _arena = g.arena();
      const outs: ReturnType<Geos["buffer"]>[] = [];
      for (const w of inputs) {
        outs.push(g.buffer(w, FIXED.bufferDistance, { quadSegs: FIXED.bufferQuadSegs }));
      }
      [count, areaSum] = accumulateAreas(g, outs);
    }, 3);
    for (const w of inputs) w.dispose();
    return { variants: { buffer: ms }, repeats: 3, fingerprint: { count, areaSum } };
  },
} satisfies Adapter;

/** Build GeoJSON polygon objects from the canonical square WKTs (parse outside the timed region). */
function squareRingsToGeoJSON(
  squareWkts: string[],
): Array<{ type: "Polygon"; coordinates: number[][][] }> {
  return squareWkts.map((w) => {
    const body = w.slice(w.indexOf("((") + 2, w.lastIndexOf("))"));
    const ring = body.split(",").map((pair) => pair.trim().split(/\s+/).map(Number));
    return { type: "Polygon" as const, coordinates: [ring] };
  });
}
