# Operations: packaging & release

> Status: **IMPLEMENTED (Phase 4)** — the 8-package layout, the CI matrix
> (`.github/workflows/release.yml`), the release tooling
> (`scripts/release.ts`, `scripts/release-dry-run.ts`), and the install
> matrix (`.github/workflows/install-matrix.yml`) are in the repo. The
> first real publish (0.0.1) is the remaining step; exit evidence lands in
> the [ROADMAP](../ROADMAP.md) when the install matrix runs clean.
> Implements D6, D7, D8, D26. Precedents: `sharp`/`@img/*`,
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

## 7. Release runbook (decisions.md open item #2 — the per-platform story)

The authoritative per-target facts live in **`scripts/native/targets.ts` + `lib.ts`** (the
toolchain table shared by dev, CI, and packaging). This section is the human runbook: what to
touch, what to verify, and the known traps.

### 7.1 One-time npm setup

1. `@shzd` org exists. Create a **granular access token**: Read & write, scoped to the org's
   packages, shortest practical expiry. Record the type + expiry date HERE:
   ______ (fill in on creation). **Measured 2026-10-16:** publishing with a granular token
   against a 2FA-enforced account/org fails with `EOTP` — granular tokens do NOT bypass
   2FA-enforced publishing; the classic **Automation** token type does (it exists for CI).
   Use whichever the org's policy permits and record the choice here: ______.
2. GitHub → repo → **Environments → `release`**: add secret `NPM_TOKEN`; restrict deployments
   to `.github/workflows/release.yml` (tag builds only). Optional: required reviewers.
3. Local release from a checkout: `export NPM_TOKEN=npm_…` then tag `v<version>` (CI) or
   `bun run release` after staging locally.

Token rotation: before expiry, create the successor, swap the secret, revoke the old token,
update the recorded date. Break-glass: none needed beyond a fresh token — publish paths are
idempotent.

### 7.2 GEOS bump procedure (= a release, D5)

1. New tag + SHA-256 in `scripts/native/lib.ts` (`GEOS_TAG`, `GEOS_TARBALL_URL`,
   `GEOS_TARBALL_SHA256` — hash of the official release tarball).
2. The shim compiles against the pinned C API; if `native/shim.c` needs changes for the new
   GEOS, that's a code change + review as usual (the C API is ABI-stable, D2).
3. Clear caches implicitly: the cache keys hash `lib.ts`, so bumping the tag/ hash re-builds.
4. Release as usual; `CHANGELOG.md` gets the new GEOS version noted.

### 7.3 Per-target notes (the traps)

| Target | Notes |
|--------|-------|
| linux-*-gnu | gcc + Ninja; shim links `--disable-new-dtags` → DT_RPATH (transitively resolves libgeos through libgeos_c, spike F3); GEOS install tree bakes `$ORIGIN`. |
| linux-*-musl | Built INSIDE `docker run alpine:3.20` from the ubuntu runner (musl arm64 = container on the arm runner). NOT `container:` jobs — GitHub's JS-action runtime is glibc node and cannot execute in a musl container (the checkout step itself would fail). Bun installs inside the container via the official script. |
| darwin-* | clang; `$ORIGIN` is ELF-only — everything is `@loader_path` (`CMAKE_INSTALL_RPATH` + shim `-rpath`). Verify with `otool -L` (licensing-check does). `macos-13` (x64) retirement watch: fallback = cross-compile `CMAKE_OSX_ARCHITECTURES=x86_64` on macos-14 + Rosetta smoke — not implemented, revisit when GitHub dates it. |
| win32-x64 | cl.exe via `ilammy/msvc-dev-cmd` (also for CMake; default VS generator, no Ninja dependency). No rpath concept: **the loader preloads `geos.dll` → `geos_c.dll` → shim.dll by absolute path** — the Windows DLL search path excludes a loaded DLL's own directory (src/loader.ts). Exports: `native/shim.def` (MSVC exports nothing by default; LoadLibrary+GetProcAddress see only listed symbols). TLS: `__declspec(thread)` via `SHIM_TLS`; atomics: pre-C11 volatile fallback forced on `_MSC_VER` (its `<stdatomic.h>` is incomplete). First real Windows `bun:ffi` evidence = the platform smoke's FFI section on this job. |

Stripping: `strip --strip-unneeded` (linux) / `strip -x` (darwin) — applied where? Not yet
wired (artifacts are Release builds; the shim is 41 KB, GEOS ~5 MB). If package size ever
matters, add strip to `scripts/native/shim.ts` per-target — deliberately deferred.

### 7.4 Release-day checklist

1. Repo `package.json` version = the release version; `CHANGELOG.md` has a `## <version>`
   section (release notes come from it).
2. Tag `v<version>` → `release.yml` builds 7 targets (parallel), smokes + license-checks each
   staged package on its own runner, uploads artifacts.
3. `publish` job: downloads all 7 → `package-main.ts` (exact pins) → `release.ts`:
   platforms → registry-resolution verify (retry/backoff; STOP before main on failure — the
   silent-optional guard) → main → GitHub release notes.
4. `install-matrix.yml` runs (auto after release, or dispatch with the version): the < 60 s
   gate across macOS/Ubuntu/Alpine/Windows × bun/npm/pnpm + consumption-mode probes
   (`BUN_GEOS_LIBRARY` mismatch hard-fail; `bun build --compile` embedding).
5. Record evidence in the ROADMAP Phase-4 status block.

Local rehearsal without burning versions: `bun run release:dry-run` (verdaccio in Docker:
publish → resolve → clean `bun add` → overlay). Requires only Docker.

### 7.5 Auth: trusted publishing (OIDC) since 0.0.2; token was the bootstrap

**0.0.1 bootstrap (2026-10-16):** granular token → `EOTP` — granular tokens do not bypass
2FA-enforced publishing, and npm is deprecating 2FA-bypassing tokens outright
(gh.io/npm-gat-bypass2fa-deprecation). The first release was therefore published
**interactively from a maintainer checkout** (`npm publish` per staged dir; the CLI's
browser-auth flow handles 2FA) — which created the 8 packages, the prerequisite for trusted
publishers.

**Steady state (0.0.2+): npm trusted publishing.** Each package's settings on npmjs.com
carry a trusted publisher: GitHub Actions → org/repo → workflow filename `release.yml` →
environment `release` → allowed action: direct `npm publish` (post-Sep-2026 configs default
to stage-only — opt in explicitly). Constraints verified against the npm docs (Oct 2026):

- Unvalidated configs expire after **2 days**; the first OIDC publish binds them.
- Configs are immutable — renaming `release.yml` means deleting + recreating all 8.
- Validation checks the **calling** workflow's filename — `release.yml` deliberately
  contains the build matrix AND the publish job (no `workflow_call` indirection).
- `repository.url` must exactly match the GitHub repo (all 8 manifests carry it).
- GitHub-hosted runners only; npm ≥ 11.5.1 / Node ≥ 22.14 (publish job pins Node 24).
- Provenance is automatic via OIDC from a public repo — no `--provenance` flag.
- `dist-tag` management is a separate permission (off; we don't ship prerelease channels).

`release.ts --auth oidc` requires no secrets; `--auth token` remains as break-glass
(granular token in the `release` environment). Restrict token access per package
("Require 2FA and disallow tokens") once OIDC is proven.

**darwin-x64 execution coverage (2026-10):** the cross build on macos-14 is
validated statically (`scripts/native/arch-check.ts`: every staged binary is
x86_64) plus the usual otool licensing checks — running the dynamic smoke
requires an x64 bun under Rosetta, which SIGILLs once `bun:ffi`'s JIT engages
(observed on Bun 1.4.3, crash report in CI). Real Intel Macs execute the
package natively and are unaffected; re-test Rosetta execution on every Bun
bump before restoring a dynamic gate.

**Windows CRT note:** GEOS builds with the dynamic VC++ runtime (/MD) — end-user machines
need the VC++ 2015–2022 redistributable (hosted runners have it). If that ever becomes a
support burden, the alternative is shipping the CRT DLLs in the platform package (the
sharp model) — a licensing-free, mechanical addition to package-platform.ts.
