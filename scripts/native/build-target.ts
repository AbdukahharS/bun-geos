/**
 * Build GEOS + shim for ONE target (CI matrix entry; defaults to host).
 *
 * bun run scripts/native/build-target.ts [target-id]
 */

import { buildGeos } from "./geos.ts";
import { buildAndStageShim } from "./shim.ts";
import { hostTarget, targetById } from "./targets.ts";

const id = process.argv[2] ?? hostTarget().id;
const target = targetById(id);
if (!target) {
  console.error(
    `build-target: unknown target "${id}" — supported:\n  ${["darwin-arm64", "darwin-x64", "linux-arm64-gnu", "linux-arm64-musl", "linux-x64-gnu", "linux-x64-musl", "win32-x64"].join("\n  ")}`,
  );
  process.exit(1);
}

console.log(`build-target: ${target.id}`);
await buildGeos(target);
await buildAndStageShim(target);
