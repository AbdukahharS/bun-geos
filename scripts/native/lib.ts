/**
 * Shared constants + helpers for the native build, packaging, and release
 * scripts (Phase 4). The dev build, the CI matrix, and staging all consume
 * this module so there is exactly one place where the GEOS source pin and
 * the repo paths live.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import type { Target } from "./targets.ts";

// ── Repo layout ─────────────────────────────────────────────────────────

export const ROOT = join(import.meta.dir, "..", "..");
export const NATIVE_DIR = join(ROOT, "native"); // shim.c, shim.def
export const BUILD = join(ROOT, "build");
export const BUILD_NATIVE = join(BUILD, "native"); // staged flat artifacts
export const GEOS_TARBALL = join(BUILD, "geos-tarball.tar.bz2");
export const GEOS_SRC_DIR = join(BUILD, "geos-src"); // extracted source
export const GEOS_INSTALL = join(BUILD_NATIVE, "geos-install");

// ── GEOS source pin (licensing.md §2: official unmodified tag, hashed) ──
//
// The SHA-256 is of the official GitHub release artifact — CI records it in
// every platform package's THIRD_PARTY.md. A GEOS bump = new tag + new hash
// + re-run of the pipeline = a @shzd/bun-geos release (D5/D6).

export const GEOS_TAG = "3.14.1";
export const GEOS_TARBALL_URL = `https://github.com/libgeos/geos/releases/download/${GEOS_TAG}/geos-${GEOS_TAG}.tar.bz2`;
export const GEOS_TARBALL_SHA256 =
  "3c20919cda9a505db07b5216baa980bacdaa0702da715b43f176fb07eff7e716";

// ── Helpers ──────────────────────────────────────────────────────────────

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/** SHA-256 of a file, streamed (flat RSS on any runner). */
export async function sha256File(path: string): Promise<string> {
  const hasher = createHash("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) hasher.update(chunk);
  return hasher.digest("hex");
}

/**
 * Fetch the pinned GEOS tarball (cached under build/) and verify its
 * SHA-256. Throws on any mismatch — licensing.md's "official unmodified
 * tag" is enforced here, not hoped for.
 */
export async function fetchGeosTarball(): Promise<string> {
  ensureDir(BUILD);
  if (!exists(GEOS_TARBALL)) {
    console.log(`native: fetching GEOS ${GEOS_TAG} release tarball`);
    await $`curl -sL --fail -o ${GEOS_TARBALL} ${GEOS_TARBALL_URL}`;
  }
  const actual = await sha256File(GEOS_TARBALL);
  if (actual !== GEOS_TARBALL_SHA256) {
    throw new Error(
      `native: GEOS tarball SHA-256 mismatch\n` +
        `  expected ${GEOS_TARBALL_SHA256}\n` +
        `  actual   ${actual}\n` +
        `  delete ${GEOS_TARBALL} and retry; if the mismatch persists the upstream artifact changed — STOP`,
    );
  }
  return GEOS_TARBALL;
}

/** Extract the pinned tarball into build/geos-src/ (idempotent). */
export async function extractGeosSource(): Promise<string> {
  const tarball = await fetchGeosTarball();
  const marker = join(GEOS_SRC_DIR, `.extracted-${GEOS_TARBALL_SHA256.slice(0, 12)}`);
  if (!exists(marker)) {
    if (exists(GEOS_SRC_DIR)) await $`rm -rf ${GEOS_SRC_DIR}`;
    ensureDir(GEOS_SRC_DIR);
    await $`tar -xjf ${tarball} -C ${GEOS_SRC_DIR}`;
    const entries = readdirSync(GEOS_SRC_DIR);
    const top = entries.find((e) => e.startsWith(`geos-${GEOS_TAG}`));
    if (!top) {
      throw new Error(
        `native: unexpected tarball layout — no geos-${GEOS_TAG}/ in ${GEOS_SRC_DIR}`,
      );
    }
    // Flatten: the source root IS GEOS_SRC_DIR (stable path for cmake -S).
    const inner = join(GEOS_SRC_DIR, top);
    const tmp = `${GEOS_SRC_DIR}.__move`;
    await $`mv ${inner} ${tmp}`;
    await $`rm -rf ${GEOS_SRC_DIR}`;
    await $`mv ${tmp} ${GEOS_SRC_DIR}`;
    writeFileSync(marker, GEOS_TARBALL_SHA256);
  }
  return GEOS_SRC_DIR;
}

// ── Per-target native toolchain facts ────────────────────────────────────

export interface Toolchain {
  /** CMake generator argument, if any. */
  generator?: string[];
  /**
   * CMake -D compiler flags. Passed as ARGUMENTS, never as CC/CXX
   * environment variables: Bun Shell's `.env()` REPLACES the child
   * environment (PATH included — verified on Bun 1.4.3), which leaves
   * cmake unable to find ninja or any compiler. win32 passes none: cl.exe
   * comes from the vcvars PATH with the default VS generator.
   */
  compilerFlags: string[];
  /** CMAKE_INSTALL_RPATH value for the install tree ('' = none). */
  installRpath: string;
  /** Shim compile+link command. */
  shim: {
    compiler: string;
    sharedFlags: string[];
    /** Extra link flags (e.g. --disable-new-dtags → DT_RPATH, F3). */
    linkFlags: string[];
    rpath: string;
    /** MSVC-style flag syntax? (cl uses /FLAGS and /DEF: files) */
    msvc: boolean;
  };
}

export function toolchainFor(target: Target): Toolchain {
  switch (target.os) {
    case "linux":
      return {
        generator: ["-G", "Ninja"],
        compilerFlags: ["-DCMAKE_C_COMPILER=gcc", "-DCMAKE_CXX_COMPILER=g++"],
        installRpath: "$ORIGIN",
        shim: {
          compiler: "gcc",
          sharedFlags: ["-O2", "-fPIC", "-shared", "-Wall", "-Wextra"],
          // DT_RPATH (not RUNPATH) is consulted transitively — the shim's
          // rpath resolves libgeos through libgeos_c's own dependency (F3).
          linkFlags: ["-Wl,--disable-new-dtags"],
          rpath: "$ORIGIN",
          msvc: false,
        },
      };
    case "darwin":
      return {
        generator: ["-G", "Ninja"],
        compilerFlags: ["-DCMAKE_C_COMPILER=clang", "-DCMAKE_CXX_COMPILER=clang++"],
        // ELF's $ORIGIN is Mach-O's @loader_path; LC_RPATH — like DT_RPATH —
        // is consulted for the whole transitive chain.
        installRpath: "@loader_path",
        shim: {
          compiler: "clang",
          sharedFlags: ["-O2", "-fPIC", "-shared", "-Wall", "-Wextra"],
          linkFlags: [],
          rpath: "@loader_path",
          msvc: false,
        },
      };
    case "win32":
      // cl.exe from vcvars; default (Visual Studio) generator — no Ninja
      // dependency; no rpath concept (the loader preloads geos.dll first,
      // src/loader.ts).
      return {
        compilerFlags: [],
        installRpath: "",
        shim: {
          compiler: "cl",
          sharedFlags: ["/nologo", "/O2", "/W4", "/LD"],
          linkFlags: ["/DEF:native/shim.def"],
          rpath: "",
          msvc: true,
        },
      };
  }
}

/** Directory containing built GEOS libraries for a target's staging tree. */
export function geosLibDir(): string {
  return join(GEOS_INSTALL, "lib");
}
