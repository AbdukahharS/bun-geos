# Changelog

All notable changes to `@shzd/bun-geos` are documented here. The library's GEOS surface is
strict 3.14 (D5); GEOS upgrades ship as releases of this package, never as user-visible
version gating.

Format: Keep a Changelog-ish; semver-ish (0.0.x while the release pipeline hardens; 0.1.0 is
the Phase-5 hardened release).

## 0.0.1 — Phase 4 (packaging & release) — first publish

The first npm release. The library surface itself was completed across Phases 1–3 (see the
[roadmap](docs/ROADMAP.md) for what landed when and the measured results).

**Added (this phase):**

- The 8-package publish layout: `@shzd/bun-geos` + 7 platform packages
  (`darwin-{arm64,x64}`, `linux-{arm64,x64}-{gnu,musl}`, `win32-x64`), exact version pins,
  lockstep releases (D6/D7).
- CI build matrix (GitHub Actions): native per-target builds, platform smoke against the
  staged package on every runner, licensing spot checks (`ldd`/`otool`/`dumpbin` + no-static-
  GEOS-symbols), artifact upload → publish → registry-resolution verify → main.
- GEOS source pinning: official release tarball + SHA-256, recorded in every platform
  package's `THIRD_PARTY.md`; verbatim LGPL-2.1 `LICENSE` ships in every platform package
  (D12).
- Release tooling: `scripts/release.ts` (idempotent, staged-publish model D26), verdaccio
  dry-run (`bun run release:dry-run`), install matrix (bun/npm/pnpm × glibc/musl, < 60 s
  budget).
- Shim portability (D4 amendment): `SHIM_TLS` macro for MSVC (`__declspec(thread)`), forced
  pre-C11 atomic fallback on `_MSC_VER`, Windows export list (`native/shim.def`) with
  sync-checks on every platform.
- Loader: Windows preload order (`geos.dll` → `geos_c.dll` → shim — the DLL search path
  excludes the loaded DLL's own directory), `BUN_GEOS_PACKAGE_DIR` override for staged-package
  testing.
- User guides: getting started, memory & disposal, workers & parallelism.
