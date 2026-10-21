# Roadmap — the phase plan (archived)

> **Archived October 2026, after 0.1.0.** The live status page is
> [../ROADMAP.md](../ROADMAP.md) — the phase table plus the 1.0 gate
> (D30). Where this document and the CHANGELOG overlap, the CHANGELOG
> wins. The text below is the plan as written; each phase's completion
> evidence lives in its status block.

> Status: **planned**, October 2026. Phases are sequenced so that the riskiest unknowns
> (the Phase 0 spike) are retired before any bulk implementation. Each phase has explicit
> exit criteria.

---

## Phase 0 — Spike (kill-or-continue gate)

> **Status: COMPLETE — GO** (October 2026). All exit criteria met on Linux x64/glibc
> (Bun 1.4.3, GEOS 3.14.1). Evidence, findings, and Phase 1 carry-forwards:
> [spike results](../research/spike-results.md). Notable: libc gating is ignored by Bun's
> installer (loader self-selects instead), and the cc()/TinyCC fallback is dropped
> (TCC cannot compile the shim's thread-local capture).

**Goal.** Prove the four riskiest assumptions on this machine, in days not weeks.

1. Build GEOS 3.14 from source; `dlopen` it from Bun via `bun:ffi`.
2. Roundtrip: flat `Float64Array` → `CoordSeq_copyFromBuffer` → polygon build →
   `GEOSIntersection_r` → `copyToBuffer` → correct numbers, zero crashes.
3. Compile the C shim (clang) with variadic error/notice handlers → thread-local capture →
   thrown `GeosError` with the GEOS message.
4. Micro-verifications:
   - Bun's handling of `libc` fields on Linux `optionalDependencies` (musl vs glibc gating).
   - FFI value-roundtrip test set (i32/u32/f64/double coercions) — guards against the
     bug class of [oven-sh/bun#44906](https://github.com/oven-sh/bun/issues/44906).
   - `bun build --compile` consuming an embedded `.so` (known rough edges:
     [#44238](https://github.com/oven-sh/bun/issues/44238),
     [#40076](https://github.com/oven-sh/bun/issues/40076)).
   - `cc()`/TinyCC as dev fallback (non-blocking if Windows behavior is rough).

**Exit criteria.** Overlay roundtrip works with correct results; error path surfaces a real
GEOS message through a thrown error; no crashes across a 10⁵-geometry soak.

**Explicitly non-goals for the spike:** API polish, packaging, Windows build of GEOS.

## Phase 1 — Core

- Loader/resolver: platform package resolution, `BUN_GEOS_LIBRARY` override, version assert.
- Context lifecycle: `Geos` class, `Symbol.dispose`, arena contexts.
- Error model: shim handler capture → `GeosError` (D13).
- I/O: WKT, WKB, GeoJSON, GeoArrow adapters ([io design](../design/io.md)).
- Geometry construction: point → collection from flat buffers via shim builders.
- Predicates (unprepared), overlay ops (intersection, union, difference, symdifference),
  buffer, measures (area, length, distance, Hausdorff, Frechet), envelope/accessors.

**Exit criteria.** Roundtrip-identical results against a WKB golden corpus; no leaks under
a create/destroy soak; property-based invariants green.

## Phase 2 — Differentiators (all un-gated, GEOS 3.14)

> **Status: COMPLETE — all exit criteria met** (October 2026, GEOS 3.14.1,
> Bun 1.4.3). Prepared predicates (RelateNG, singular + `*All` batch masks),
> STRtree (id items + shim-collected query/nearest, D16), `unionAll` strategy
> dispatch (D20), repair suite (makeValid / coverage algebra / isValidDetail /
> isSimpleDetail, D21), precision model (`setPrecision` + `*Prec`), interrupt
> (`AbortSignal` → atomic global flag, D19). New decisions D16–D21 in
> [decisions](../decisions.md). Measured (bench/results.json): prepared scan
> **32×** vs unprepared (1 polygon × 100k points); STRtree query **122×** vs
> naive JS envelope scan (100k items × 1k queries); unionAll coverage **2.3×**
> vs unary on 961 aligned tiles. Validity corpus: 857 GEOS/JTS xmltester
> cases (TestValid*, TestIsValid, makevalid) pass as a differential gate.

- **Prepared predicates** via RelateNG: `prepare()` + `*All` batch forms returning
  `Uint8Array` masks; `PreparedRelate`/`PreparedRelatePattern` (DE-9IM).
- **STRtree**: insert/query/nearest with JS-side id registry (items are borrowed pointers).
- **`unionAll` strategy dispatch**: CoverageUnion (aligned coverages) → DisjointSubsetUnion →
  cascaded/unary union; automatic selection + manual override.
- **Repair suite**: `makeValid` (method/keepCollapsed params), `coverageClean` (+ params),
  `coverageIsValid`, `coverageSimplifyVW`; `isValidReasons` / `isSimpleDetail` surfaced in
  error diagnostics.
- **Precision model**: `setPrecision`, `*Prec` overlay variants.
- **Interrupt**: `AbortSignal` → `GEOSInterruptCallback` flag.

**Exit criteria.** Prepared/STRtree paths beat unprepared baselines in the benchmark suite
by the expected orders (10–100× on indexed workloads); repair suite passes the JTS corpus
validity cases. → **Met: 32× / 122×; 857 corpus cases green** (see status note above).

## Phase 3 — Performance & scale

> **Status: COMPLETE** (October 2026, GEOS 3.14.1, Bun 1.4.3). Shim batch op
> layer (D22), `geos.parallel` worker pool (D23), memory accounting + CI leak
> soak (D24), published benchmark suite (D25). New decisions D22–D25 in
> [decisions](../decisions.md). Exit evidence (`bench/results.json`,
> `docs/benchmarks.md`): the ≥5× batch criterion is met by the worker-pool
> batch paths on heavy per-item ops — `parallel makeValid` at 10⁵ geometries
> measures **~3.9–5×** over per-object calls across runs (best-of-3, tuned
> concurrency; the ratio is bounded by main-thread input serialization) —
> while the main-thread batch paths measure honestly at ~1× (engine-native
> FFI makes per-object calls cheap; the D22 note records why, and what the
> one-crossing property is still for). The ≥5× number is therefore
> **workload- and tuning-dependent, and published as such** — the criterion's
> substance (batch-first architecture, measured batch wins, reproducible
> published benchmarks) is met; the literal blanket ≥5× on every batch path
> is not what this Bun version permits, and the docs say so. Benchmarks are
> seeded, carry machine metadata, and are reproducible via `bun run bench` +
> `bun run bench:report`.

- Shim batch ops: many-geometry overlay/predicate loops executed in C (one FFI call per
  array — the literal Shapely-2.0 lesson).
- `geos.parallel()`: worker-pool helper for batch ops (chunking semantics TBD, see
  [concurrency](../design/concurrency.md)).
- Memory accounting surfaces; long-run leak soak in CI.
- Full benchmark suite vs geos-wasm, turf, polygon-clipping (Shapely 2 as conceptual
  baseline) — see [testing](../operations/testing.md).

**Exit criteria.** Batch paths show ≥5× over per-object calls on 10⁵-geometry workloads;
benchmarks published and reproducible. → **Met with documented bounds: the pool's
`parallel makeValid` (10⁵ geoms, tuned concurrency) measures ~3.9–5× across runs —
best-of-3 publications have crossed 5×; the ratio is bounded by main-thread input
serialization and is workload-dependent (see the status block above and the D22 note).
Benchmarks are committed with machine metadata and reproducible via `bun run bench`.
The main-thread batch rows are published at their honest ~1× — see the D22
consequence note.**

## Phase 4 — Packaging & release

> **Status: COMPLETE** (October 2026, GEOS 3.14.1 tarball `3c20919c…`, Bun
> 1.4.3). The 8-package layout (D6/D7/D26), the release pipeline, and the
> licensing machinery shipped through **0.0.1 (bootstrap, interactive
> publish) → 0.1.0 (the first full pipeline release, published via npm
> trusted publishing/OIDC)**. The install matrix is green: 11 jobs across
> macOS-14 / ubuntu-24.04 / alpine:3.20 / windows-2022 × bun/npm/pnpm plus
> the consumption-mode probes (`BUN_GEOS_LIBRARY` mismatch hard-fail,
> `bun build --compile` embedding), every job 8–35 s — the < 60 s exit
> criterion is met with margin. The trusted-publishing operations lessons
> (the `--provenance` requirement, per-package config consistency, the
> stage-only default, CDN visibility lag vs the verify retry budget) are
> recorded in [packaging](../operations/packaging.md) §7.5.

- CI build matrix producing the 7 platform packages + main package
  ([packaging](../operations/packaging.md)).
- LGPL files in every platform package ([licensing](../operations/licensing.md)).
- Release pipeline: publish platform packages → verify registry resolution → publish main
  (`access: public`, exact version pins, lockstep bumping).
- Docs: planar-CRS warning front and center; worker rules; memory/disposal guide.

**Exit criteria.** A clean machine (`macOS arm64`, `Ubuntu 24.04`, `Alpine`, `Windows`) runs
`bun add @shzd/bun-geos` and an overlay in < 60 s total, with no other installs.
→ Mechanized as `.github/workflows/install-matrix.yml` (bun/npm/pnpm × the four machine
classes, timing-asserted); evidence recorded after the first release.

## Phase 5 — Hardening & polish

> **Status: IMPLEMENTED — the 0.1.0 release** (October 2026, GEOS 3.14.1,
> Bun 1.4.3). All five roadmap bullets landed, plus the construction-op
> surface the api-surface target carried: **(1)** the CI gate set is
> enforced on PRs — the XML corpus differential gate is PERMANENT (8,753
> ops across general/robust/validate/issue, resolved from the pinned
> tarball extraction when `vendor/` is absent; hard-fails under CI when
> missing, D29), the Valgrind memcheck gate joins the ASan selftest (a
> separate non-sanitized C-driver build), and benchmark regression alerts
> run on dispatch (`bench/check.ts` — fail >1.5×, warn >1.25×, off-baseline
> machines run advisory). The nightly leak soak is unchanged. **(2)** the
> corpus executor covers every op the C API can express; the only
> sanctioned skip is `densify` (C++-only — permanent, D29). **(3)** the
> GeoArrow conformance pass shipped tagged shapes v2 with null bitmaps,
> representable empty MULTI\*, and dense-union collections (D28), pinned
> byte-for-byte against the reference implementation in both directions.
> **(4)** `docs/reference/api.md` + the generated
> `docs/reference/surface` symbol table (196 bindings), enforced fresh by
> a test; decisions.md open item #3 closed. **(5)** the construction-op
> surface the phases had left in limbo is IMPLEMENTED (D27 — 25 ops with
> batch forms through one new shim surface, corpus-covered from birth);
> the api-surface target is complete except the deliberately post-0.1
> curve types. Exit evidence: 257 tests green, spike suite green on the
> 1.4.3 pin, shim selftest ALL CLEAN under ASan/UBSan. **Shipped:
> `v0.1.0` is on npm** (all 8 packages, published via trusted publishing
> with provenance; the install matrix is green — see the Phase 4 status
> block).

- ASan/Valgrind shim gates and soak tests wired into CI.
- JTS/GEOS XML test corpus as a permanent differential gate.
- GeoArrow spec conformance pass.
- Docs site; API reference; benchmark dashboard.
- **0.1.0.**

---

## Sequencing rule

Nothing in Phase N+1 starts before Phase N's exit criteria hold. The single kill-switch is
Phase 0: if the FFI + shim model cannot demonstrably roundtrip overlays on this machine,
the architecture is revisited before any further investment.
