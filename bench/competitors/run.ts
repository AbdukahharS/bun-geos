/**
 * Competitor benchmark orchestrator (testing.md §4, D25 extension) —
 * OPTIONAL devDependencies behind `bun run bench:competitors:setup`.
 *
 * Every engine measures the SAME seeded workloads (bench/lib/gen.ts — one
 * source of truth; subprocess engines read the canonical .workload files
 * materialized here) with the SAME methodology (best-of-N wall ms, warm-up
 * excluded, fingerprint accumulation inside the timed region) and the SAME
 * record schema (schema 3: engine-tagged). bun-geos runs in-process as the
 * reference column. Shapely 2 and the GEOS C++ direct baseline run as
 * subprocesses emitting identical JSON.
 *
 * Honesty rules: engines degrade to "skipped (reason)" — never hard-fail;
 * fingerprint mismatches vs bun-geos are recorded (the report renders ✗);
 * engine ceilings (pure-JS caps, turf's fold-union cap) are explicit
 * ladders, never silent.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Geos } from "../../src/index.ts";
import {
  type Box,
  bowtieRings,
  bowties,
  pointRing,
  pointRingCoords,
  type Ring,
  ringToPolygonWkt,
  squareGrid,
  squareGridRings,
  strtreeBoxes,
  tiles,
  tilesRings,
  wobble,
  wobbleRing,
  wobbleRingsTranslated,
} from "../lib/gen.ts";
import type {
  Boundary,
  CompetitorFile,
  EngineFailure,
  EngineSkip,
  EngineStatus,
  Fingerprint,
  ScenarioId,
  ScenarioRecord,
} from "../lib/metrics.ts";
import { compareFingerprints } from "../lib/metrics.ts";
import type {
  BufferInputs,
  IngestInputs,
  MakeValidInputs,
  OverlayInputs,
  PreparedInputs,
  StrtreeInputs,
  UnionInputs,
} from "../lib/scenarios.ts";
import { FIXED, LADDERS, ladderFor, SCENARIOS } from "../lib/scenarios.ts";
import bunGeosAdapter, { disposeBunGeos } from "./adapters/bun-geos.ts";
import flatbushAdapter from "./adapters/flatbush.ts";
import geosWasmAdapter from "./adapters/geos-wasm.ts";
import jstsAdapter from "./adapters/jsts.ts";
import polygonClippingAdapter from "./adapters/polygon-clipping.ts";
import rbushAdapter from "./adapters/rbush.ts";
import turfAdapter from "./adapters/turf.ts";
import wkxAdapter from "./adapters/wkx.ts";
import { baselineScenarioSizes, ensureBaseline } from "./cpp/build.ts";

const WORKLOAD_DIR = join(import.meta.dir, ".workload");
const OUT_PATH = join(import.meta.dir, "results.json");

/* ------------------------------------------------------------ workloads */

const cache = new Map<string, unknown>();

function cached<T>(key: string, build: () => T): T {
  const hit = cache.get(key);
  if (hit !== undefined) return hit as T;
  const value = build();
  cache.set(key, value);
  return value;
}

function overlayInputs(size: number): OverlayInputs {
  return cached(`overlay:${size}`, () => ({
    size,
    clipWkt: wobble(FIXED.wobbleSegments),
    clipRing: closedRing(wobbleRing(FIXED.wobbleSegments)),
    squareWkts: squareGrid(size),
    squareRings: squareGridRings(size),
  }));
}

function unionInputs(size: number): UnionInputs {
  return cached(`union:${size}`, () => {
    const n = Math.round(Math.sqrt(size));
    return { size: n * n, tileWkts: tiles(n), tileRings: tilesRings(n) };
  });
}

function preparedInputs(size: number): PreparedInputs {
  return cached(`prepared:${size}`, () => ({
    size,
    polyWkt: wobble(FIXED.wobbleSegments),
    pointWkts: pointRing(size),
    pointCoords: pointRingCoords(size),
  }));
}

function strtreeInputs(size: number): StrtreeInputs {
  return cached(`strtree:${size}`, () => {
    const { boxes, queries } = strtreeBoxes(size, FIXED.strtreeQueries);
    return { size, boxes, queries };
  });
}

function ingestInputs(size: number): IngestInputs {
  return cached(`ingest:${size}`, () => {
    const squareWkts = squareGrid(size);
    const { wkb, offs } = canonicalWkb(squareWkts);
    return { size, squareWkts, wkb, offs };
  });
}

function makevalidInputs(size: number): MakeValidInputs {
  return cached(`makevalid:${size}`, () => ({ size, bowtieWkts: bowties(size) }));
}

function bufferInputs(size: number): BufferInputs {
  return cached(`buffer:${size}`, () => {
    const wobbleRings = wobbleRingsTranslated(size, FIXED.wobbleSegments);
    return {
      size,
      wobbleWkts: wobbleRings.map((r) => ringToPolygonWkt(closedRing(r))),
      wobbleRings: wobbleRings.map((r) => closedRing(r)),
    };
  });
}

function closedRing(open: Ring): Ring {
  const ring = open.slice();
  ring.push([open[0]![0]!, open[0]![1]!]);
  return ring;
}

/* ------------------------------------ canonical .workload files (subprocesses) */

/** Little-endian canonical WKB + cumulative u32 end-offsets, via bun-geos itself. */
function canonicalWkb(wkts: string[]): { wkb: Uint8Array; offs: Uint32Array } {
  using geos = new Geos();
  const geoms = wkts.map((w) => geos.fromWKT(w));
  const parts = geoms.map((g) => geos.toWKB(g, { byteOrder: "little" }));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const wkb = new Uint8Array(total);
  const offs = new Uint32Array(parts.length);
  let off = 0;
  for (let i = 0; i < parts.length; i++) {
    wkb.set(parts[i]!, off);
    off += parts[i]!.length;
    offs[i] = off;
  }
  return { wkb, offs };
}

function writeBytes(path: string, bytes: Uint8Array): void {
  writeFileSync(path, bytes);
}

function writeWktLines(path: string, wkts: string[]): void {
  writeFileSync(path, `${wkts.join("\n")}\n`);
}

function writeBoxesTsv(path: string, boxes: Box[]): void {
  writeFileSync(
    path,
    boxes
      .map((b) => `${b.minX} ${b.minY} ${b.maxX} ${b.maxY}`)
      .join("\n")
      .concat("\n"),
  );
}

function materializeWorkloadFiles(): void {
  console.error(`[competitors] materializing canonical workloads → ${WORKLOAD_DIR}`);
  mkdirSync(WORKLOAD_DIR, { recursive: true });

  const clip = wobble(FIXED.wobbleSegments);
  writeWktLines(join(WORKLOAD_DIR, "clip720.wkt"), [clip]);
  writeBytes(join(WORKLOAD_DIR, "clip720.wkb"), canonicalWkb([clip]).wkb);

  for (const size of [...LADDERS.overlay, LADDERS.ingest[0]!]) {
    const wkts = squareGrid(size);
    writeWktLines(join(WORKLOAD_DIR, `squares-${size}.wkt`), wkts);
    const { wkb, offs } = canonicalWkb(wkts);
    writeBytes(join(WORKLOAD_DIR, `squares-${size}.wkb`), wkb);
    writeBytes(join(WORKLOAD_DIR, `squares-${size}.offs.u32`), u32Le(offs));
  }

  for (const size of LADDERS["prepared-scan"]) {
    const wkts = pointRing(size);
    writeWktLines(join(WORKLOAD_DIR, `points-${size}.wkt`), wkts);
    const { wkb, offs } = canonicalWkb(wkts);
    writeBytes(join(WORKLOAD_DIR, `points-${size}.wkb`), wkb);
    writeBytes(join(WORKLOAD_DIR, `points-${size}.offs.u32`), u32Le(offs));
  }

  writeWktLines(join(WORKLOAD_DIR, `tiles-${LADDERS.union[0]}.wkt`), tiles(31));
  writeWktLines(
    join(WORKLOAD_DIR, `bowties-${LADDERS.makevalid[0]}.wkt`),
    bowties(LADDERS.makevalid[0]!),
  );

  const wob = wobbleRingsTranslated(LADDERS.buffer[0]!, FIXED.wobbleSegments).map((r) =>
    ringToPolygonWkt(closedRing(r)),
  );
  {
    const { wkb, offs } = canonicalWkb(wob);
    writeBytes(join(WORKLOAD_DIR, `wobbles-${LADDERS.buffer[0]}.wkb`), wkb);
    writeBytes(join(WORKLOAD_DIR, `wobbles-${LADDERS.buffer[0]}.offs.u32`), u32Le(offs));
  }

  const { boxes, queries } = strtreeBoxes(LADDERS.strtree[0]!, FIXED.strtreeQueries);
  writeBoxesTsv(join(WORKLOAD_DIR, "strtree-boxes.tsv"), boxes);
  writeBoxesTsv(join(WORKLOAD_DIR, "strtree-queries.tsv"), queries);
}

/** Uint32Array → little-endian bytes. */
function u32Le(values: Uint32Array): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i]!, true);
  return out;
}

/* -------------------------------------------------------------- adapters */

interface SubprocessRecord {
  engine: string;
  engineVersion: string;
  boundary: Boundary;
  scenario: ScenarioId;
  size: number;
  variants: Record<string, number>;
  repeats: number;
  fingerprint: Fingerprint;
  note?: string;
}

const results: ScenarioRecord[] = [];
const failures: EngineFailure[] = [];
const skips: EngineSkip[] = [];
const engines: EngineStatus[] = [];

async function runAdapter(adapter: import("../lib/scenarios.ts").Adapter): Promise<void> {
  let version: string | null = null;
  try {
    version = await adapter.probe();
  } catch (e) {
    engines.push({
      engine: adapter.engine,
      version: null,
      boundary: adapter.boundary,
      status: "skipped",
      note: `not installed or unusable: ${(e as Error).message.split("\n")[0]}`,
    });
    console.error(
      `[competitors] ${adapter.engine}: skipped (${(e as Error).message.split("\n")[0]})`,
    );
    return;
  }
  if (version === null) {
    engines.push({
      engine: adapter.engine,
      version: null,
      boundary: adapter.boundary,
      status: "skipped",
      note: "probe returned null",
    });
    return;
  }
  console.error(`[competitors] ${adapter.engine} ${version} — running`);
  let ran = 0;
  for (const scenario of SCENARIOS) {
    const runner = (adapter as unknown as Record<string, unknown>)[scenario];
    if (typeof runner !== "function") continue;
    const ladder = adapter.ladderOverride?.[scenario] ?? ladderFor(scenario, adapter.boundary);
    for (const size of ladder) {
      const inputs = buildInputs(scenario, size);
      try {
        const output = await (
          runner as (i: unknown) => import("../lib/metrics.ts").ScenarioOutput | null
        )(inputs);
        if (output === null) {
          if (!skips.some((s) => s.engine === adapter.engine && s.scenario === scenario)) {
            skips.push({
              engine: adapter.engine,
              scenario,
              reason: "op not workable against the installed package's API",
            });
            console.error(
              `[competitors] ${adapter.engine} ${scenario}: skipped (unsupported API shape)`,
            );
          }
          continue;
        }
        const note = output.note ?? adapter.reportNote;
        results.push({
          engine: adapter.engine,
          engineVersion: version,
          boundary: adapter.boundary,
          scenario,
          size,
          variants: output.variants,
          repeats: output.repeats,
          fingerprint: output.fingerprint,
          ...(note !== undefined ? { note } : {}),
        });
        ran++;
      } catch (e) {
        failures.push({
          engine: adapter.engine,
          scenario: `${scenario}@${size}`,
          error: (e as Error).message.split("\n")[0] ?? "unknown error",
        });
      }
    }
  }
  engines.push({ engine: adapter.engine, version, boundary: adapter.boundary, status: "ran" });
  console.error(`[competitors] ${adapter.engine}: ${ran} record(s)`);
}

function buildInputs(scenario: ScenarioId, size: number): unknown {
  switch (scenario) {
    case "overlay":
      return overlayInputs(size);
    case "union":
      return unionInputs(size);
    case "prepared-scan":
      return preparedInputs(size);
    case "strtree":
      return strtreeInputs(size);
    case "ingest":
      return ingestInputs(size);
    case "makevalid":
      return makevalidInputs(size);
    case "buffer":
      return bufferInputs(size);
  }
}

/* ------------------------------------------------------------ subprocesses */

async function runShapely(): Promise<void> {
  const venvPython = join(import.meta.dir, ".venv", "bin", "python");
  const python = existsSync(venvPython) ? venvPython : "python3";
  let proc: ReturnType<typeof Bun.spawnSync>;
  try {
    proc = Bun.spawnSync([python, join(import.meta.dir, "shapely_bench.py"), WORKLOAD_DIR], {
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    engines.push({
      engine: "shapely",
      version: null,
      boundary: "ctypes",
      status: "skipped",
      note: `python spawn failed: ${(e as Error).message}`,
    });
    return;
  }
  if (proc.exitCode !== 0) {
    const err = new TextDecoder().decode(proc.stderr).trim().split("\n").slice(-3).join("; ");
    engines.push({
      engine: "shapely",
      version: null,
      boundary: "ctypes",
      status: "skipped",
      note: err || `exit ${proc.exitCode}`,
    });
    console.error(`[competitors] shapely: skipped (${err})`);
    return;
  }
  const parsed = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
    engineVersion?: string;
    records: SubprocessRecord[];
    failures: EngineFailure[];
  };
  engines.push({
    engine: "shapely",
    version: parsed.engineVersion ?? "shapely",
    boundary: "ctypes",
    status: "ran",
  });
  results.push(...parsed.records);
  failures.push(...parsed.failures);
  console.error(`[competitors] shapely: ${parsed.records.length} record(s)`);
}

async function runCppBaseline(): Promise<void> {
  let bin: string | null = null;
  try {
    bin = ensureBaseline();
  } catch (e) {
    const note = (e as Error).message.split("\n")[0];
    engines.push({
      engine: "geos-cpp",
      version: null,
      boundary: "c-direct",
      status: "skipped",
      ...(note !== undefined ? { note } : {}),
    });
    console.error(`[competitors] geos-cpp: skipped (${(e as Error).message.split("\n")[0]})`);
    return;
  }
  let geosVersion = "geos-cpp";
  let ran = 0;
  for (const scenario of SCENARIOS) {
    for (const size of baselineScenarioSizes(scenario)) {
      const proc = Bun.spawnSync([bin, scenario, String(size), WORKLOAD_DIR], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) {
        const err = new TextDecoder().decode(proc.stderr).trim();
        failures.push({
          engine: "geos-cpp",
          scenario: `${scenario}@${size}`,
          error: err.slice(0, 200),
        });
        continue;
      }
      if (geosVersion === "geos-cpp") {
        const v =
          proc.stderr.length > 0
            ? (new TextDecoder().decode(proc.stderr).trim().split("\n")[0] ?? "")
            : "";
        if (v.startsWith("geos ")) geosVersion = v;
      }
      const out = JSON.parse(new TextDecoder().decode(proc.stdout)) as {
        variants: Record<string, number>;
        repeats: number;
        fingerprint: Fingerprint;
        note?: string;
      };
      results.push({
        engine: "geos-cpp",
        engineVersion: geosVersion,
        boundary: "c-direct",
        scenario,
        size,
        variants: out.variants,
        repeats: out.repeats,
        fingerprint: out.fingerprint,
        note: out.note ?? "GEOS C API called directly — zero boundary",
      });
      ran++;
    }
  }
  engines.push({ engine: "geos-cpp", version: geosVersion, boundary: "c-direct", status: "ran" });
  console.error(`[competitors] geos-cpp: ${ran} record(s)`);
}

/* ----------------------------------------------------------------- report */

function summary(): void {
  const refBy = new Map<string, ScenarioRecord>();
  for (const r of results) {
    if (r.engine === "bun-geos") refBy.set(`${r.scenario}@${r.size}`, r);
  }
  const byScenario = new Map<ScenarioId, ScenarioRecord[]>();
  for (const r of results) {
    const list = byScenario.get(r.scenario) ?? [];
    list.push(r);
    byScenario.set(r.scenario, list);
  }
  for (const [scenario, rows] of byScenario) {
    console.log(`\n=== ${scenario} ===`);
    const table = rows
      .slice()
      .sort((a, b) => a.size - b.size || a.engine.localeCompare(b.engine))
      .map((r) => {
        const ref = refBy.get(`${r.scenario}@${r.size}`);
        const best = Math.min(...Object.values(r.variants));
        const refBest = ref === undefined ? undefined : Math.min(...Object.values(ref.variants));
        let fp = "—";
        if (ref !== undefined && r.engine !== "bun-geos") {
          fp = compareFingerprints(ref.fingerprint, r.fingerprint).ok ? "✓" : "✗";
        }
        return {
          engine: r.engine,
          size: r.size,
          bestMs: Number(best.toFixed(2)),
          "×vs-bun-geos":
            refBest !== undefined && refBest > 0 && r.engine !== "bun-geos"
              ? Number((best / refBest).toFixed(2))
              : "—",
          fp,
          repeats: r.repeats,
        };
      });
    console.table(table);
  }
  if (failures.length > 0) {
    console.log(`\nfailures (${failures.length}):`);
    for (const f of failures) console.log(`  ${f.engine} ${f.scenario}: ${f.error}`);
  }
  if (skips.length > 0) {
    console.log(`\nskips (${skips.length}):`);
    for (const s of skips) console.log(`  ${s.engine} ${s.scenario}: ${s.reason}`);
  }
}

/* ------------------------------------------------------------------- main */

console.log("bun-geos competitor benchmarks");
materializeWorkloadFiles();

for (const adapter of [
  bunGeosAdapter,
  geosWasmAdapter,
  jstsAdapter,
  turfAdapter,
  polygonClippingAdapter,
  rbushAdapter,
  flatbushAdapter,
  wkxAdapter,
]) {
  await runAdapter(adapter);
}

await runShapely();
await runCppBaseline();

let commit = "";
try {
  commit = execSync("git rev-parse --short HEAD").toString().trim();
} catch {
  // not a checkout — metadata is best-effort
}
const os = await import("node:os");
const file: CompetitorFile = {
  when: new Date().toISOString(),
  schema: 3,
  bun: Bun.version,
  cpu: os.cpus()[0]?.model ?? "unknown",
  hwThreads: navigator.hardwareConcurrency,
  commit,
  engines,
  results,
  failures,
  skips,
};
writeFileSync(OUT_PATH, `${JSON.stringify(file, null, 2)}\n`);
console.log(
  `\nwritten: ${OUT_PATH} (${results.length} records, ${engines.length} engines, ${failures.length} failures)`,
);
summary();

disposeBunGeos();
