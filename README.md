# @shzd/bun-geos

**Bun-native TypeScript library wrapping [GEOS](https://libgeos.org) — the geometry engine inside
PostGIS — for complex overlays, topology repair, and boolean operations at native speed.**

> **Status: design phase, pre-spike.** The library does not exist yet. This repository currently
> holds the full research, decision record, architecture, and operations documentation produced
> during planning (October 2026). Implementation starts with [Phase 0](docs/ROADMAP.md#phase-0--spike).
> All APIs shown in these docs are **design targets, not contracts**.

---

## What it will be

- **Real GEOS 3.14** — OverlayNG robust overlays, `MakeValid`, `CoverageClean`,
  `CoverageUnion`, prepared predicates via RelateNG, STRtree spatial index.
  No pure-JS reimplementation, no WASM: the actual battle-tested C++ engine.
- **Bun-native** — built on `bun:ffi` and Bun Workers. No Node-API addon, no browser build,
  no Node compatibility story. Experimental runtime, experimental package — by design.
- **`bun add` just works** — every platform package bundles a pinned GEOS 3.14 build plus a
  tiny precompiled C shim. Users never install, see, or think about GEOS.
- **Typed-array-first** — flat `Float64Array` coordinates + offset arrays are the canonical
  currency (aligned with GEOS's `CoordSeq_copyFromBuffer` and the GeoArrow layout).
  GeoJSON for ergonomics, WKB and GeoArrow as first-class I/O.
- **Batch-oriented from day one** — the core lesson of Shapely 2.0 / R `sf` / GeoPandas:
  the product is the batch loop, not syntax over per-object calls.

### Target API (design sketch — not implemented)

```ts
import { Geos } from "@shzd/bun-geos";

const geos = new Geos();                          // owns a GEOS context; Symbol.dispose

const a = geos.readWKT(polygonWkt);
const b = geos.fromGeoJSON(feature);

const fixed  = geos.makeValid(broken, { method: "structure", keepCollapsed: false });
const merged = geos.unionAll(parcels);            // CoverageUnion / DisjointSubsetUnion dispatch
const tiles  = geos.coverageClean(mapSheets, { gapWidth: 0.1 });

using prep = a.prepare();                         // RelateNG prepared predicates (GEOS 3.13+)
const mask: Uint8Array = prep.intersectsAll(points);

const tree = geos.strtree(geoms, 10);
const hits = tree.query(envelope);                // Int32Array of ids, one FFI call
```

## Documentation map

| Document | Contents |
|----------|----------|
| [`docs/decisions.md`](docs/decisions.md) | Decision record D1–D14 — every architectural choice and why |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | Phased plan, Phase 0 → 5, exit criteria |
| **Research** — what we learned before designing | |
| [`docs/research/geos.md`](docs/research/geos.md) | GEOS engine: C API contract, ownership rules, version feature map, semantics gotchas |
| [`docs/research/language-bindings.md`](docs/research/language-bindings.md) | How Python/R/Go/Julia/Rust/Java solved GEOS bindings, and the lessons adopted |
| [`docs/research/bun-ffi.md`](docs/research/bun-ffi.md) | `bun:ffi` deep dive: capabilities, performance, real risk inventory with mitigations |
| [`docs/research/js-ecosystem.md`](docs/research/js-ecosystem.md) | The JS/TS geospatial landscape and the gap this package fills |
| **Design** — how it will be built | |
| [`docs/design/architecture.md`](docs/design/architecture.md) | System architecture, components, data flow |
| [`docs/design/shim.md`](docs/design/shim.md) | The C shim: why it is mandatory, its exact responsibilities, build story |
| [`docs/design/memory.md`](docs/design/memory.md) | Ownership mapping, disposal discipline, arenas, GC backstop |
| [`docs/design/concurrency.md`](docs/design/concurrency.md) | Workers, per-thread contexts, interrupt, `parallel()` |
| [`docs/design/io.md`](docs/design/io.md) | GeoJSON / WKB / GeoArrow layers, canonical flat buffers |
| [`docs/design/api-surface.md`](docs/design/api-surface.md) | Target API surface by module group |
| **Operations** — how it ships | |
| [`docs/operations/packaging.md`](docs/operations/packaging.md) | The 8-package layout, CI build matrix, release pipeline |
| [`docs/operations/licensing.md`](docs/operations/licensing.md) | LGPL compliance model, what ships in platform packages |
| [`docs/operations/testing.md`](docs/operations/testing.md) | Differential testing vs the JTS/GEOS corpus, oracles, benchmarks |

## Requirements (planned)

- [Bun](https://bun.com) (the tested version range will be pinned in CI and documented per release)
- Nothing else. No system GEOS, no compiler, no CMake — binaries are bundled per platform.

## Platform support (planned)

| OS | Arch | libc | Package |
|----|------|------|---------|
| macOS | arm64, x64 | — | `@shzd/bun-geos-darwin-arm64`, `@shzd/bun-geos-darwin-x64` |
| Linux | arm64, x64 | glibc | `@shzd/bun-geos-linux-{arm64,x64}-gnu` |
| Linux | arm64, x64 | musl | `@shzd/bun-geos-linux-{arm64,x64}-musl` |
| Windows | x64 | — | `@shzd/bun-geos-win32-x64` |

## License

- `@shzd/bun-geos` itself: MIT (planned).
- Bundled GEOS binaries: [LGPL-2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)+,
  dynamically linked, unmodified, with license and source notices shipped in every platform
  package — the same compliance model as Shapely's wheels and geos-wasm.
  See [`docs/operations/licensing.md`](docs/operations/licensing.md).
