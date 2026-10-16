/**
 * The 7 release targets (D7) + the host target for dev builds.
 *
 * Each target defines: the npm platform-package name, the artifact filenames
 * the loader expects at the package root (src/loader.ts), and the native
 * toolchain flags for GEOS + shim. This table is the single source shared by
 * the dev build (`bun run build:native`), the CI matrix, and the packaging
 * scripts — per-target knowledge lives HERE and nowhere else (the Phase-4
 * runbook points back at this file).
 */

export type TargetOs = "darwin" | "linux" | "win32";
export type TargetArch = "arm64" | "x64";

export interface Target {
  /** npm package suffix: `@shzd/bun-geos-<id>` (D7). */
  readonly id:
    | "darwin-arm64"
    | "darwin-x64"
    | "linux-arm64-gnu"
    | "linux-arm64-musl"
    | "linux-x64-gnu"
    | "linux-x64-musl"
    | "win32-x64";
  readonly os: TargetOs;
  readonly arch: TargetArch;
  /** Linux only: Bun's installer ignores `libc` (F2) but npm uses it. */
  readonly libc?: "gnu" | "musl";
  /** Shim binary filename at the package root. */
  readonly shimFile: "shim.so" | "shim.dylib" | "shim.dll";
  /**
   * libgeos_c candidates, best first — must agree with src/loader.ts's
   * `geosCLibraryNames()`.
   */
  readonly geosCFile: string;
  /**
   * libgeos file(s) to ship (the shim's libgeos_c NEEDs it transitively).
   * The exact filename is discovered at staging time from the built tree
   * (sonames differ per platform); this is a glob-style hint.
   */
  readonly geosFileGlob: RegExp;
}

export const TARGETS: readonly Target[] = [
  {
    id: "darwin-arm64",
    os: "darwin",
    arch: "arm64",
    shimFile: "shim.dylib",
    geosCFile: "libgeos_c.1.dylib",
    geosFileGlob: /^libgeos(\.[0-9.]+)?\.dylib$/,
  },
  {
    id: "darwin-x64",
    os: "darwin",
    arch: "x64",
    shimFile: "shim.dylib",
    geosCFile: "libgeos_c.1.dylib",
    geosFileGlob: /^libgeos(\.[0-9.]+)?\.dylib$/,
  },
  {
    id: "linux-arm64-gnu",
    os: "linux",
    arch: "arm64",
    libc: "gnu",
    shimFile: "shim.so",
    geosCFile: "libgeos_c.so.1",
    geosFileGlob: /^libgeos\.so\.[0-9.]+$/,
  },
  {
    id: "linux-arm64-musl",
    os: "linux",
    arch: "arm64",
    libc: "musl",
    shimFile: "shim.so",
    geosCFile: "libgeos_c.so.1",
    geosFileGlob: /^libgeos\.so\.[0-9.]+$/,
  },
  {
    id: "linux-x64-gnu",
    os: "linux",
    arch: "x64",
    libc: "gnu",
    shimFile: "shim.so",
    geosCFile: "libgeos_c.so.1",
    geosFileGlob: /^libgeos\.so\.[0-9.]+$/,
  },
  {
    id: "linux-x64-musl",
    os: "linux",
    arch: "x64",
    libc: "musl",
    shimFile: "shim.so",
    geosCFile: "libgeos_c.so.1",
    geosFileGlob: /^libgeos\.so\.[0-9.]+$/,
  },
  {
    id: "win32-x64",
    os: "win32",
    arch: "x64",
    shimFile: "shim.dll",
    geosCFile: "geos_c.dll",
    geosFileGlob: /^geos\.dll$/,
  },
];

export function targetById(id: string): Target | undefined {
  return TARGETS.find((t) => t.id === id);
}

/** The machine we're running on right now (dev builds / local staging). */
export function hostTarget(): Target {
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) throw new Error(`hostTarget: unsupported arch ${process.arch}`);
  let libc: "gnu" | "musl" | undefined;
  if (process.platform === "linux") {
    const report = (
      process as unknown as {
        report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } };
      }
    ).report;
    libc = report?.getReport?.().header?.glibcVersionRuntime ? "gnu" : "musl";
  }
  const id = `${process.platform}-${arch}${libc ? `-${libc}` : ""}`;
  const target = targetById(id);
  if (!target) {
    throw new Error(
      `hostTarget: no release target matches this machine (${id}). ` +
        `Supported: ${TARGETS.map((t) => t.id).join(", ")}`,
    );
  }
  return target;
}
