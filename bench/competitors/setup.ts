/**
 * `bun run bench:competitors:setup` — provisions the OPTIONAL competitor
 * dependencies. Idempotent; safe to re-run. Everything installed here is
 * bench-only: none of it is a runtime dependency of the library.
 *
 *   1. JS engines: geos-wasm, jsts, @turf/turf, polygon-clipping, rbush,
 *      flatbush, wkx — installed as devDependencies.
 *   2. Shapely 2: a dedicated venv at bench/competitors/.venv (gitignored)
 *      with `shapely` — never touches the system Python.
 *   3. GEOS C++ baseline: nothing to install — `bun run bench:competitors`
 *      compiles it on demand against build/native/geos-install.
 *
 * Engines you skip are simply reported as "skipped" by the suite.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const JS_PACKAGES = [
  "geos-wasm",
  "jsts",
  "@turf/turf",
  "polygon-clipping",
  "rbush",
  "flatbush",
  "wkx",
];

const COMPETITOR_DIR = import.meta.dir;
const VENV_DIR = join(COMPETITOR_DIR, ".venv");
const VENV_PYTHON = join(VENV_DIR, "bin", "python");

function sh(cmd: string[], label: string): void {
  console.log(`[setup] ${label}`);
  const proc = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`[setup] ${label} FAILED (exit ${proc.exitCode}) — that engine will be skipped`);
  }
}

// 1. JS engines (one bun add keeps resolution consistent)
sh(["bun", "add", "-d", ...JS_PACKAGES], `bun add -d ${JS_PACKAGES.join(" ")}`);

// 2. Shapely venv
if (existsSync(VENV_PYTHON)) {
  console.log("[setup] venv already exists — upgrading shapely");
  sh(
    [VENV_PYTHON, "-m", "pip", "install", "--quiet", "--upgrade", "shapely"],
    "pip upgrade shapely",
  );
} else {
  sh(
    ["python3", "-m", "venv", VENV_DIR],
    `python3 -m venv ${VENV_DIR.replace(COMPETITOR_DIR + "/", "")}`,
  );
  sh([VENV_PYTHON, "-m", "pip", "install", "--quiet", "--upgrade", "pip"], "pip upgrade");
  sh([VENV_PYTHON, "-m", "pip", "install", "--quiet", "shapely"], "pip install shapely");
}

console.log("[setup] done — run `bun run bench:competitors`");
