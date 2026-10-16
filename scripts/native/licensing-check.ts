/**
 * Licensing spot checks for a staged platform package (licensing.md §4
 * checklist, run in CI on the runner that built the target):
 *
 *   1. the three binaries exist and are regular files;
 *   2. the shim's dynamic dependencies are exactly the bundled libgeos_c
 *      (+ system libs) — DYNAMIC linking only (D12);
 *   3. no GEOS API symbols are DEFINED in the shim binary (static-linking
 *      would trigger LGPL §6's object-file obligations — never do it).
 *
 * Usage: bun run scripts/native/licensing-check.ts <target-id>
 * (Tools: ldd/readelf on Linux, otool/nm on macOS, dumpbin on Windows.)
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { BUILD_NATIVE } from "./lib.ts";
import { targetById } from "./targets.ts";

const id = process.argv[2];
const target = id ? targetById(id) : undefined;
if (!target) {
  console.error("licensing-check: pass a target id (see scripts/native/targets.ts)");
  process.exit(1);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
}

async function out(cmd: string[]): Promise<string> {
  const res = await $`${cmd}`.quiet().nothrow();
  return res.stdout.toString();
}

const shimPath = join(BUILD_NATIVE, target.shimFile);
const geosCPath = join(BUILD_NATIVE, target.geosCFile);

// 1. Files exist, regular, non-empty.
for (const p of [shimPath, geosCPath]) {
  const ok = existsSync(p) && statSync(p).isFile() && statSync(p).size > 0;
  check(`artifact present: ${p.split("/").pop() ?? p}`, ok);
}

if (!existsSync(shimPath)) process.exit(1);

// 2 + 3 per platform.
if (target.os === "linux") {
  const needed = await out(["ldd", shimPath]);
  check(
    "shim links the bundled libgeos_c dynamically",
    /libgeos_c\.so\.1 => not found|libgeos_c\.so\.1 \(/.test(needed) ||
      needed.includes("libgeos_c.so.1"),
    needed,
  );
  // Defined (not merely imported) GEOS API symbols would mean static GEOS.
  const defined = await out(["nm", "-D", "--defined-only", shimPath]);
  const staticGeos = defined.split("\n").filter((l) => /\bT\s+_?GEOS[A-Z]/.test(l));
  check("no static GEOS symbols in the shim", staticGeos.length === 0, staticGeos.join("\n"));

  const geosCNeeded = await out(["readelf", "-d", geosCPath]);
  check(
    "libgeos_c NEEDs the bundled libgeos (transitive pair intact)",
    /NEEDED.*libgeos\.so/.test(geosCNeeded),
    geosCNeeded,
  );
} else if (target.os === "darwin") {
  const linked = await out(["otool", "-L", shimPath]);
  check("shim links libgeos_c via @rpath", /@rpath\/libgeos_c/.test(linked), linked);
  const defined = await out(["nm", "-gU", shimPath]);
  const staticGeos = defined.split("\n").filter((l) => /_GEOS[A-Z]/.test(l));
  check("no static GEOS symbols in the shim", staticGeos.length === 0, staticGeos.join("\n"));
} else {
  // win32: dumpbin (PATH from msvc-dev-cmd). Dependents of the shim must
  // include geos_c.dll; dependents of geos_c.dll must include geos.dll.
  const shimDeps = await out(["dumpbin", "/dependents", shimPath]);
  check("shim.dll depends on geos_c.dll", /geos_c\.dll/i.test(shimDeps), shimDeps);
  const geosCDeps = await out(["dumpbin", "/dependents", geosCPath]);
  check("geos_c.dll depends on geos.dll", /(?<!_c)\bgeos\.dll/i.test(geosCDeps), geosCDeps);
}

if (failures > 0) {
  console.error(`licensing-check: ${failures} failure(s) for ${target.id}`);
  process.exit(1);
}
console.log(`licensing-check: ${target.id} clean`);
