# Changelog

All notable changes to `@shzd/bun-geos` are documented here. The library's GEOS surface is
strict 3.14 (D5); GEOS upgrades ship as releases of this package, never as user-visible
version gating.

Format: Keep a Changelog-ish; semver-ish (0.0.x while the release pipeline hardens; 0.1.0 is
the Phase-5 hardened release).

## 0.1.0 — Phase 5 (hardening & polish)

The complete api-surface target, permanently gated: 257 tests, an 8.7k-op XML corpus
differential gate, Valgrind + ASan shim gates, GeoArrow golden-byte conformance, and the
reference docs.

**Added:**

- The full construction-op surface (D27): `convexHull`, `concaveHull`, `simplify`,
  `topologyPreserveSimplify`, `clipByRect`, `delaunay`, `constrainedDelaunay`, `voronoi`,
  `lineMerge` (+`directed`), `lineSubstring`, `offsetCurve`, `sharedPaths`, `snap`,
  `node`, `buildArea`, `polygonize`, `centroid`, `interiorPoint`, `boundary`,
  `nearestPoints`, `minimumClearance`/`minimumClearanceLine`,
  `maximumInscribedCircle`, `largestEmptyCircle`, `clusterDBSCAN` (ids per input,
  -1 = noise), `gridIntersectionFractions` — with element-wise `*All` batch forms for the
  loop-shaped ones through one new shim surface (`geos_shim_unary_all` /
  `geos_shim_binary_all`, selftest-pinned op-id tables).
- GeoArrow shapes v2 (D28): tagged kinds (the `geoarrow.*` extension-name mapping), Arrow
  LSB validity bitmaps with batch `nullMode` ("throw"/"skip"), representable empty
  MULTI\*, dense-union `geometrycollection`. `toArrow` now emits tagged values (breaking
  vs 0.0.x; legacy untagged input is still accepted). Conformance is pinned byte-for-byte
  against the reference implementation (`geoarrow-pyarrow`) in both directions.
- API reference (`docs/reference/api.md`) and a generated symbol table
  (`docs/reference/symbols.md`, 196 bindings), enforced fresh by a test.
- Benchmark regression alerts (`bun run bench:check`, a manual-dispatch CI job) and a
  construction-batch row in the published suite.
- The XML corpus gate is PERMANENT: 8,753 ops across the general/robust/validate/issue
  xmltester files run on every PR (resolved from the pinned tarball extraction when
  `vendor/` is absent; hard-fails under CI when missing — D29). Every op of the shared
  GEOS/JTS corpus the C API can express is executed; the only sanctioned skip is
  `densify` (C++-only, no C API).

**Changed:**

- `geos.toArrow` returns tagged shapes (see above).
- DECISIONS D27–D28 recorded; house rules extended (unary/binary op-id tables, int-return
  exceptions).

**Gates (CI, per testing.md §5):** lint + typecheck + full tests (incl. the corpus) +
ASan/UBSan + Valgrind memcheck + spike suite + PostGIS oracle on every PR; nightly
long-run soak; benchmark regression alerts on dispatch.

## 0.0.2 — Phase 4 (packaging fixes) — **never published** (rolled into 0.1.0)

> The 0.0.2 section below documents repo-side fixes that landed after 0.0.1; the
> registry never received 0.0.2 (its `latest` was 0.0.1 until 0.1.0), and the
> "first trusted-published release" claim was aspirational — the first real OIDC
> publish is 0.1.0. The fixes ship with 0.1.0.

**Fixed:**

- Platform manifests declared `libc: ["gnu"]`; npm's field vocabulary is `glibc`/`musl`, so
  **npm on Linux skipped both linux packages** (bun ignores the field — the two managers
  diverged). Now `libc: ["glibc"]` for the `-gnu` packages. (musl was always correct.)
- `repository.url` pointed at the wrong org; npm trusted publishing requires an exact match.

**Changed:**

- Publishing switched to **npm trusted publishing (OIDC)** — no tokens in CI. The 0.0.1
  bootstrap was published interactively because granular tokens do not bypass 2FA-enforced
  publishing (`EOTP`), and npm is deprecating 2FA-bypassing tokens outright.

## 0.0.1 — Phase 4 (packaging & release) — first publish

The first npm release. The library surface itself was completed across Phases 1–3 (see the
[roadmap](https://github.com/AbdukahharS/bun-geos/blob/main/docs/ROADMAP.md) for what landed when and the measured results).

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
