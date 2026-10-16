/**
 * Assemble the main package (packages/@shzd/bun-geos) for publishing.
 *
 * Stage-and-publish model (D26): the repo manifest stays private:true; the
 * PUBLISHED manifest is generated here with the fields the repo one must not
 * have (publishConfig.access, exact optionalDependencies pins) and without
 * the ones it must not ship (private, the typescript peerDep — consumers
 * bring their own TS; Bun runs the .ts source directly, D1).
 *
 * The runtime ships as raw TypeScript source (Decision E): Bun executes TS
 * natively, so `exports` points at index.ts and there is no build step —
 * the published bytes are exactly the tested bytes.
 *
 * Usage: bun run scripts/package-main.ts [--out <dir>]
 */

import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./native/lib.ts";
import { TARGETS } from "./native/targets.ts";

const OUT_DIR = join(ROOT, "packages");

function repoManifest(): {
  version: string;
  description: string;
  license: string;
} {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    version?: string;
    description?: string;
    license?: string;
  };
  if (!pkg.version) throw new Error("package-main: repo package.json has no version");
  if (!pkg.description) throw new Error("package-main: repo package.json has no description");
  if (!pkg.license) throw new Error("package-main: repo package.json has no license");
  return {
    version: pkg.version,
    description: pkg.description,
    license: pkg.license,
  };
}

const repo = repoManifest();

function outDir(): string {
  const i = process.argv.indexOf("--out");
  if (i === -1) return OUT_DIR;
  const v = process.argv[i + 1];
  if (!v) throw new Error("package-main: --out needs a value");
  return v;
}

const out = join(outDir(), "@shzd", "bun-geos");
mkdirSync(out, { recursive: true });

// Exact pins, never ranges — lockstep with the platform packages (D7).
const optionalDependencies: Record<string, string> = {};
for (const t of TARGETS) {
  optionalDependencies[`@shzd/bun-geos-${t.id}`] = repo.version;
}

const manifest = {
  name: "@shzd/bun-geos",
  version: repo.version,
  description: repo.description,
  license: repo.license,
  repository: { type: "git", url: "git+https://github.com/shzd/bun-geos.git" },
  type: "module",
  // Raw TS source (D1: Bun-only) — no build step, no bundler, no d.ts
  // generation. Consumers' Bun runs the source; their TS 7 reads the types
  // from the same files.
  exports: { ".": "./index.ts" },
  files: ["index.ts", "src/", "README.md", "LICENSE"],
  engines: { bun: ">=1.4.3" },
  optionalDependencies,
  publishConfig: { access: "public" },
};
writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Runtime source + license + readme, verbatim from the repo (the tested
// bytes ARE the published bytes).
cpSync(join(ROOT, "index.ts"), join(out, "index.ts"));
cpSync(join(ROOT, "src"), join(out, "src"), { recursive: true });
cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
cpSync(join(ROOT, "README.md"), join(out, "README.md"));

console.log(
  `package-main: @shzd/bun-geos @ ${repo.version} — ${Object.keys(optionalDependencies).length} exact platform pins → ${out}`,
);
