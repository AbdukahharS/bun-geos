# Changelog

All notable changes to `@shzd/bun-geos` are documented here. The library's GEOS surface is
strict 3.14 (D5); GEOS upgrades ship as releases of this package, never as user-visible
version gating.

Format: Keep a Changelog-ish; semver-ish 0.y.z until the 1.0 gate ([D30](https://github.com/AbdukahharS/bun-geos/blob/main/docs/decisions.md)):
a release carrying a breaking change OR new API bumps `y`; fixes/perf/docs bump `z`.

## Unreleased

**Docs & tooling:**

- Benchmark baselines regenerated on the baseline machine (Ryzen 7 260, now
  Bun 1.4.4, commit `6fe2b0b`) — the 0.3.0 perf changes are in the numbers:
  prepared 35×, STRtree 107×, read-many 14.3×, pool ~4.6× (0.3.0 shipped
  quoting the 0.2.0-era `a1fffdc` run). `docs/benchmarks.md` re-rendered,
  the site benchmarks page and guide citations synced, and the competitor
  runner's bun-geos version stamp now reads the manifest (was hardcoded
  0.1.0). Winning cells on the site benchmarks page carry a visible ✱
  marker next to the bold — weight alone was too quiet in Geist.

## 0.3.0 — the crossing-amortized boundary

An additive release (`y` bump for the new API — NOT breaking; the 1.0-gate
three-month clock is unaffected, D30/D32). The D31 batch check moves into
the shim crossing and the STRtree gains a batch insert — both moves are
D31/D32-sanctioned architecture; the measured wins are honest and modest.
End-to-end before/after medians on the dev machine proved noise-dominated
(the same harness measured identical code anywhere from 18.5 to 33 ms
across runs), so the numbers below are component-level isolated
measurements (same-process, interleaved reps, sync-GC discipline).

**Added:**

- `STRtree.insertMany(geoms): number[]` — the batch twin of `insert`: n
  geometries in ONE shim crossing (`geos_shim_strtree_insert_all`), ids
  continuing the tree's sequence (`ids[i] = size-before + i`; mixed
  `insert`/`insertMany` trees keep one id space). All inputs are validated
  before the crossing and the registry syncs only on success — all-or-nothing
  at the JS boundary. The shim function deliberately deviates from the D18
  0/1/2 machinery (0 ok / 1 invalid-args; no interrupt checks) because
  `GEOSSTRtree_insert_r` is void AND signal-free — verified in the GEOS 3.14
  sources; the reasoning, the accepted blind spot (GEOS-side exceptions are
  swallowed by the void return, exactly as on the per-item path), and the
  fallback are recorded as **D32** and pinned by selftest scenario 31
  (identical answers to the per-item build, the id-continuation pin,
  pre-pass NULL rejection).

**Changed:**

- The D31 linear-only check for `fromWKBMany` moved INTO the shim crossing
  (`assert_linear` in `geos_shim_read_wkb_many`, per parsed row with
  collection recursion and the 32-level guard) — the JS per-row `assertLinear`
  loop paid one `GEOSGeomTypeId_r` crossing per geometry, isolated at
  **~1.1 ms per 20k-row batch (~55 ns/crossing, measured)** — a few percent
  at that scale, with the batch now crossing ONCE regardless of row count.
  The D31 decision anticipated exactly this move; the human message keeps
  the exact D31 wording plus a `row N:` prefix. TWO observable contract
  details moved with it (both pinned by tests): the thrown `GeosError`'s
  `op` for batch curved/nesting failures is now `geos_shim_read_wkb_many`
  (was `fromWKBMany`) — relevant only to consumers switching on `err.op` —
  and single `fromWKB`/`fromWKT` reads keep the JS-side check unchanged.
- The STRtree id→geometry registry is a plain array (ids are sequential by
  construction, so the `Map` was pure overhead — `Map.set` measured ~11 ms
  vs ~2 ms for pushes per 100k items (the figures recorded in
  `src/spatial/strtree.ts`), i.e. roughly **~1.5× on 100k-item
  builds**). This benefits `insert`, `insertMany`, and the
  `geos.strtree(geoms)` constructor alike; internals only, all behavior
  contracts (D16 ids, D17 pinning, frozen-at-build) unchanged. Post-change,
  `insertMany` and the per-item loop measure about equal on a quiet machine —
  insertMany's value is the single crossing (no per-item JS↔C ping-pong
  under load), not a quiet-machine speedup.

**Docs & tooling:**

- D32 recorded; api.md documents `insertMany`; the symbol reference carries
  the new binding (bound as `usize`, matching the codebase's `size_t`
  convention) and the D31-in-the-crossing note; design docs updated for
  the array registry. A docs-accuracy pass against the committed baselines
  and the source: README's headline numbers now quote `bench/results.json`
  (90× STRtree, 33× prepared, 19.6× read-many, ~3.7–5× pool), api.md
  corrected three false facts (`stats.finalized`, `WKTOptions.precision`,
  the parallel pool's real `*All` surface), the D29 corpus-gate decision
  recorded where the references already pointed, and the operations docs
  caught up with shipped reality (OIDC publishing, the darwin-x64 cross
  build, runner names). The Cirth docs-site orphan branch is retired — the
  site imports `site/` from `main` directly, `bun run docs:site` syncs the
  generated `site/changelog.md`, and the site gates (link discipline, no
  D-refs in hand-written pages, changelog freshness) became permanent
  tests. MSVC shim builds now pass `/utf-8` (shim.c carries
  UTF-8 text in comments and the D31 message — without the flag the Windows
  error string could drift through the system code page).

## 0.2.0 — the linear-only boundary + the cross-library benchmark suite

The first post-Phase-5 release: one breaking change and one new API (a `y` bump per D30).
The library is **declared linear-only** (D31) and the readers now enforce that at the
boundary; the benchmark story gains an honest cross-library comparison.

**Added:**

- `STRtree.queryAll` — N envelope queries in ONE shim crossing: flat candidate ids plus
  cumulative u32 offsets (D18 contract), counting overflow beyond capacity with a
  right-sized re-request. The main-suite STRtree row gains the variant (5.1 → 3.7 ms at
  100k×1k); selftest-pinned (scenario 19b: offsets, overflow clamping, invalid args).
- The cross-library benchmark suite: one shared scenario catalog (seeded coordinate-level
  twins), in-process competitor adapters (geos-wasm, JSTS, turf, polygon-clipping, rbush,
  flatbush, wkx) plus Shapely 2 and a direct GEOS C++ subprocess baseline, an
  answer-fingerprint column, and a documented ±10% noise band. 44/45 cross-engine answer
  fingerprints agree (the one difference is turf's geodesic buffer, by design). Competitor
  engines are optional devDependencies behind `bench:competitors:setup`; the methodology
  is documented in testing.md §4.

**Changed:**

- **BREAKING** — `fromWKB`/`fromWKT`/`fromWKBMany` now throw `GeosError` on curved
  payloads (the GEOS 3.13 ISO SQL/MM types, ids 8–12) that previously parsed into a
  degraded object (`Unknown(8)` type names, raw GEOS exceptions from every op). GEOS's
  curve support is I/O-and-measure only — every predicate, overlay, distance, and
  validity op rejects curved inputs — and the JS exchange formats (GeoJSON RFC 7946,
  GeoArrow) are linear-only, so the readers reject curves loudly at the boundary (D31).
  The check recurses into GEOMETRYCOLLECTION children whose linear id-7 shell would hide
  a curve (32-level guard); `fromWKBMany` stays all-or-nothing (D22); the parallel
  pool's worker ingest shares the guarded readers.
- Arena-owned batch outputs skip the redundant per-geometry finalizer registration —
  the arena is the backstop (D10 refinement); context-owned geometries keep the full
  net. Measured: `fromWKBMany` 20k 16.9 → 10.1 ms; point-loop 17.2 → 7.6 ms.

**Docs & tooling:**

- D30 (the versioning convention and the measured 1.0 gate) and D31 (curved types
  declared never) recorded; the phase plan archived to `docs/archive/`, the ROADMAP
  slimmed to the 1.0 gate; the user-guides draft and the Cirth docs-site prepare step.
- `bench:check` treats sub-10ms baseline rows as advisory (scheduler and boost state
  dominate at that scale); committed baselines refreshed (schema-2 internal + schema-3
  competitor comparison, 10 engines, 56 records).
- Release tooling: the registry-resolution verify retries extended for CDN visibility lag.

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

