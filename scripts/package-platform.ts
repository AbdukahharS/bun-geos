/**
 * Assemble the 7 platform packages (D6/D7) into packages/ for publishing.
 *
 * Each package: the three native artifacts (flat at the root, exactly as
 * staged by the build) + verbatim LGPL-2.1 LICENSE + generated
 * THIRD_PARTY.md + a generated manifest (os/cpu/libc/files/publishConfig).
 * All manifests share the lockstep version from the repo package.json (the
 * exact-pin discipline, D7).
 *
 * Nothing here rearranges native trees — staging happens in
 * scripts/native/shim.ts; this script copies, verifies, and manifests. Run
 * on a machine (or CI job) whose build/native/ holds THAT target's
 * artifacts; --target selects which staged tree to package (default: every
 * target with staged artifacts present).
 *
 * Usage: bun run scripts/package-platform.ts [--target <id>] [--out <dir>]
 */

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  BUILD_NATIVE,
  exists,
  GEOS_TAG,
  GEOS_TARBALL_SHA256,
  GEOS_TARBALL_URL,
  ROOT,
} from "./native/lib.ts";
import { TARGETS, type Target, targetById } from "./native/targets.ts";

const OUT_DIR = join(ROOT, "packages");

interface Args {
  target?: string | undefined;
  out?: string | undefined;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") args.target = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

/** The repo version — the lockstep source of truth for all 8 packages. */
function repoVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
  if (!pkg.version) throw new Error("package-platform: repo package.json has no version");
  return pkg.version;
}

/** Third-party attribution file content (licensing.md §2). */
function thirdParty(target: Target, compilerNote: string): string {
  return `# Third-party notices — @shzd/bun-geos-${target.id}

This package contains prebuilt binaries of:

- **GEOS ${GEOS_TAG}** — the Geometry Engine Open Source library (LGPL-2.1+).
  - Source: ${GEOS_TARBALL_URL}
  - Tarball SHA-256: \`${GEOS_TARBALL_SHA256}\`
  - Built with CMake (\`-DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON\`),
    unmodified, from the release tarball above. The license text ships as
    \`LICENSE\` in this package; the source link above satisfies LGPL-2.1
    §6(a)'s source availability for the binaries distributed here.
- **bun-geos C shim** (\`${target.shimFile}\`) — bun-geos's own glue layer
  (${compilerNote}), MIT-licensed (same as the main package). It links
  GEOS dynamically; no GEOS symbols are statically present.

Verify: \`ldd\` / \`otool -L\` / \`dumpbin /dependents\` on the shipped
binaries show only system libraries plus the bundled GEOS pair.
`;
}

/**
 * Discover the shipped libgeos filename for a staged tree (its real name
 * differs per platform: libgeos.so.3.14.1 / libgeos.3.14.1.dylib / geos.dll).
 */
function findGeosFile(target: Target, dir: string): string {
  const name = readdirSync(dir).find((n) => target.geosFileGlob.test(n));
  if (!name)
    throw new Error(`package-platform: no libgeos matching ${target.geosFileGlob} in ${dir}`);
  return name;
}

async function packageTarget(target: Target, outRoot: string, version: string): Promise<void> {
  const stage = join(outRoot, `@shzd/bun-geos-${target.id}`);
  mkdirSync(stage, { recursive: true });

  // 1. Native artifacts — flat, exactly as staged by the build.
  const files = [target.shimFile, target.geosCFile, findGeosFile(target, BUILD_NATIVE)];
  for (const f of files) {
    const src = join(BUILD_NATIVE, f);
    if (!exists(src)) {
      throw new Error(
        `package-platform: missing staged artifact ${src}\n` +
          `  → build for ${target.id} first (CI matrix job or bun run build:native on the matching host)`,
      );
    }
    copyFileSync(src, join(stage, f));
  }

  // 2. Licensing (licensing.md §2 table).
  copyFileSync(join(ROOT, "licenses", "lgpl-2.1.txt"), join(stage, "LICENSE"));
  const compilerNote = target.os === "win32" ? "MSVC cl" : target.os === "darwin" ? "clang" : "gcc";
  writeFileSync(join(stage, "THIRD_PARTY.md"), thirdParty(target, compilerNote));

  // 3. Manifest.
  const manifest: Record<string, unknown> = {
    name: `@shzd/bun-geos-${target.id}`,
    version,
    description: `GEOS ${GEOS_TAG} binaries + shim for @shzd/bun-geos on ${target.id} — do not install directly.`,
    license: "MIT AND LGPL-2.1-or-later",
    repository: { type: "git", url: "git+https://github.com/shzd/bun-geos.git" },
    os: [target.os],
    cpu: [target.arch],
    files: [...files, "LICENSE", "THIRD_PARTY.md", "README.md"],
    publishConfig: { access: "public" },
  };
  if (target.libc) manifest.libc = [target.libc];
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // 4. Minimal README (package page placeholder; the API lives in the main
  // package).
  writeFileSync(
    join(stage, "README.md"),
    `# @shzd/bun-geos-${target.id}\n\n` +
      `Native binaries (GEOS ${GEOS_TAG} + shim) for [\`@shzd/bun-geos\`](https://www.npmjs.com/package/@shzd/bun-geos) on ${target.id}.\n\n` +
      `Install the main package instead — this one is selected automatically by \`optionalDependencies\`.\n`,
  );

  // 5. Contents assertion (packaging.md: whitelist exact, no symlinks,
  // size band). npm refuses symlinks in tarballs; catch it here.
  for (const entry of readdirSync(stage)) {
    const s = statSync(join(stage, entry));
    if (!s.isFile()) {
      throw new Error(
        `package-platform: ${stage}/${entry} is not a regular file — npm can't ship it`,
      );
    }
  }
  const totalMb = files.reduce((sum, f) => sum + statSync(join(stage, f)).size, 0) / (1024 * 1024);
  console.log(
    `package: @shzd/bun-geos-${target.id} @ ${version} — ${files.join(", ")} (${totalMb.toFixed(1)} MB native)`,
  );
}

const args = parseArgs();
const version = repoVersion();
const outRoot = args.out ?? OUT_DIR;

function selectTargets(): readonly Target[] {
  if (args.target) {
    const t = targetById(args.target);
    if (!t) throw new Error(`package-platform: unknown target ${args.target}`);
    return [t];
  }
  return TARGETS;
}

// Without --target, package every target whose staged artifacts exist —
// packaging runs per platform job in CI, or all-local when trees are present.
let packaged = 0;
for (const target of selectTargets()) {
  const hasArtifacts = exists(join(BUILD_NATIVE, target.shimFile));
  if (!args.target && !hasArtifacts) continue;
  await packageTarget(target, outRoot, version);
  packaged++;
}
if (packaged === 0) {
  console.error(
    "package-platform: nothing to package — no staged artifacts in build/native/\n" +
      "  → bun run build:native (host) or run the CI matrix",
  );
  process.exit(1);
}

// Publish-payload dry-run per package: belt-and-suspenders over the file
// assertions above (npm pack would fail on symlinks or stray files).
for (const dir of readdirSync(join(outRoot, "@shzd"))) {
  const res = await $`npm pack --dry-run`
    .cwd(join(outRoot, "@shzd", dir))
    .quiet()
    .nothrow();
  if (res.exitCode !== 0) {
    console.error(`package-platform: npm pack failed for ${dir}`);
    process.exit(1);
  }
}
console.log("package-platform: done → packages/@shzd/");
