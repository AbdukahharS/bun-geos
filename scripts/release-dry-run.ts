/**
 * Verdaccio dry-run: the full publish→resolve→install→overlay flow against
 * a LOCAL registry — the pre-release gate that proves staging, manifests,
 * and the silent-optional mechanics without burning real versions
 * (packaging.md §5's order, rehearsed safely).
 *
 * Requires Docker (verdaccio/verdaccio:6, pinned). Steps:
 *   1. stage all 8 packages (package:platform + package:main)
 *   2. start verdaccio, seed a publisher user via its REST API
 *   3. npm publish all 8 against the local registry
 *   4. fresh temp dir: `bun add @shzd/bun-geos` + the install overlay
 *
 * Usage: bun run scripts/release-dry-run.ts
 */

import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { ROOT } from "./native/lib.ts";

const REGISTRY = "http://localhost:4873";
const VERDACCIO_IMAGE = "verdaccio/verdaccio:6";
const CONTAINER = "bun-geos-dry-run";

// Docker available?
const dockerCheck = await $`docker info`.quiet().nothrow();
if (dockerCheck.exitCode !== 0) {
  console.error(
    "dry-run: docker is not available — the dry-run needs it (verdaccio registry).\n" +
      "  start docker, or skip: the real gate is the release pipeline's registry verify.",
  );
  process.exit(1);
}

// 1. Stage all 8.
console.log("dry-run: staging packages");
await $`bun run scripts/package-platform.ts`.cwd(ROOT);
await $`bun run scripts/package-main.ts`.cwd(ROOT);

// 2. Verdaccio up + seed user (non-interactive: REST PUT the couchdb user).
console.log("dry-run: starting verdaccio");
await $`docker rm -f ${CONTAINER}`.quiet().nothrow();
await $`docker run -d --name ${CONTAINER} -p 4873:4873 ${VERDACCIO_IMAGE}`;
try {
  let up = false;
  for (let i = 0; i < 30 && !up; i++) {
    await Bun.sleep(1000);
    up = (await $`curl -sf ${REGISTRY}`.quiet().nothrow()).exitCode === 0;
  }
  if (!up) throw new Error("dry-run: verdaccio did not come up in 30s");

  const seed =
    await $`curl -sf -X PUT ${`${REGISTRY}/-/user/org.couchdb.user:dryrun`} -H 'Content-Type: application/json' -d '{"name":"dryrun","password":"dryrun","email":"dryrun@example.com","type":"user","roles":[],"date":"2026-01-01T00:00:00.000Z"}'`
      .quiet()
      .nothrow();
  if (seed.exitCode !== 0) throw new Error("dry-run: could not seed the verdaccio user");
  const token = (JSON.parse(seed.stdout.toString()) as { token: string }).token;

  // Publish config for the local registry (throwaway token, inline — the
  // registry dies with the container). npm reads .npmrc from the project
  // root only, so each staged dir gets its own, removed after publishing.
  const npmrcBody = `${REGISTRY.replace("http://", "//")}/:_authToken=${token}\nalways-auth=true\n`;

  // 3. Publish whatever is STAGED (platforms first, then main). A local
  // run typically stages only the host's linux variants — the missing
  // platform packages are the silent-optional case under test: bun/npm
  // must skip them and install the matching pair.
  console.log("dry-run: publishing staged packages to verdaccio");
  const staged = readdirSync(join(ROOT, "packages", "@shzd")).filter(
    (d) => d !== "bun-geos" && d.startsWith("bun-geos-"),
  );
  for (const dir of staged.sort()) {
    const pkgDir = join(ROOT, "packages", "@shzd", dir);
    writeFileSync(join(pkgDir, ".npmrc"), npmrcBody);
    try {
      const res = await $`npm publish --registry ${REGISTRY} --access public`
        .cwd(pkgDir)
        .quiet()
        .nothrow();
      if (res.exitCode !== 0) {
        throw new Error(`dry-run: publish failed for ${dir}\n${res.stderr.toString().trim()}`);
      }
    } finally {
      rmSync(join(pkgDir, ".npmrc"), { force: true });
    }
    console.log(`dry-run: published @shzd/${dir}`);
  }
  const mainRes = await (async () => {
    const dir = join(ROOT, "packages", "@shzd", "bun-geos");
    writeFileSync(join(dir, ".npmrc"), npmrcBody);
    try {
      return await $`npm publish --registry ${REGISTRY} --access public`.cwd(dir).quiet().nothrow();
    } finally {
      rmSync(join(dir, ".npmrc"), { force: true });
    }
  })();
  if (mainRes.exitCode !== 0) {
    throw new Error(
      `dry-run: publish failed for the main package\n${mainRes.stderr.toString().trim()}`,
    );
  }
  console.log("dry-run: published @shzd/bun-geos");

  // 4. Clean-machine consumption: fresh dir, plain `bun add`, run the
  // overlay from node_modules (never the checkout).
  console.log("dry-run: clean install + overlay");
  const consumer = mkdtempSync(join(tmpdir(), "geos-dryrun-consumer-"));
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "consumer", type: "module" }),
  );
  await $`bun add @shzd/bun-geos --registry ${REGISTRY}`.cwd(consumer);
  copyFileSync(join(ROOT, "scripts", "install-overlay.ts"), join(consumer, "install-overlay.ts"));
  await $`bun run install-overlay.ts`.cwd(consumer);
  console.log("dry-run: PASS — full publish→install→overlay flow works against verdaccio");
} finally {
  await $`docker rm -f ${CONTAINER}`.quiet().nothrow();
}
