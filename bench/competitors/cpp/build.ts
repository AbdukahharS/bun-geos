/**
 * Builds the GEOS C++ direct baseline (cpp/baseline.cc → cpp/baseline)
 * against the dev native GEOS install (build/native/geos-install) — no new
 * native dependencies; GEOS is already vendored and built by
 * `bun run build:native`. The baseline is the zero-boundary reference:
 * the same engine bun-geos binds, called directly in C++.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioId } from "../../lib/metrics.ts";
import { LADDERS } from "../../lib/scenarios.ts";

const CPP_DIR = import.meta.dir;
const BIN_PATH = join(CPP_DIR, "baseline");
const GEOS_INSTALL = join(import.meta.dir, "..", "..", "..", "build", "native", "geos-install");

/** Sizes the C++ baseline runs per scenario (mirrors the shared ladders). */
export function baselineScenarioSizes(scenario: ScenarioId): number[] {
  return LADDERS[scenario];
}

/** Compile (if stale/missing) and return the baseline binary path. Throws with remediation. */
export function ensureBaseline(): string {
  if (!existsSync(GEOS_INSTALL)) {
    throw new Error(
      "GEOS dev install missing — run `bun run build:native` first (baseline compiles against build/native/geos-install)",
    );
  }
  if (existsSync(BIN_PATH)) return BIN_PATH;

  const inc = join(GEOS_INSTALL, "include");
  const lib = join(GEOS_INSTALL, "lib");
  const proc = Bun.spawnSync(
    [
      "g++",
      "-O2",
      "-std=c++17",
      `-I${inc}`,
      join(CPP_DIR, "baseline.cc"),
      `-L${lib}`,
      "-lgeos_c",
      `-Wl,-rpath,${lib}`,
      "-o",
      BIN_PATH,
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) throw new Error(`g++ failed (exit ${proc.exitCode}) — see output above`);
  return BIN_PATH;
}
