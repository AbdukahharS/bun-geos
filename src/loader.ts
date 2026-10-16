/**
 * Loader (architecture.md §2, packaging.md §3): resolve the native
 * libraries, dlopen them, assert GEOS 3.14 (D5/D8).
 *
 * Resolution order:
 *   1. `BUN_GEOS_LIBRARY` (D8 escape hatch) — dlopened by absolute path
 *      FIRST so the shim's NEEDED soname resolves against the mapped lib
 *      (spike-results F3); the shim itself still comes from the resolved
 *      platform package (or the dev tree).
 *   2. Platform package `@shzd/bun-geos-<os>-<arch>[-gnu|musl]`, libc
 *      self-selected at runtime (Bun's installer ignores the `libc` field —
 *      spike-results F2).
 *   3. Dev fallback: the repo's `build/native/` tree from
 *      `bun run build:native` (shim.md §4 dev path; cc() is dropped, F7).
 *
 * `dlopen` throws `TypeError` when the JIT is disabled (Bun 1.4+) — that is
 * surfaced as an actionable LoaderError; there is no JIT-less fallback (D1).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LoaderError } from "./errors.ts";
import { type Native, openNative } from "./symbols.ts";

export interface LoadOptions {
  /** Overrides the packaged GEOS (`BUN_GEOS_LIBRARY`). Must be GEOS 3.14.x. */
  library?: string;
}

export interface Library {
  readonly native: Native;
  /** `"3.14.1-CAPI-1.18.2"` style string from the loaded binary. */
  readonly version: string;
}

/** Platform suffix for the shim binary name. */
function shimSuffix(): string {
  switch (process.platform) {
    case "darwin":
      return "dylib";
    case "win32":
      return "dll";
    default:
      return "so";
  }
}

/** Sibling platform-package name (D7) — e.g. `@shzd/bun-geos-linux-x64-gnu`. */
function platformPackageName(): string {
  const { platform, arch } = process;
  let libc = "";
  if (platform === "linux") {
    // Bun's installer ignores the `libc` field (F2): both variants install;
    // detect glibc at runtime and pick the matching one.
    const report = (
      process as unknown as {
        report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } };
      }
    ).report;
    const glibc = report?.getReport?.().header?.glibcVersionRuntime;
    libc = glibc ? "-gnu" : "-musl";
  }
  return `@shzd/bun-geos-${platform}-${arch}${libc}`;
}

/** libgeos_c file name candidates, best first. */
function geosCLibraryNames(): string[] {
  switch (process.platform) {
    case "darwin":
      return ["libgeos_c.1.dylib", "libgeos_c.dylib"];
    case "win32":
      return ["geos_c.dll"];
    default:
      return ["libgeos_c.so.1", "libgeos_c.so"];
  }
}

/** Resolve the platform package dir, or null when it is not installed. */
function platformPackageDir(): string | null {
  const pkg = platformPackageName();
  try {
    // Phase 4 layout: binaries at the platform package root.
    const resolved = import.meta.resolve(`${pkg}/package.json`);
    return dirname(fileURLToPath(resolved));
  } catch {
    return null;
  }
}

/** Dev fallback: the repo-local build tree (build/native/). */
function devTreeDir(): string | null {
  // src/loader.ts → repo root is one level up.
  const dir = join(import.meta.dir, "..", "build", "native");
  return existsSync(join(dir, `shim.${shimSuffix()}`)) ? dir : null;
}

function resolveDirs(opts: LoadOptions | undefined): {
  shimDir: string;
  geosCPath: string | undefined;
} {
  const override = opts?.library ?? process.env.BUN_GEOS_LIBRARY;
  const fromPkg = platformPackageDir();
  const shimDir = fromPkg ?? devTreeDir();
  if (!shimDir) {
    throw new LoaderError(
      `bun-geos: no native libraries found.\n` +
        `  looked for platform package "${platformPackageName()}" (not installed)\n` +
        `  and for the dev tree build/native/ (not built)\n` +
        `  → run \`bun run build:native\` in a checkout, or reinstall the package`,
    );
  }
  return { shimDir, geosCPath: override };
}

export interface OpenResult {
  native: Native;
  version: string;
}

let opened: OpenResult | null = null;
let openedOverride: string | undefined;

/**
 * dlopen the libraries (once per process; subsequent calls return the same
 * handle set) and assert the loaded GEOS is 3.14.x (D5). The assertion also
 * covers `BUN_GEOS_LIBRARY` overrides (D8) — a mismatch is a hard error.
 */
export function openLibrary(opts?: LoadOptions): OpenResult {
  const override = opts?.library ?? process.env.BUN_GEOS_LIBRARY;
  if (opened) {
    // One GEOS per process (audit N2): a silently-ignored different override
    // would be split-brain; fail loudly instead.
    if (override !== openedOverride) {
      throw new LoaderError(
        "bun-geos: native libraries are already loaded with a different BUN_GEOS_LIBRARY — " +
          "one GEOS instance per process; create all Geos contexts with the same setting",
      );
    }
    return opened;
  }

  const { shimDir, geosCPath } = resolveDirs(opts);
  const shimPath = join(shimDir, `shim.${shimSuffix()}`);
  if (!existsSync(shimPath)) {
    throw new LoaderError(`bun-geos: shim not found at ${shimPath}`);
  }

  // Override (or explicit) libgeos_c is dlopened FIRST so that the shim's
  // NEEDED soname resolves against the already-mapped library (F3).
  let geosCPathResolved: string | undefined = geosCPath;
  if (geosCPathResolved && !existsSync(geosCPathResolved)) {
    throw new LoaderError(
      `bun-geos: BUN_GEOS_LIBRARY points at a missing file: ${geosCPathResolved}`,
    );
  }
  if (!geosCPathResolved) {
    for (const name of geosCLibraryNames()) {
      const candidate = join(shimDir, name);
      if (existsSync(candidate)) {
        geosCPathResolved = candidate;
        break;
      }
    }
  }
  if (!geosCPathResolved) {
    throw new LoaderError(
      `bun-geos: libgeos_c not found next to the shim in ${shimDir} — the package is incomplete`,
    );
  }

  // dlopen throws TypeError when the JIT is disabled (Bun 1.4+) — rethrow
  // with the remediation. There is no JIT-less mode (D1).
  let native: Native;
  try {
    native = openNative(shimPath, geosCPathResolved);
  } catch (err) {
    if (err instanceof TypeError) {
      throw new LoaderError(
        `bun-geos: bun:ffi is unavailable (JIT disabled?). bun-geos requires the JIT — ` +
          `remove --no-transpile-snapshot / smol flags. No WASM fallback exists (by design).`,
      );
    }
    if (err instanceof Error && /could not be opened|dlopen|symbol not found/i.test(err.message)) {
      throw new LoaderError(
        `bun-geos: failed to load the native libraries (${err.message}).\n` +
          `  If you are on Linux/glibc vs musl, the wrong libc variant may have loaded — ` +
          `set BUN_GEOS_LIBRARY to a GEOS 3.14 libgeos_c to debug.`,
      );
    }
    throw err;
  }

  const version = native.geos.GEOSversion();
  if (!version || !/^3\.14\./.test(version)) {
    throw new LoaderError(
      `bun-geos requires GEOS 3.14.x (strict, no capability flags — D5); ` +
        `loaded library reports "${version ?? "<null>"}".\n` +
        `  Using BUN_GEOS_LIBRARY? Point it at a GEOS 3.14 build of libgeos_c.`,
    );
  }

  opened = { native, version };
  openedOverride = override;
  return opened;
}

/** Test hook: drop the process-wide cache (mainly for BUN_GEOS_LIBRARY tests). */
export function resetLibraryCache(): void {
  opened = null;
}
