/**
 * Build GEOS (pinned tarball → CMake shared libs → install tree) for a
 * target. Per-target facts come from lib.ts's toolchain table:
 *
 * - linux:  gcc/g++ + Ninja, RPATH $ORIGIN (F3-proven set)
 * - darwin: clang + Ninja, RPATH @loader_path (Mach-O's $ORIGIN)
 * - win32:  cl.exe (vcvars), default VS generator, no rpath concept — the
 *           loader preloads geos.dll before geos_c.dll (src/loader.ts)
 *
 * The install tree lands in build/native/geos-install (CI-cached). The
 * shim's per-target build is shim.ts.
 */

import { join } from "node:path";
import { $ } from "bun";
import {
  BUILD_NATIVE,
  exists,
  extractGeosSource,
  GEOS_INSTALL,
  GEOS_TAG,
  toolchainFor,
} from "./lib.ts";
import type { Target } from "./targets.ts";

/** CMake build dir for a target (host builds reuse build/native/geos). */
function geosBuildDir(): string {
  return join(BUILD_NATIVE, "geos");
}

/**
 * Build + install GEOS for the target. Idempotent: skips when the install
 * tree is present (delete build/native/geos-install to force).
 */
export async function buildGeos(target: Target): Promise<void> {
  const marker =
    target.os === "linux"
      ? join(GEOS_INSTALL, "lib", "libgeos_c.so.1.20.5")
      : target.os === "darwin"
        ? join(GEOS_INSTALL, "lib", "libgeos_c.1.dylib")
        : join(GEOS_INSTALL, "bin", "geos_c.dll");
  if (exists(marker)) {
    console.log(`geos: GEOS ${GEOS_TAG} install tree present, skipping`);
    return;
  }

  const src = await extractGeosSource();
  const buildDir = geosBuildDir();
  const tc = toolchainFor(target);

  console.log(`geos: configuring GEOS ${GEOS_TAG} for ${target.id}`);
  const rpathFlag = tc.installRpath
    ? [`-DCMAKE_INSTALL_RPATH=${tc.installRpath}`, "-DCMAKE_INSTALL_RPATH_USE_LINK_PATH=FALSE"]
    : ["-DCMAKE_INSTALL_RPATH="];
  // Bun's shell interpolates arrays as one-argument-per-element.
  await $`cmake -S ${src} -B ${buildDir} ${tc.generator ?? []} -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON -DCMAKE_INSTALL_PREFIX=${GEOS_INSTALL} ${rpathFlag}`.env(
    tc.env,
  );

  console.log(`geos: compiling (${target.id})`);
  const jobs = navigator.hardwareConcurrency || 4;
  if (target.os === "win32") {
    // Multi-config generator: build the Release configuration explicitly.
    await $`cmake --build ${buildDir} --config Release --parallel ${jobs}`;
  } else {
    await $`cmake --build ${buildDir} --parallel ${jobs}`;
  }
  if (target.os === "win32") {
    await $`cmake --install ${buildDir} --config Release`;
  } else {
    await $`cmake --install ${buildDir}`;
  }
  console.log(`geos: installed → ${GEOS_INSTALL}`);
}
