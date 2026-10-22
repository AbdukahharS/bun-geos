/**
 * Shared metrics contract for the competitor benchmark suite (testing.md §4,
 * D25 extension): one record shape emitted by EVERY engine — bun-geos,
 * geos-wasm, JSTS, turf, polygon-clipping, rbush, flatbush, wkx, Shapely 2
 * (subprocess), and the GEOS C++ direct baseline (subprocess).
 *
 * Methodology (identical everywhere):
 *   - warm-up run excluded (JIT + caches + lazy handles), then best-of-N
 *     wall time; N recorded per record (`repeats`) — slow engines may use
 *     fewer repeats, always recorded, never hidden;
 *   - fingerprint accumulation (count/area/hits) runs INSIDE the timed
 *     region for every engine, so no engine gets away with doing less work
 *     per iteration;
 *   - answer fingerprints are compared against the bun-geos reference at
 *     the same scenario+size: exact counts/hits, 1e-9 relative on areas.
 *     A mismatch is REPORTED (✗ in docs/benchmarks.md), never silently
 *     ignored — a faster number that computes a different answer is not a
 *     benchmark result.
 */

import type { Box, Ring } from "./gen.ts";

/** How the engine reaches its geometry code — the boundary being measured. */
export type Boundary = "native-ffi" | "wasm" | "pure-js" | "c-direct" | "ctypes";

export type ScenarioId =
  | "overlay"
  | "union"
  | "prepared-scan"
  | "strtree"
  | "ingest"
  | "makevalid"
  | "buffer";

/** What the engine computed — the honesty anchor for cross-engine rows. */
export interface Fingerprint {
  /** Non-empty result geometries (overlay/makevalid/buffer/ingest) or polygon parts of the aggregate (union). */
  count?: number;
  /** Σ area over result geometries (null when the engine has no cheap area op). */
  areaSum: number | null;
  /** Predicate hit count (prepared-scan) or query candidate total (strtree). */
  hits?: number;
}

/** One scenario run by one engine at one size. Variant keys are comparable across engines. */
export interface ScenarioRecord {
  engine: string;
  engineVersion: string;
  boundary: Boundary;
  scenario: ScenarioId;
  size: number;
  /** Best-of-N wall time in ms per variant. */
  variants: Record<string, number>;
  repeats: number;
  fingerprint: Fingerprint;
  note?: string;
}

export interface EngineFailure {
  engine: string;
  scenario: string;
  error: string;
}

/** Scenario the engine supports in principle but the installed API can't run. */
export interface EngineSkip {
  engine: string;
  scenario: string;
  reason: string;
}

export interface EngineStatus {
  engine: string;
  version: string | null;
  boundary: Boundary;
  status: "ran" | "skipped";
  note?: string;
}

/** bench/competitors/results.json — schema 3 (engine-tagged records). */
export interface CompetitorFile {
  when: string;
  schema: 3;
  bun: string;
  cpu: string;
  hwThreads: number;
  commit: string;
  engines: EngineStatus[];
  results: ScenarioRecord[];
  failures: EngineFailure[];
  /** Scenario-level null-returns: supported in principle, unusable API shape. */
  skips: EngineSkip[];
}

/** Per-scenario timing output from an adapter (engine metadata added by the orchestrator). */
export interface ScenarioOutput {
  variants: Record<string, number>;
  repeats: number;
  fingerprint: Fingerprint;
  note?: string;
}

/** Best-of-N wall time in ms, warm-up excluded — the one timing rule for every adapter. */
export function timeMs(fn: () => void, repeats = 3): number {
  fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < repeats; i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Throughput from a wall-time measurement (ms → ops/s). */
export function perSecond(ms: number, ops: number): number {
  return ms > 0 ? Math.round((ops / ms) * 1000) : 0;
}

/** Shoelace area of a closed ring — the fingerprint helper for coord-array engines. */
export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 1; i < ring.length; i++) {
    const [x0, y0] = ring[i - 1]!;
    const [x1, y1] = ring[i]!;
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/** Polygon-part count + area for pure-JS multipolygon coordinate results ([[ring,…],[…]]). */
export function mpStats(mp: number[][][][]): { count: number; areaSum: number } {
  let count = 0;
  let areaSum = 0;
  for (const poly of mp) {
    if (poly.length === 0) continue;
    count++;
    areaSum += ringArea(poly[0]! as unknown as Ring);
    for (let h = 1; h < poly.length; h++) areaSum -= ringArea(poly[h]! as unknown as Ring);
  }
  return { count, areaSum };
}

/** Envelope intersection test (the strtree workload's exact-answer check). */
export function boxIntersects(a: Box, b: Box): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/**
 * Planar area of a GeoJSON (Multi)Polygon geometry — the fingerprint helper
 * for engines whose own area op is geodesic (turf's `area` measures m² on
 * the sphere; the workload is planar, so cross-engine fingerprints use the
 * same planar math everywhere).
 */
export function geojsonPlanarArea(geom: { type: string; coordinates: unknown }): number {
  const ringA = (ring: number[][]): number => {
    let sum = 0;
    for (let i = 1; i < ring.length; i++) {
      sum += ring[i - 1]![0]! * ring[i]![1]! - ring[i]![0]! * ring[i - 1]![1]!;
    }
    return Math.abs(sum) / 2;
  };
  const polyA = (poly: number[][][]): number => {
    let area = ringA(poly[0]!);
    for (let h = 1; h < poly.length; h++) area -= ringA(poly[h]!);
    return area;
  };
  if (geom.type === "Polygon") return polyA(geom.coordinates as number[][][]);
  if (geom.type === "MultiPolygon") {
    let sum = 0;
    for (const poly of geom.coordinates as number[][][][]) sum += polyA(poly);
    return sum;
  }
  return 0;
}

export interface FingerprintVerdict {
  ok: boolean;
  detail: string;
}

/**
 * Compare two engine fingerprints on the same scenario+size: exact counts
 * and hits; 1e-9 relative on areaSum (GEOS-family engines run the same
 * algorithms and must agree to the last bits, near enough).
 */
export function compareFingerprints(ref: Fingerprint, other: Fingerprint): FingerprintVerdict {
  const parts: string[] = [];
  let ok = true;
  if (ref.count !== undefined && other.count !== undefined) {
    const same = ref.count === other.count;
    ok = ok && same;
    parts.push(`count ${other.count}${same ? "" : ` ≠ ${ref.count}`}`);
  }
  if (ref.hits !== undefined && other.hits !== undefined) {
    const same = ref.hits === other.hits;
    ok = ok && same;
    parts.push(`hits ${other.hits}${same ? "" : ` ≠ ${ref.hits}`}`);
  }
  if (ref.areaSum !== null && other.areaSum !== null && ref.areaSum !== 0) {
    const rel = Math.abs(other.areaSum - ref.areaSum) / Math.abs(ref.areaSum);
    const same = rel <= 1e-9;
    ok = ok && same;
    parts.push(`area ${same ? "≈" : "≠"} (${rel.toExponential(1)})`);
  }
  return { ok, detail: parts.join(" · ") };
}
