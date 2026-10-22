/**
 * Render docs/benchmarks.md from bench/results.json (D25: benchmarks
 * published and reproducible). `bun run bench:report` after `bun run bench`.
 * When bench/competitors/results.json exists (schema 3), the cross-engine
 * comparison matrices are appended below the internal sections.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  "> `bun run bench`; this page is rendered by `bun run bench:report`. The competitor",
  "> comparison below renders when `bench/competitors/results.json` exists —",
  "> `bun run bench:competitors` (provision with `bench:competitors:setup`).",
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

/* ------------------------------------------------ competitor comparison */

interface Fingerprint {
  count?: number;
  areaSum: number | null;
  hits?: number;
}
interface ScenarioRecord {
  engine: string;
  engineVersion: string;
  boundary: string;
  scenario: string;
  size: number;
  variants: Record<string, number>;
  repeats: number;
  fingerprint: Fingerprint;
  note?: string;
}
interface CompetitorFile {
  when: string;
  schema: number;
  bun: string;
  cpu: string;
  hwThreads: number;
  commit: string;
  engines: Array<{
    engine: string;
    version: string | null;
    boundary: string;
    status: "ran" | "skipped";
    note?: string;
  }>;
  results: ScenarioRecord[];
  failures: Array<{ engine: string; scenario: string; error: string }>;
  skips?: Array<{ engine: string; scenario: string; reason: string }>;
}

function compareFp(ref: Fingerprint, other: Fingerprint): boolean {
  let ok = true;
  if (ref.count !== undefined && other.count !== undefined) ok = ok && ref.count === other.count;
  if (ref.hits !== undefined && other.hits !== undefined) ok = ok && ref.hits === other.hits;
  if (ref.areaSum !== null && other.areaSum !== null && ref.areaSum !== 0) {
    ok = ok && Math.abs(other.areaSum - ref.areaSum) / Math.abs(ref.areaSum) <= 1e-9;
  }
  return ok;
}

const COMPETITOR_PATH = join(import.meta.dir, "competitors", "results.json");
if (existsSync(COMPETITOR_PATH)) {
  const raw = JSON.parse(readFileSync(COMPETITOR_PATH, "utf8")) as CompetitorFile;
  const out: string[] = [
    "",
    "---",
    "",
    "# Competitor comparison",
    "",
    `> Same seeded workloads, same methodology (best-of-N wall ms, warm-up excluded,`,
    "> answer fingerprints accumulated inside the timed region), every boundary:",
    "> native FFI (bun-geos), direct C (geos-cpp), WASM (geos-wasm), ctypes (Shapely),",
    "> and pure JS (JSTS / turf / polygon-clipping / rbush / flatbush / wkx).",
    `> Run \`${raw.when}\` on \`${raw.cpu}\` · commit \`${raw.commit}\` — regenerate with`,
    "> `bun run bench:competitors` (optional devDependencies: `bun run bench:competitors:setup`).",
    ">",
    "> **fp** = answer fingerprint vs bun-geos at the same size (✓ agree / ✗ differs —",
    "> read the engine's note before trusting a ✗ row, e.g. turf's buffer projects",
    "> geographically by design). **× vs bun-geos** compares each engine's variant",
    "> against the reference's BEST variant at that size; ratios within [0.9, 1.1]",
    "> render as ≈ (the cross-process noise floor). Speedups are same-machine,",
    "> same-input numbers.",
    "",
  ];

  out.push("## Engines", "", "| engine | version | boundary | status |", "|---|---|---|---|");
  for (const e of raw.engines) {
    out.push(
      `| ${e.engine} | ${e.version ?? "—"} | ${e.boundary} | ${e.status}${e.note ? ` — ${e.note}` : ""} |`,
    );
  }
  out.push("");

  const byScenario = new Map<string, ScenarioRecord[]>();
  for (const r of raw.results) {
    const list = byScenario.get(r.scenario) ?? [];
    list.push(r);
    byScenario.set(r.scenario, list);
  }

  for (const [scenario, rows] of byScenario) {
    out.push(`## ${scenario}`, "");
    out.push(
      "| size | engine | variant | ms | geoms/s | × vs bun-geos | fp | note |",
      "|---|---|---|---|---|---|---|---|",
    );
    const refBySize = new Map<number, ScenarioRecord>();
    for (const r of rows) if (r.engine === "bun-geos") refBySize.set(r.size, r);
    const sorted = rows.slice().sort((a, b) => a.size - b.size || a.engine.localeCompare(b.engine));
    for (const r of sorted) {
      const ref = refBySize.get(r.size);
      const refBest = ref === undefined ? undefined : Math.min(...Object.values(ref.variants));
      const fpOk =
        r.engine === "bun-geos"
          ? true
          : ref === undefined
            ? undefined
            : compareFp(ref.fingerprint, r.fingerprint);
      for (const [variant, ms] of Object.entries(r.variants)) {
        // geoms/s is meaningless for index-query rows (candidates ÷ ms) —
        // only op-throughput scenarios get the throughput column.
        const ops =
          r.scenario === "strtree" && (variant === "query" || variant.startsWith("query-"))
            ? "—"
            : Math.round((r.size / ms) * 1000).toLocaleString("en-US");
        const isRef = r.engine === "bun-geos";
        const ratio = refBest !== undefined && refBest > 0 ? ms / refBest : undefined;
        // Cross-process timing variance is ±10% on this hardware — ratios in
        // [0.9, 1.1] are ties, not rankings (testing.md §4 noise note).
        const speedup =
          isRef || ratio === undefined
            ? "—"
            : ratio >= 0.9 && ratio <= 1.1
              ? "≈"
              : `${ratio.toFixed(2)}×`;
        const fpCell = isRef ? "—" : fpOk === undefined ? "—" : fpOk ? "✓" : "✗";
        out.push(
          `| ${r.size} | ${r.engine} | ${variant} | ${ms.toFixed(1)} | ${ops} | ${speedup} | ${fpCell} | ${r.note ?? ""} |`,
        );
      }
    }
    out.push("");
  }

  if (raw.failures.length > 0 || (raw.skips?.length ?? 0) > 0) {
    out.push("## Failures & skips", "");
    for (const f of raw.failures) out.push(`- \`${f.engine}\` ${f.scenario}: ${f.error}`);
    for (const s of raw.skips ?? []) {
      out.push(`- \`${s.engine}\` ${s.scenario}: _skipped_ — ${s.reason}`);
    }
    out.push("");
  }

  writeFileSync(
    join(import.meta.dir, "..", "docs", "benchmarks.md"),
    `${lines.join("\n")}${out.join("\n")}\n`,
  );
  console.log("written: docs/benchmarks.md (with competitor comparison)");
}
