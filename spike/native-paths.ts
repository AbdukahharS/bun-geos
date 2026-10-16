/**
 * Spike native-artifact paths: prefer the frozen Phase 0 tree when present
 * (historic evidence stays intact), fall back to the Phase 1 dev tree so
 * `bun test spike/` works on a clean checkout after only
 * `bun run build:native` — which is what CI runs (audit fix: the spike step
 * used to depend on spike/build, which nothing in CI ever produced).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

const SPIKE_TREE = join(import.meta.dir, "build");
const PHASE1_TREE = join(import.meta.dir, "..", "build", "native");

function firstExisting(candidates: string[]): string {
  for (const c of candidates) if (existsSync(c)) return c;
  throw new Error(
    "spike: no native artifacts found — run `bun run build:native` (or the historic spike/setup.sh)",
  );
}

export const GEOS_C_PATH = firstExisting([
  join(SPIKE_TREE, "geos-install", "lib", "libgeos_c.so.1.20.5"),
  join(PHASE1_TREE, "libgeos_c.so.1"),
]);

export const SHIM_PATH = firstExisting([join(SPIKE_TREE, "shim.so"), join(PHASE1_TREE, "shim.so")]);

export const VALUES_PATH = firstExisting([
  join(SPIKE_TREE, "values.so"),
  join(PHASE1_TREE, "values.so"),
]);
