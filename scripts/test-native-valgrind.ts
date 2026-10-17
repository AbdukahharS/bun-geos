/**
 * Valgrind gate over the C shim selftest (ROADMAP Phase 5, testing.md §3
 * "native hygiene gates"): memcheck + full leak check on the plain (no
 * sanitizer) selftest driver — this is `bun run test:native:valgrind`.
 *
 * Why a separate build: ASan/UBSan and Valgrind both intercept the allocator;
 * running Valgrind over a sanitized binary produces Interceptor_gaps noise
 * and measures the sanitizers, not the shim. The sanitizer suite
 * (`bun run test:native`) stays the primary in-process gate for the Bun-side
 * crossings; Valgrind catches what it cannot (uninitialized reads,
 * allocator-level leaks on paths ASan's allocator masks).
 *
 * Scope is deliberately the C driver ONLY. Valgrind over `bun test` (JIT +
 * engine allocator) is a false-positive generator and is never planned.
 */

import { join } from "node:path";
import { $ } from "bun";
import { BUILD_NATIVE, ROOT } from "./native/lib.ts";

const SELFTEST = join(ROOT, "test", "native", "shim_selftest.c");
const OUT = join(BUILD_NATIVE, "shim_selftest_valgrind");

// The selftest links the staged shim + libgeos_c and resolves them via RPATH
// (same recipe as package.json's test:native, minus the sanitizers).
await $`gcc -O1 -g -fno-omit-frame-pointer ${SELFTEST} ${join(BUILD_NATIVE, "shim.so")} ${join(BUILD_NATIVE, "libgeos_c.so.1")} -o ${OUT} -Wl,--disable-new-dtags -Wl,-rpath,${BUILD_NATIVE}`;

let vg: string | null;
try {
  vg = Bun.which("valgrind");
} catch {
  vg = null;
}
if (vg === null) {
  console.error(
    "test:native:valgrind: valgrind(1) not found on PATH.\n" +
      "  Arch: sudo pacman -S valgrind · Debian/Ubuntu: sudo apt-get install -y valgrind\n" +
      "  CI installs it in the check job (ci.yml).",
  );
  process.exit(1);
}

console.log(`test:native:valgrind: memcheck + leak-check over ${OUT}`);
// --error-exitcode makes any memcheck failure fail the step; definite leaks
// are errors, "still reachable" (glibc/libc internals) are not.
const proc = Bun.spawn(
  [
    vg,
    "--quiet",
    "--error-exitcode=9",
    "--leak-check=full",
    "--show-leak-kinds=definite",
    "--errors-for-leak-kinds=definite",
    "--track-origins=yes",
    OUT,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
const code = await proc.exited;
if (code === 0) {
  console.log("test:native:valgrind: ALL CLEAN");
} else {
  console.error(`test:native:valgrind: FAILED (valgrind exit ${code})`);
}
process.exit(code);
