/**
 * The scenario catalog (testing.md §4): the workloads every engine measures,
 * the size ladders, and the adapter contract. Inputs are built ONCE per
 * scenario+size by the orchestrator from bench/lib/gen.ts and handed to
 * every adapter — identical seeded inputs at every boundary.
 *
 * Engine ceilings are explicit: pure-JS engines stop at their documented
 * cap (they choke past it); the ladder row simply doesn't appear for them
 * and the report shows the sizes each engine actually ran.
 */

import type { Box, Ring } from "./gen.ts";
import type { Boundary, ScenarioId, ScenarioOutput } from "./metrics.ts";

/* ------------------------------------------------------------ size ladders */

/** Canonical size ladder per scenario (total input geometry count, except strtree = item count). */
export const LADDERS: Record<ScenarioId, number[]> = {
  overlay: [1_000, 10_000, 100_000],
  union: [961], // 31×31 aligned tiling
  "prepared-scan": [10_000, 100_000],
  strtree: [100_000], // items; queries fixed at 1,000
  ingest: [20_000],
  makevalid: [1_000],
  buffer: [100],
};

/** Fixed secondary sizes (not part of the ladder but part of the workload). */
export const FIXED = {
  strtreeQueries: 1_000,
  bufferDistance: 2.0,
  bufferQuadSegs: 8,
  wobbleSegments: 720,
} as const;

/** Where pure-JS engines stop (documented ceiling, recorded in the report). */
export const PURE_JS_CAPS: Partial<Record<ScenarioId, number>> = {
  overlay: 10_000,
};

export function ladderFor(scenario: ScenarioId, boundary: Boundary): number[] {
  const ladder = LADDERS[scenario];
  const cap = boundary === "pure-js" ? PURE_JS_CAPS[scenario] : undefined;
  return cap === undefined ? ladder : ladder.filter((n) => n <= cap);
}

/* ---------------------------------------------------------------- inputs */

export interface OverlayInputs {
  size: number;
  clipWkt: string;
  clipRing: Ring;
  squareWkts: string[];
  squareRings: Ring[];
}

export interface UnionInputs {
  size: number;
  tileWkts: string[];
  tileRings: Ring[];
}

export interface PreparedInputs {
  size: number;
  polyWkt: string;
  pointWkts: string[];
  pointCoords: Array<[number, number]>;
}

export interface StrtreeInputs {
  size: number;
  boxes: Box[];
  queries: Box[];
}

export interface IngestInputs {
  size: number;
  squareWkts: string[];
  /** Canonical little-endian WKB, one polygon after another. */
  wkb: Uint8Array;
  /** Cumulative u32 end-offsets per geometry (fromWKBMany semantics). */
  offs: Uint32Array;
}

export interface MakeValidInputs {
  size: number;
  bowtieWkts: string[];
}

export interface BufferInputs {
  size: number;
  wobbleWkts: string[];
  wobbleRings: Ring[];
}

/* --------------------------------------------------------------- adapter */

export interface Adapter {
  engine: string;
  boundary: Boundary;
  /** Returns the engine version when the package is installed and usable, null to skip. */
  probe(): Promise<string | null>;
  /** Per-scenario ladder overrides (e.g. turf's pairwise-fold union cap). */
  ladderOverride?: Partial<Record<ScenarioId, number[]>>;
  /** Optional extra report note (engine-level caveats). */
  reportNote?: string;
  overlay?(inputs: OverlayInputs): ScenarioOutput | null;
  union?(inputs: UnionInputs): ScenarioOutput | null;
  "prepared-scan"?(inputs: PreparedInputs): ScenarioOutput | null;
  strtree?(inputs: StrtreeInputs): ScenarioOutput | null;
  ingest?(inputs: IngestInputs): ScenarioOutput | null;
  makevalid?(inputs: MakeValidInputs): ScenarioOutput | null;
  buffer?(inputs: BufferInputs): ScenarioOutput | null;
}

/** Names the scenario runner method for an adapter (the catalog's single list). */
export const SCENARIOS: ScenarioId[] = [
  "overlay",
  "union",
  "prepared-scan",
  "strtree",
  "ingest",
  "makevalid",
  "buffer",
];

/* ------------------------------------------------- variant keys (shared) */

/**
 * Variant keys are the cross-engine comparison axis — adapters MUST use
 * these names so the report can pivot engines × variants per scenario.
 */
export const VARIANTS = {
  overlay: ["singular", "batch"],
  union: ["unary", "coverage-safe", "coverage-raw", "auto"],
  "prepared-scan": ["unprepared", "prepared", "prepared+batch"],
  strtree: ["build", "query", "query-batch", "query+fused"],
  ingest: ["wkt", "wkt-batch", "geojson", "wkb", "wkb-batch", "wkt-write", "wkb-write"],
  makevalid: ["makevalid"],
  buffer: ["buffer"],
} as const;
