/**
 * Dev/native build: GEOS 3.14.1 + the C shim into build/native/.
 *
 * This is the `bun run build:native` entrypoint (shim.md §4 "system compiler,
 * dev only" path — the cc()/TinyCC fallback is dropped, spike-results F7).
 * Production artifacts are CI-prebuilt per platform (Phase 4); this script
 * exists so development and CI (single ubuntu job) never need them.
 *
 * Flags are the spike-proven ones (spike-results F3):
 * - GEOS install tree bakes `-DCMAKE_INSTALL_RPATH='$ORIGIN'` so the libs
 *   resolve each other from wherever the tree is copied;
 * - the shim links with `--disable-new-dtags` → DT_RPATH, which — unlike
 *   RUNPATH — the loader consults transitively, resolving libgeos through
 *   libgeos_c's own dependency.
 *
 * Idempotent: skips the GEOS build when the install tree is already present
 * (delete build/native/geos-install to force a rebuild).
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const ROOT = join(import.meta.dir, "..");
const BUILD = join(ROOT, "build", "native");
const GEOS_SOURCE = join(ROOT, "vendor", "geos");
const GEOS_INSTALL = join(BUILD, "geos-install");
const SHIM_SOURCE = join(ROOT, "native", "shim.c");
const SHIM_OUT = join(BUILD, "shim.so");

const GEOS_TAG = "3.14.1";
const CC = process.env.CC ?? "gcc";
const CXX = process.env.CXX ?? "g++";
/* Passed as interpolated JS values, never as shell literals: Bun's shell
 * would treat a literal $ORIGIN as a variable substitution. */
const RPATH_ORIGIN = "$ORIGIN";

async function buildGeos(): Promise<void> {
  if (existsSync(join(GEOS_INSTALL, "lib", "libgeos_c.so.1"))) {
    console.log(`build:native: GEOS ${GEOS_TAG} install tree present, skipping`);
    return;
  }
  if (!existsSync(join(GEOS_SOURCE, "CMakeLists.txt"))) {
    console.log(`build:native: fetching GEOS ${GEOS_TAG} (shallow, pinned tag)`);
    await $`git clone --depth 1 --branch ${GEOS_TAG} https://github.com/libgeos/geos.git ${GEOS_SOURCE}`;
  }
  mkdirSync(BUILD, { recursive: true });
  await $`cmake -S ${GEOS_SOURCE} -B ${BUILD}/geos -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DCMAKE_C_COMPILER=${CC} -DCMAKE_CXX_COMPILER=${CXX} -DCMAKE_INSTALL_PREFIX=${GEOS_INSTALL} -DCMAKE_INSTALL_RPATH=${RPATH_ORIGIN} -DCMAKE_INSTALL_RPATH_USE_LINK_PATH=FALSE`;
  await $`ninja -C ${BUILD}/geos -j ${navigator.hardwareConcurrency || 4}`;
  await $`ninja -C ${BUILD}/geos install`;
}

async function buildShim(): Promise<void> {
  // Stage the three artifacts flat — the exact Phase 4 platform-package
  // layout (packaging.md §1): shim + libgeos + libgeos_c as siblings, shim
  // resolving libgeos_c via DT_RPATH $ORIGIN (F3).
  const libDir = join(GEOS_INSTALL, "lib");
  for (const name of ["libgeos_c.so.1", "libgeos.so.3.14.1"]) {
    const src = join(libDir, name);
    const dst = join(BUILD, name);
    if (!existsSync(src)) throw new Error(`build:native: expected ${src}`);
    if (!existsSync(dst)) await $`ln -s ${src} ${dst}`;
  }
  await $`gcc -O2 -fPIC -shared -Wall -Wextra ${SHIM_SOURCE} -o ${SHIM_OUT} -L${libDir} -lgeos_c -Wl,--disable-new-dtags -Wl,-rpath,${RPATH_ORIGIN}`;
  // The spike's FFI value-roundtrip table also runs against this tree
  // (spike/ has a fallback to build/native so CI needs only one build).
  await $`gcc -O2 -fPIC -shared -Wall -Wextra ${join(ROOT, "spike", "values.c")} -o ${join(BUILD, "values.so")}`;
}

await buildGeos();
await buildShim();
console.log(`build:native: done — ${SHIM_OUT}`);
