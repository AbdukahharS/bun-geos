# Research: how other languages bind GEOS

> Status: reference. Sources: project docs/repositories as of October 2026. The point of
> this survey is the last column — every lesson is tied to a decision or design doc in
> this repository.

## Python — Shapely / PyGEOS / GeoPandas (the most instructive arc)

**History.**
- **Shapely 1.x (2007–2020):** every `Geometry` wrapped one `GEOSGeometry*` via **ctypes**;
  operations were per-object Python method calls. ctypes overhead (~µs/call) dominated for
  small geometries — Python glue was the bottleneck, not GEOS.
- **PyGEOS (2019):** built by the GeoPandas community as a protest: a **Cython extension
  looping over NumPy object arrays calling the C API directly** — loop, context lookup, and
  call all in compiled C. Array in → array out ("ufuncs"). ~100× on million-geometry batches.
- **Shapely 2.0 (2022):** PyGEOS was merged *into* Shapely; 1.x deprecated. Geometries became
  immutable, empties consistent, hashable. GeoPandas 1.0 later dropped the 1.x path entirely.
- **GeoPandas:** whole-column operations (`gdf.buffer(5)` = one vectorized call over the
  array), moving toward GeoArrow/pyarrow-backed interchange.

**Lesson adopted:** the product is **the batch loop**, not syntax over per-object calls.
Batch/vectorized APIs are first-class here from day one, not bolted on later (D9,
[API surface](../archive/api-surface.md)). Also adopted: Shapely 2's typed consistent
empties and immutability as defaults ([GEOS research §10](geos.md)).

## R — `sf`

**Approach.** Geometries are **external pointers** in a list-column (`sfc`); R finalizers
for cleanup; one GEOS context per thread at the C level; batch loops in C. `sf` displaced
the older per-object `rgeos` for the same reasons Shapely 2 displaced 1.x.

**Lesson adopted:** numeric-pointer + per-thread-context + C-level loops is the shape that
wins; our `Geometry` wrappers hold numeric pointers and our batch ops live in the shim.

## Go — `twpayne/go-geos` (closest analog to this project)

**Approach.**
- Wraps the `_r` API with an explicit **`Context` per goroutine** ("for best performance,
  use one Context per goroutine"), locking for cross-goroutine safety.
- Keeps a **tiny C helper** (`go-geos.c/h`) for what cgo can't express — the same shape as
  our shim (D4).
- **Caches geometry properties** to amortize call overhead.
- Sets cleanup on objects (finalizers) but documents the key hazard honestly: *the C heap is
  invisible to the Go runtime* — large live geometries create memory pressure the GC cannot
  see.
- Ownership: returned sub-geometries keep the parent alive; collections take ownership,
  cloning already-owned inputs when needed.
- Errors: **panics on invalid API use, errors on parsing** — the split we adopt (D13).
- Version gating via `VersionCompare` for functions unavailable in older GEOS — which we
  avoid entirely by shipping strict 3.14 (D5).
- The author's honest note: his **pure-Go `go-geom`** is *faster than GEOS for many
  operations* (cache-friendly flat coordinate layout), and he recommends it for long-running
  processes with simpler needs. GEOS wins on algorithm maturity (overlays, validity,
  coverage) — not on trivial predicates.

**Lessons adopted:** per-thread contexts (D3); the C-helper pattern (D4); invisible-heap
accounting (D10); panic/error split (D13); and the **positioning** consequence — we market
robust overlays, repair, and indexed/batched predicates, never `area()` of a triangle.

## Julia — `LibGEOS.jl`

**Approach.**
- ccall-based wrap of the C API with Julia GC finalizers for cleanup.
- **Ships prebuilt GEOS binaries for every platform** via the Yggdrasil binary-builder
  system (`GEOS_jll`) — users never install GEOS. The precedent for our bundled-binaries
  model (D6), and for the "bindings + versioned binary artifacts" separation.
- Protocol integration via `GeoInterface.jl` so the library isn't an island — the adapter-
  layer pattern (our GeoJSON/Arrow adapters).
- README is candid: "GEOS functionality is extensive, so coverage is incomplete."

**Lessons adopted:** bundling works and is the norm in serious bindings; cover the modern
overlay/repair core deeply rather than wrapping all ~500 C functions shallowly.

## Rust — `geos` crate (and pure-Rust `geo`)

**Approach.** bindgen-style raw bindings plus a safe RAII layer: `Geometry<'a>` owns the
pointer with a **lifetime tied to the Context**, encoding "this geometry is destroyed by the
context that created it." Prepared-geometry and STRtree wrappers; error-message capture on
the handle.

**Lesson adopted:** the lifetime-tying formalizes a real GEOS rule (same-context destroy).
TypeScript has no lifetimes, so the rule is enforced structurally instead: contexts and
geometries are confined to the worker/thread that created them (D11).

## Java — JTS / .NET — NetTopologySuite (the pure-port branch)

JTS is the reference implementation; GEOS is its port; NTS is the C# port. No GC'd
FFI-bound language took the pure-port path (Rust keeps a pure `geo` *alongside* the binding;
JS has turf). Two takeaways: the binding approach is the established lane, and the JTS/GEOS
**shared test corpus** is a free differential-testing asset.

## Summary table

| Ecosystem | Mechanism | Key lesson | Where it landed here |
|-----------|-----------|------------|----------------------|
| Shapely/PyGEOS | ctypes → Cython arrays | The batch loop is the product | D9, API surface, shim batch ops |
| R `sf` | external pointers, C loops | Per-thread contexts + C-level batching | D3, D4 |
| go-geos | cgo + C helper | Context-per-goroutine; invisible C heap; panic/error split; don't market trivial ops | D3, D4, D10, D13, §1 positioning |
| LibGEOS.jl | ccall + jll binaries | Bundle binaries; adapter protocol; deep-not-wide coverage | D6, D9, roadmap scope |
| geos (Rust) | RAII + lifetimes | Enforce same-context destruction structurally | D11 |
| JTS/NTS | pure ports | Test corpus is shared capital; binding is the lane | [testing](../operations/testing.md) |
