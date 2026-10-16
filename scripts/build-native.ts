/**
 * Dev/native build: GEOS 3.14.1 + the C shim into build/native/ — HOST
 * target. This is the `bun run build:native` entrypoint (shim.md §4 "system
 * compiler, dev only" path; cc()/TinyCC is dropped, spike-results F7).
 *
 * Phase 4: this script is now a thin host-target wrapper over
 * scripts/native/{targets,lib,geos,shim}.ts — the same modules the CI
 * matrix and the packaging scripts use, so dev, CI, and staging share one
 * toolchain table. The GEOS source is the pinned release tarball
 * (SHA-256-verified — licensing.md), not a git clone.
 *
 * Idempotent: skips GEOS when the install tree is present (delete
 * build/native/geos-install to force; delete build/geos-src to re-extract).
 */

import { join } from "node:path";
import { $ } from "bun";
import { buildGeos } from "./native/geos.ts";
import { BUILD_NATIVE, ROOT } from "./native/lib.ts";
import { buildAndStageShim } from "./native/shim.ts";
import { hostTarget } from "./native/targets.ts";

const target = hostTarget();
console.log(`build:native: host target ${target.id}`);

await buildGeos(target);
await buildAndStageShim(target);

// The spike's FFI value-roundtrip table also runs against this tree
// (spike/ has a fallback to build/native so CI needs only one build).
const values = join(ROOT, "spike", "values.c");
await $`gcc -O2 -fPIC -shared -Wall -Wextra ${values} -o ${join(BUILD_NATIVE, "values.so")}`;

console.log("build:native: done");
