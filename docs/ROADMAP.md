# Roadmap

> Status: **phases 0–5 COMPLETE — 0.1.0 on npm** (October 2026). The
> live plan is the [1.0 gate](#the-10-gate-post-phase-5) below (D30);
> the full phase prose is archived in
> [archive/roadmap-phase-plan.md](archive/roadmap-phase-plan.md).

| Phase | Goal | Status | Exit evidence |
|-------|------|--------|---------------|
| 0 — Spike | prove dlopen + overlay roundtrip + the shim error path | **COMPLETE — GO** | roundtrip correct, error path surfaces a real GEOS message, 10⁵-geometry soak clean ([spike results](research/spike-results.md)) |
| 1 — Core | loader, contexts, I/O, construction, overlays, measures | **COMPLETE** | WKB golden corpus roundtrip-identical; create/destroy soak leak-free; property invariants green |
| 2 — Differentiators | prepared predicates, STRtree, `unionAll` dispatch, repair suite, precision, interrupt | **COMPLETE** | prepared scan **32×**, STRtree **122×**, coverage union **2.3×**; 857-case validity corpus green |
| 3 — Performance & scale | shim batch ops, worker pool, memory accounting, published benchmarks | **COMPLETE** | `parallel makeValid` at 10⁵ geoms **~3.9–5×** (bounded by input serialization; main-thread batches publish honest ~1× — D22); seeded, reproducible benchmark suite |
| 4 — Packaging & release | 8-package publish pipeline, licensing, docs | **COMPLETE** | 0.1.0 published via trusted publishing/OIDC; install matrix green (11 jobs × 8–35 s — the < 60 s criterion met) |
| 5 — Hardening & polish | permanent corpus/Valgrind gates, GeoArrow v2, API reference, construction ops | **COMPLETE** | 257 tests green; permanent 8,753-op XML corpus gate (D29); GeoArrow golden-byte conformance; 196-binding symbol table; the full construction-op surface (D27) |

A GEOS bump re-runs this ladder as a release of this package (D5) — it
does not reopen it.

---

## The 1.0 gate (post-Phase-5)

> Status: **OPEN**. The versioning convention is [D30](decisions.md):
> 0.y.z until this gate closes; `-rc.N` burn-in candidates ride the
> `rc` dist-tag and never `latest` (mechanically enforced by
> `scripts/release.ts`).

- [ ] **Curve types decided** (in, or declared never) — the one open
      API-surface gap; if "in", shipped before 1.0.0.
- [ ] **Two consecutive Bun minors** pass the full gate suite (FFI
      roundtrip/spike, XML corpus, ASan/Valgrind, install matrix, soak)
      with zero FFI-semantics surprises.
- [ ] **Three months** without needing a breaking change.
- [ ] **Install matrix green on `latest`** (bun/npm/pnpm × the four
      machine classes).

bun:ffi's "experimental" label is deliberately NOT on this list — the
1.0 contract is "stable on the tested Bun range" (D30).
