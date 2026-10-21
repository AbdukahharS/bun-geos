/**
 * The release pipeline (packaging.md §5 order, D26 stage-and-publish):
 *
 *   check → publish 7 platforms → verify registry resolution → publish main
 *   → verify main → GitHub release notes
 *
 * Auth: `--auth token` (default, Phase 4) — a granular npm token arrives via
 * NPM_TOKEN; a per-run .npmrc is written under packages/ (gitignored) with
 * ${NPM_TOKEN} env interpolation, so the secret never lands on disk in
 * plaintext. `--auth oidc` is reserved for the trusted-publishing switch
 * (no .npmrc; requires the OIDC workflow context) — everything else is
 * identical, which is what makes the later switch a one-line change.
 *
 * Idempotent: any package already on the registry at the repo version is
 * skipped, so a failed release re-runs cleanly.
 *
 * Dist-tag (D30): a stable version publishes under `latest`; a prerelease
 * (e.g. 0.2.0-rc.1) under `rc` — `--tag latest` for a prerelease hard-fails.
 *
 * Usage: bun run scripts/release.ts [--auth token|oidc] [--tag <name>] [--dry-run]
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { ROOT } from "./native/lib.ts";
import { TARGETS } from "./native/targets.ts";

type Auth = "token" | "oidc";

const argv = process.argv.slice(2);
const auth: Auth = argv.includes("--auth")
  ? ((): Auth => {
      const v = argv[argv.indexOf("--auth") + 1];
      if (v !== "token" && v !== "oidc") throw new Error("release: --auth must be token|oidc");
      return v;
    })()
  : "token";
const dryRun = argv.includes("--dry-run");

const PACKAGES = join(ROOT, "packages");
const MAIN_DIR = join(PACKAGES, "@shzd", "bun-geos");

function repoVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version?: string };
  if (!pkg.version) throw new Error("release: repo package.json has no version");
  return pkg.version;
}

const VERSION = repoVersion();

// D30: a prerelease version (e.g. 0.2.0-rc.1) NEVER rides `latest` — it
// publishes under the `rc` dist-tag so default install ranges stay on the
// last stable release. An explicit `--tag latest` for a prerelease is a
// hard error (the one way the convention could be silently violated).
const tagArg = argv.includes("--tag")
  ? ((): string => {
      const v = argv[argv.indexOf("--tag") + 1];
      if (!v || v.startsWith("-")) throw new Error("release: --tag requires a value");
      return v;
    })()
  : null;
const IS_PRERELEASE = VERSION.includes("-");
const NPM_TAG = tagArg ?? (IS_PRERELEASE ? "rc" : "latest");
if (IS_PRERELEASE && NPM_TAG === "latest") {
  throw new Error(
    `release: ${VERSION} is a prerelease — dist-tag 'latest' is not allowed (D30); ` +
      "publish it as --tag rc (or another explicit channel)",
  );
}

function step(msg: string): void {
  console.log(`\n=== ${msg} ===`);
}

/** True if pkg@version is on the registry (false on 404 / not found). */
async function published(name: string, version: string): Promise<boolean> {
  const res = await $`npm view ${`${name}@${version}`} version`.quiet().nothrow();
  return res.exitCode === 0;
}

function stagedDirs(): string[] {
  return TARGETS.map((t) => join(PACKAGES, "@shzd", `bun-geos-${t.id}`)).filter((d) =>
    existsSync(d),
  );
}

/** npm publish for one staged package dir; returns "published"|"skipped". */
async function publish(dir: string, name: string): Promise<"published" | "skipped"> {
  if (await published(name, VERSION)) {
    console.log(`release: ${name}@${VERSION} already on the registry — skipping`);
    return "skipped";
  }
  if (dryRun) {
    console.log(`release: [dry-run] would publish ${name}@${VERSION}`);
    return "skipped";
  }
  // --auth token: per-run .npmrc with env interpolation (no plaintext
  // token on disk). --auth oidc: no .npmrc — the OIDC context authenticates.
  // NOTE: npm reads .npmrc from the project root (the dir containing
  // package.json) only — it does NOT walk ancestors — so the file goes
  // right next to the staged manifest, and is removed after the publish.
  if (auth === "token") {
    if (!process.env.NPM_TOKEN) {
      throw new Error(
        "release: NPM_TOKEN is not set.\n" +
          "  → create a granular npm token (read/write, @shzd scope) and export it:\n" +
          "      export NPM_TOKEN=npm_xxx",
      );
    }
  }
  const npmrcPath = join(dir, ".npmrc");
  if (auth === "token") {
    // `${NPM_TOKEN}` is npm's .npmrc env-interpolation syntax, not a JS
    // template — the file carries no plaintext secret.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: npm .npmrc syntax
    writeFileSync(npmrcPath, "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n");
  }
  try {
    // OIDC (trusted publishing) REQUIRES --provenance: it is the flag that
    // makes npm fetch the GitHub OIDC token (id-token: write) and exchange
    // it for a short-lived publish credential. Without it npm has no
    // credential at all and fails with ENEEDAUTH — the v0.1.0 tag run's
    // failure (2026-10-17). Requirements pinned in packaging.md §7.5:
    // npm ≥ 11.5.1 (Node 24 in release.yml), environment `release`,
    // repository.url exact, trusted-publisher config on npmjs.com.
    const res =
      auth === "oidc"
        ? await $`npm publish --access public --provenance --tag ${NPM_TAG}`
            .cwd(dir)
            .quiet()
            .nothrow()
        : await $`npm publish --access public --tag ${NPM_TAG}`.cwd(dir).quiet().nothrow();
    if (res.exitCode !== 0) {
      const stderr = res.stderr.toString().trim();
      throw new Error(`release: npm publish failed for ${name}\n${stderr}`);
    }
  } finally {
    if (auth === "token") rmSyncSafe(npmrcPath);
  }
  console.log(`release: published ${name}@${VERSION} → dist-tag ${NPM_TAG}`);
  return "published";
}

function rmSyncSafe(path: string): void {
  try {
    rmSync(path);
  } catch {
    // best-effort cleanup; the file has no secret (env interpolation)
  }
}

/** Verify a package resolves on the registry, retrying through CDN lag.
 * The schedule leaves ~230 s of total headroom: the v0.1.0 release
 * (2026-10-17) had a package take longer than the previous ~110 s budget
 * to become `npm view`-visible after a successful publish — the package
 * was live minutes later, and only the verify gave up (packaging.md
 * §7.5, lesson 3). A late-added 120 s final wait absorbs that class. */
async function verifyResolves(name: string): Promise<void> {
  const delays = [0, 5_000, 15_000, 30_000, 60_000, 120_000];
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (attempt > 0) {
      console.log(`release: ${name} not visible yet — retrying in ${delays[attempt]! / 1000}s`);
      await Bun.sleep(delays[attempt]!);
    }
    const res = await $`npm view ${`${name}@${VERSION}`} dist.tarball`.quiet().nothrow();
    if (res.exitCode === 0) {
      console.log(`release: verified ${name}@${VERSION} resolves`);
      return;
    }
  }
  throw new Error(
    `release: ${name}@${VERSION} did not resolve after ${delays.length} attempts — ` +
      `STOP before publishing the main package (the silent-optional failure mode, packaging.md §2)`,
  );
}

// ── 1. Check ─────────────────────────────────────────────────────────────

step("check");
{
  const gitStatus = await $`git -C ${ROOT} status --porcelain`.quiet().nothrow();
  if (gitStatus.exitCode !== 0) throw new Error("release: not a git repo?");
  const dirty = gitStatus.stdout.toString().trim();
  if (dirty && !dryRun) {
    throw new Error(
      "release: working tree is dirty — commit or stash first (releases build from a tag)",
    );
  }
  const dirs = stagedDirs();
  if (dirs.length !== TARGETS.length) {
    throw new Error(
      `release: expected ${TARGETS.length} staged platform packages in ${PACKAGES}/@shzd, found ${dirs.length}\n` +
        `  → run the CI build matrix, then 'bun run package:platform' per target`,
    );
  }
  if (!existsSync(join(MAIN_DIR, "package.json"))) {
    throw new Error("release: main package not staged → bun run package:main");
  }
  for (const dir of [...dirs, MAIN_DIR]) {
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      version?: string;
    };
    if (manifest.version !== VERSION) {
      throw new Error(
        `release: ${dir} is version ${manifest.version}, repo says ${VERSION} — restage (lockstep!)`,
      );
    }
  }
  console.log(`release: 8 packages staged at ${VERSION}, tree clean`);
  if (IS_PRERELEASE) {
    console.log(`release: ${VERSION} is a prerelease → dist-tag '${NPM_TAG}' (D30)`);
  }
}

// ── 2. Publish platforms ─────────────────────────────────────────────────

step(`publish platforms (${TARGETS.length})`);
for (const t of TARGETS) {
  await publish(join(PACKAGES, "@shzd", `bun-geos-${t.id}`), `@shzd/bun-geos-${t.id}`);
}

// ── 3. Verify resolution BEFORE main (the silent-optional guard) ─────────

step("verify registry resolution");
if (dryRun) {
  console.log("release: [dry-run] skipping resolution verification (nothing published)");
} else {
  for (const t of TARGETS) {
    await verifyResolves(`@shzd/bun-geos-${t.id}`);
  }
}

// ── 4. Publish main ──────────────────────────────────────────────────────

step("publish main");
await publish(MAIN_DIR, "@shzd/bun-geos");

// ── 5. Verify main ───────────────────────────────────────────────────────

step("verify main resolution");
if (!dryRun) await verifyResolves("@shzd/bun-geos");
else console.log("release: [dry-run] skipping");

// ── 6. GitHub release notes ──────────────────────────────────────────────

step("github release");
{
  const notes = changelogSection(VERSION);
  if (dryRun) {
    console.log("release: [dry-run] would create the GitHub release");
  } else if (!notes) {
    console.warn(`release: no CHANGELOG.md section for ${VERSION} — skipping gh release`);
  } else {
    const res =
      await $`gh release create ${`v${VERSION}`} --title ${`v${VERSION}`} --notes ${notes}`
        .cwd(ROOT)
        .nothrow();
    if (res.exitCode !== 0) {
      console.warn("release: gh release create failed (already exists? no gh?) — continuing");
    } else {
      console.log(`release: GitHub release v${VERSION} created`);
    }
  }
}

step("DONE");
console.log(
  `release: @shzd/bun-geos ${VERSION} is live — run the install matrix to close the exit criteria`,
);

/** Extract the `## <version>` section from CHANGELOG.md, if present. */
function changelogSection(version: string): string | null {
  const path = join(ROOT, "CHANGELOG.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(`## ${version}`);
  if (start === -1) return null;
  const rest = text.slice(start + `## ${version}`.length);
  const next = rest.indexOf("\n## ");
  return `## ${version}${next === -1 ? rest : rest.slice(0, next)}`.trim();
}
