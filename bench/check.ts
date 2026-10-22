/**
 * Benchmark regression alert (ROADMAP Phase 5, testing.md §5 "benchmark
 * regression alerts") — `bun run bench:check`.
 *
 * Re-runs the FULL suite (bench/run.ts, unmodified scale and methodology)
 * into a temp file and compares every variant against the committed
 * bench/results.json baseline. Alerts:
 *   ratio > FAIL (default 1.5)  → regression, exit 1
 *   ratio > WARN (default 1.25) → warning printed, exit 0
 *
 * HONEST BOUNDS (the pinned-hardware rule, testing.md §4): timing ratios are
 * only meaningful on the same machine class as the baseline. When the CPU
 * model or thread count differs from the baseline metadata, the run is
 * ADVISORY — every finding is printed, failures are downgraded to warnings,
 * exit 0 — unless BENCH_REGRESSION_ENFORCE=1 forces enforcement. The CI job
 * (ci.yml `bench-regression`) is workflow_dispatch-only for exactly this
 * reason.
 *
 * Env: BENCH_FAIL_FACTOR / BENCH_WARN_FACTOR override the thresholds;
 * BENCH_REGRESSION_ENFORCE=1 enforces despite a machine mismatch.
 *
 * NOISE FLOOR: variants whose BASELINE value is under MIN_BASELINE_MS
 * (default 10 ms) swing up to 2× between quiet-machine runs — at that scale
 * scheduler/boost state dominates (measured: 4–8 ms rows flipped 1.4–2×
 * across back-to-back runs). They are reported as `noisy (<10ms, advisory)`
 * and never FAIL. BENCH_MIN_BASELINE_MS overrides the floor.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface Result {
  name: string;
  unit: string;
  values: Record<string, number>;
  note?: string;
}
interface BenchFile {
  when: string;
  geos: string;
  bun: string;
  cpu: string;
  hwThreads: number;
  commit: string;
  schema: number;
  results: Result[];
}

const FAIL_FACTOR = Number(process.env.BENCH_FAIL_FACTOR ?? "1.5");
const WARN_FACTOR = Number(process.env.BENCH_WARN_FACTOR ?? "1.25");
const MIN_BASELINE_MS = Number(process.env.BENCH_MIN_BASELINE_MS ?? "10");
const BASELINE_PATH = join(import.meta.dir, "results.json");

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BenchFile;
console.log(
  `bench:check — baseline: ${baseline.cpu}, ${baseline.hwThreads} hw threads · ` +
    `Bun ${baseline.bun} · GEOS ${baseline.geos} · commit ${baseline.commit} (${baseline.when})`,
);

// Run the real suite unmodified, into a temp file (run.ts honors the override
// so the committed baseline is never clobbered).
const outPath = join(tmpdir(), `bun-geos-bench-check-${Date.now()}.json`);
const proc = Bun.spawnSync(["bun", join(import.meta.dir, "run.ts")], {
  stdout: "inherit",
  stderr: "inherit",
  env: { ...process.env, BENCH_RESULTS_OUT: outPath },
});
if (proc.exitCode !== 0) {
  console.error("bench:check — the suite itself failed; see output above");
  process.exit(proc.exitCode ?? 1);
}
const fresh = JSON.parse(readFileSync(outPath, "utf8")) as BenchFile;
unlinkSync(outPath);

const sameMachine = fresh.cpu === baseline.cpu && fresh.hwThreads === baseline.hwThreads;
const enforce = sameMachine || process.env.BENCH_REGRESSION_ENFORCE === "1";
if (!sameMachine) {
  console.log(
    `bench:check — ADVISORY MODE: this machine (${fresh.cpu}, ${fresh.hwThreads} threads) ` +
      `differs from the baseline; timing ratios are not enforceable. ` +
      `Set BENCH_REGRESSION_ENFORCE=1 to override.`,
  );
}

const baseByName = new Map(baseline.results.map((r) => [r.name, r]));
let regressions = 0;
let warnings = 0;
const rows: Array<Record<string, string | number>> = [];

for (const r of fresh.results) {
  const b = baseByName.get(r.name);
  if (b === undefined) {
    rows.push({ benchmark: r.name, variant: "—", verdict: "NEW (no baseline)" });
    continue;
  }
  for (const [variant, f] of Object.entries(r.values)) {
    const bv = b.values[variant];
    if (bv === undefined || bv <= 0) continue;
    const ratio = f / bv;
    if (bv < MIN_BASELINE_MS) {
      rows.push({
        benchmark: r.name,
        variant,
        baseline: Number(bv.toFixed(1)),
        fresh: Number(f.toFixed(1)),
        ratio: Number(ratio.toFixed(2)),
        verdict: `noisy (<${MIN_BASELINE_MS}ms, advisory)`,
      });
      continue;
    }
    let verdict = "ok";
    if (ratio > FAIL_FACTOR) {
      verdict = `REGRESSION ${(ratio).toFixed(2)}×`;
      if (enforce) regressions++;
      else warnings++;
    } else if (ratio > WARN_FACTOR) {
      verdict = `warn ${(ratio).toFixed(2)}×`;
      warnings++;
    } else if (ratio < 1 / FAIL_FACTOR) {
      verdict = `faster ${ratio.toFixed(2)}× (baseline drift?)`;
    }
    rows.push({
      benchmark: r.name,
      variant,
      baseline: Number(bv.toFixed(1)),
      fresh: Number(f.toFixed(1)),
      ratio: Number(ratio.toFixed(2)),
      verdict,
    });
  }
}

console.table(rows);
if (warnings > 0) console.log(`bench:check — ${warnings} warning(s)`);
if (regressions > 0) {
  console.error(`bench:check — ${regressions} REGRESSION(S) vs the committed baseline`);
  process.exit(1);
}
console.log("bench:check — clean");
