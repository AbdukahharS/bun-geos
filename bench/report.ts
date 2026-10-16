/**
 * Render docs/benchmarks.md from bench/results.json (D25: benchmarks
 * published and reproducible). `bun run bench:report` after `bun run bench`.
 */
import { readFileSync, writeFileSync } from "node:fs";
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

const raw = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "bench", "results.json"), "utf8"),
) as BenchFile;

const lines: string[] = [
  "# Benchmarks",
  "",
  `> Machine: \`${raw.cpu}\`, ${raw.hwThreads} hw threads · Bun ${raw.bun} · GEOS ${raw.geos} · commit \`${raw.commit}\` · ${raw.when}`,
  ">",
  "> Best-of-N wall time, warm-up excluded (see `bench/run.ts`). Regenerate with",
  "> `bun run bench`; this page is rendered by `bun run bench:report`. Competitor",
  "> runs (geos-wasm / turf / polygon-clipping) are optional devDependencies —",
  "> `bench/competitors/*.ts` merges into the same schema when installed.",
  "> Positioning rule (testing.md §4): robust overlays, repair, and indexed/",
  "> batched workloads — never trivial-op marketing.",
  "",
];

for (const r of raw.results) {
  lines.push(`## ${r.name}`, "");
  lines.push("| variant | ms |", "|---|---|");
  for (const [k, v] of Object.entries(r.values)) {
    lines.push(`| ${k} | ${v.toFixed(1)} |`);
  }
  if (r.note !== undefined) lines.push("", `_${r.note}_`);
  lines.push("");
}

lines.push(
  "## Reading the batch numbers honestly (D22)",
  "",
  "On Bun 1.4.x the engine-native FFI makes per-object calls cheap (~tens of ns),",
  "so main-thread shim batch paths converge toward the GEOS-bound cost of the",
  "workload (~1× on overlay; 0.8–1.2× on masks/measures). The batch layer's",
  "measured ≥5× axis is the **worker pool** (see the `parallel makeValid` rows):",
  "the one-crossing property remains load-bearing for interrupt granularity",
  "(between-item aborts), all-or-nothing error contracts, and future Bun",
  "versions where per-call costs regress.",
  "",
);

writeFileSync(join(import.meta.dir, "..", "docs", "benchmarks.md"), `${lines.join("\n")}\n`);
console.log("written: docs/benchmarks.md");
