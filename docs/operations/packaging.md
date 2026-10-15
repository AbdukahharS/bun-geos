# Operations: packaging & release

> Status: design target (post-spike; install-mechanics findings in
> [spike results](../research/spike-results.md) F2/F9). Implements D6, D7, D8. Precedents: `sharp`/`@img/*`,
> `esbuild`/`@esbuild/*`, and — closest to our layout — `@swc/core` →
> `@swc/core-linux-x64-gnu`, `@parcel/watcher-*`, `@tailwindcss/oxide-*`.

## 1. The 8-package layout

npm names are exactly two segments (`@scope/name`) — there is no subpath publishing — so
platform binaries are **sibling packages in the same scope**:

```
@shzd/bun-geos                        ← the TS library (this repo's main package)
@shzd/bun-geos-darwin-arm64           ┐
@shzd/bun-geos-darwin-x64             │
@shzd/bun-geos-linux-arm64-gnu        │  one binary set each:
@shzd/bun-geos-linux-arm64-musl       │  shim + libgeos + libgeos_c + licenses
@shzd/bun-geos-linux-x64-gnu          │  (~4–8 MB installed; only ONE ever
@shzd/bun-geos-linux-x64-musl         │   reaches a user's disk)
@shzd/bun-geos-win32-x64              ┘
```

**Main package `package.json` (fragment):**

```jsonc
{
  "name": "@shzd/bun-geos",
  "optionalDependencies": {
    "@shzd/bun-geos-darwin-arm64":  "0.1.0",   // EXACT pins, never "^" — lockstep (D7)
    "@shzd/bun-geos-darwin-x64":    "0.1.0",
    "@shzd/bun-geos-linux-arm64-gnu":  "0.1.0",
    "@shzd/bun-geos-linux-arm64-musl": "0.1.0",
    "@shzd/bun-geos-linux-x64-gnu":    "0.1.0",
    "@shzd/bun-geos-linux-x64-musl":   "0.1.0",
    "@shzd/bun-geos-win32-x64":        "0.1.0"
  }
}
```

**Platform package `package.json` (fragment):**

```jsonc
{
  "name": "@shzd/bun-geos-linux-x64-gnu",
  "os": ["linux"],
  "cpu": ["x64"],
  "libc": ["glibc"],
  "files": ["shim.so", "libgeos.so", "libgeos_c.so", "LICENSE", "THIRD_PARTY.md"],
  "publishConfig": { "access": "public" }   // scoped = private-by-default; required on ALL 8
}
```

## 2. Install mechanics

When a macOS-arm64 user runs `bun add @shzd/bun-geos`, the installer evaluates each
optional dependency's `os`/`cpu`/`libc` fields against the machine and **silently skips**
the six that don't match. Only the matching package is ever downloaded.

**Known gotchas built into the plan:**

| Gotcha | Handling |
|--------|----------|
| Scoped packages are private-by-default | `publishConfig.access: "public"` in all 8 (free org accounts allow unlimited public packages) |
| `optionalDependencies` fail **silently** at install | Release pipeline publishes platforms → verifies each resolves on the registry → *then* publishes main |
| `libc` gating support varies by package manager/Bun version | **Phase 0 verified:** Bun 1.4.3 *ignores* `libc` (installs both `-gnu` and `-musl` on Linux; npm installs one). Keep the fields (npm benefits); loader self-selects at runtime via `glibcVersionRuntime`; wrong-libc `dlopen` failure still caught and rethrown with a clear "install/point at the right package" message |
| Version drift between main and binaries | One release script bumps all 8 in lockstep; exact pins |

## 3. Loader resolution (runtime)

```
BUN_GEOS_LIBRARY set?
  ├─ yes → dlopen(that path) → assert GEOS 3.14.x (D8; mismatch = hard error)
  └─ no  → resolve "@shzd/bun-geos-<platform>" relative to the main package
            (import.meta.resolve / createRequire) → dlopen its shim
              └─ shim is already linked against the sibling libgeos_c
                 → assert GEOS 3.14.x → install handlers → build symbol table
```

Failure modes produce actionable errors: missing platform package (silent-optional case),
wrong libc, version mismatch (the `--no-addons`/`--no-ffi-cc` flags are moot since the
cc() fallback path was dropped — never production-relevant).

## 4. CI build matrix

| Job | Runner | Produces |
|-----|--------|----------|
| darwin-arm64 | `macos-14` | shim.dylib, libgeos.dylib, libgeos_c.dylib |
| darwin-x64 | `macos-13` | same, x64 |
| linux-x64-gnu | `ubuntu-22.04` / `24.04` | shim.so, libgeos.so, libgeos_c.so |
| linux-arm64-gnu | `ubuntu-22.04-arm` (or cross via zig/cc) | same, arm64 |
| linux-x64-musl | `alpine` container | same, musl |
| linux-arm64-musl | alpine arm container / cross | same |
| win32-x64 | `windows-2022` (MSVC + CMake) | shim.dll, geos.dll, geos_c.dll |

Each job: fetch pinned GEOS 3.14.x source → CMake build (shared libs) → build shim against
it → strip → stage package with `LICENSE` + `THIRD_PARTY.md`
([licensing](licensing.md)) → `npm publish --access public`.

**A GEOS bump = re-run the pipeline = a `@shzd/bun-geos` release.** That is the entire
version story users ever see (D5).

## 5. Release pipeline (order matters)

1. Tag → CI matrix builds + smoke-tests each platform artifact (load it in Bun on the
   same runner, run the micro test suite natively).
2. Publish the 7 platform packages.
3. **Verify** each resolves on the registry (guarding the silent-optional failure mode).
4. Bump main package's `optionalDependencies` to the new exact versions; publish main.
5. GitHub release notes: GEOS version, Bun tested-range, changelog.

Tooling: a small release script (`Bun.$`) or changesets across all 8 manifests;
npm provenance/trusted publishing adopted when convenient (not load-bearing).

## 6. Consumption modes tested explicitly

| Mode | Status |
|------|--------|
| `bun add` normal install | primary, fully tested |
| `bun install --link` / workspaces | smoke-tested |
| `bun build --compile` embedding the `.so` | **tested in Phase 0 (Bun 1.4.3): works** — embedded `.so` dlopens via `$bunfs`, ~0.1 ms load, runs from any cwd; but leaks one `.bun-<uid>-<hash>.so` in `$TMPDIR` per run ([#40076](https://github.com/oven-sh/bun/issues/40076) live; [#44238](https://github.com/oven-sh/bun/issues/44238) not observed). Only affects user-compiled apps; document status per Bun version, never silently broken |
| `BUN_GEOS_LIBRARY` override | tested against a mismatched-version lib (must hard-fail) |
| Node.js | unsupported (D1); docs point out that the shim+libgeos are plain dynamic libraries, so a Node port is *possible later* but is not a goal |
