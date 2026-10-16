/**
 * Build the C shim for a target, then stage the flat artifact layout the
 * platform package ships (shim + libgeos + libgeos_c as siblings —
 * packaging.md §1). Flat staging is part of the build because the rpath /
 * install-name story only works when the three binaries sit together, and
 * proving it here means the packaging scripts copy — never rearrange.
 *
 * Linux:  gcc, DT_RPATH $ORIGIN via --disable-new-dtags (F3).
 * Darwin: clang, LC_RPATH @loader_path.
 * Win32:  cl /LD + /DEF:native/shim.def (LoadLibrary needs real exports);
 *         no rpath — the loader preloads geos.dll first (src/loader.ts).
 */

import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
  BUILD_NATIVE,
  ensureDir,
  exists,
  GEOS_INSTALL,
  geosLibDir,
  geosRuntimeDir,
  NATIVE_DIR,
  toolchainFor,
} from "./lib.ts";
import { type Target, targetById } from "./targets.ts";

/**
 * libgeos_c candidates in the install tree, per OS. The first match is
 * copied+renamed to the package's `geosCFile` (safe: the copy's filename
 * equals its SONAME / install name, which is what dependents record).
 */
function geosCBuiltNames(os: Target["os"]): string[] {
  switch (os) {
    case "darwin":
      return ["libgeos_c.1.dylib", "libgeos_c.dylib"];
    case "win32":
      return ["geos_c.dll"];
    default:
      return ["libgeos_c.so.1.20.5", "libgeos_c.so.1"];
  }
}

/** Compile the shim against the staged GEOS install for this target. */
async function compileShim(target: Target): Promise<void> {
  const tc = toolchainFor(target);
  const shimOut = join(BUILD_NATIVE, target.shimFile);
  ensureDir(BUILD_NATIVE);

  if (tc.shim.msvc) {
    // Import lib from the GEOS install (lib/geos_c.lib); /DEF: exports the
    // geos_shim_* surface (LoadLibrary/GetProcAddress see nothing else).
    await $`cl ${tc.shim.sharedFlags} ${NATIVE_DIR}/shim.c /Fe:${shimOut} /link ${tc.shim.linkFlags} /LIBPATH:${join(GEOS_INSTALL, "lib")} geos_c.lib`;
    return;
  }

  // One interpolated arg (Bun's shell escapes interpolated values; splitting
  // "‑Wl,-rpath," and "$ORIGIN" into two argv entries breaks the linker).
  const rpath = tc.shim.rpath ? [`-Wl,-rpath,${tc.shim.rpath}`] : [];
  await $`${tc.shim.compiler} ${tc.shim.sharedFlags} ${NATIVE_DIR}/shim.c -o ${shimOut} -L${geosLibDir()} -lgeos_c ${tc.shim.linkFlags} ${rpath}`;
  console.log(`shim: built ${shimOut}`);
}

export interface StagedShim {
  shimPath: string;
  geosCPath: string;
  geosPath: string;
}

/**
 * Build the shim for a target and stage the three artifacts flat in
 * build/native/ (host layout used by dev + tests + packaging).
 */
export async function buildAndStageShim(target: Target): Promise<StagedShim> {
  // .def sync is checked on every platform so drift never reaches the
  // Windows job (native/shim.def).
  await $`bun run scripts/native/def.ts`;
  await compileShim(target);

  // libgeos_c → the package filename (copy+rename; SONAME matches). The
  // RUNTIME dir differs on Windows: DLLs live in bin/, import libs in lib/.
  const runtimeDir = geosRuntimeDir(target.os);
  const builtC = geosCBuiltNames(target.os)
    .map((n) => join(runtimeDir, n))
    .find((p) => exists(p));
  if (!builtC) {
    throw new Error(
      `shim: no libgeos_c in ${runtimeDir} — looked for ${geosCBuiltNames(target.os).join(", ")}`,
    );
  }
  const geosCPath = join(BUILD_NATIVE, target.geosCFile);
  copyFileSync(builtC, geosCPath);

  // libgeos (the transitive dependency): discover the real file — its name
  // differs per platform (libgeos.so.3.14.1 / libgeos.3.14.1.dylib / geos.dll).
  const geosName = readdirSync(runtimeDir).find((n) => target.geosFileGlob.test(n));
  if (!geosName) {
    throw new Error(`shim: no libgeos matching ${target.geosFileGlob} in ${runtimeDir}`);
  }
  const geosPath = join(BUILD_NATIVE, geosName);
  copyFileSync(join(runtimeDir, geosName), geosPath);

  console.log(`shim: staged ${target.shimFile} + ${target.geosCFile} + ${geosName}`);
  return { shimPath: join(BUILD_NATIVE, target.shimFile), geosCPath, geosPath };
}

/** Dev convenience: build for the host target only (used by build-native.ts). */
export async function buildShimHost(hostTargetId: string): Promise<StagedShim> {
  const target = targetById(hostTargetId);
  if (!target) throw new Error(`unknown target ${hostTargetId}`);
  return buildAndStageShim(target);
}
