/**
 * Static architecture validation for a staged platform package — the smoke
 * gate for CROSS-COMPILED targets (darwin-x64 built on an arm64 runner).
 *
 * Why not the dynamic smoke there: the x64 bun process must run under
 * Rosetta, and Bun's JIT SIGILLs under Rosetta once `bun:ffi` engages
 * (observed on 1.4.3 — crash report linked in CI). An arm64 process cannot
 * load x86_64 dylibs either, so in-CI execution is not attainable; real
 * Intel Macs run the package natively and are unaffected. This check pins
 * what CAN be pinned in CI: every shipped binary is exactly the target
 * architecture. Dependency structure is checked separately by
 * licensing-check.ts (otool @rpath assertions).
 *
 * Usage: bun run scripts/native/arch-check.ts <target-id> <expected-arch>
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { BUILD_NATIVE } from "./lib.ts";
import { targetById } from "./targets.ts";

const id = process.argv[2];
const expected = process.argv[3];
const target = id ? targetById(id) : undefined;
if (!target || !expected) {
  console.error("arch-check: usage — arch-check.ts <target-id> <expected-arch>");
  process.exit(1);
}

const files = readdirSync(BUILD_NATIVE)
  .filter((n) => /\.(so|dylib|dll)(\.\d.*)?$/.test(n))
  .map((n) => join(BUILD_NATIVE, n));
if (files.length === 0) {
  console.error(`arch-check: no binaries staged in ${BUILD_NATIVE}`);
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const res = await $`lipo -info ${file}`.quiet().nothrow();
  // lipo prints "path: x86_64" (or "... is architecture: x86_64") — the
  // architecture is the last whitespace-separated token either way.
  const arch = res.stdout.toString().trim().split(/\s+/).pop();
  if (res.exitCode === 0 && arch === expected) {
    console.log(`  ok    ${file.split("/").pop()}: ${arch}`);
  } else {
    failures++;
    console.error(`  FAIL  ${file}: expected ${expected}, got "${res.stdout.toString().trim()}"`);
  }
}

if (failures > 0) {
  console.error(`arch-check: ${failures} artifact(s) not ${expected}`);
  process.exit(1);
}
console.log(`arch-check: all staged artifacts are ${expected}`);
