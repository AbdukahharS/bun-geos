# @shzd/bun-geos

[![Documentation](https://img.shields.io/badge/docs-bun--geos.cirth.app-0f766e)](https://bun-geos.cirth.app)

**Bun-native TypeScript bindings for [GEOS](https://libgeos.org) 3.14 — the geometry engine
inside PostGIS — for complex overlays, topology repair, and boolean operations at native speed.**

> [!WARNING]
> **GEOS is a planar, Cartesian engine. It knows nothing about the curvature of the Earth.**
> Coordinates are x/y numbers on an infinite plane — there is no geodetic math, no ellipsoids,
> no SRID-aware transformations. If your data is lat/lon, **project it to a planar CRS first**
> (e.g. with [proj4](https://github.com/proj4js/proj4js)); buffer distances and areas are
> expressed in those projected units. Feeding degrees to `buffer()` and expecting meters is
> the classic geospatial bug — this library will happily hand you garbage with a straight face.

> [!NOTE]
> **Status: Phase 5 (hardening & polish) — 0.1.0.** The complete api-surface target is
> implemented and gated: 257 tests, an 8,753-op GEOS/JTS corpus differential gate,
> ASan+Valgrind shim gates, GeoArrow golden-byte conformance, PostGIS oracle.
> See the [roadmap](docs/ROADMAP.md) for phase status and the
> [API reference](docs/reference/api.md) for the full documented surface.

---

## Requirements

- [Bun](https://bun.com) ≥ **1.4.3** (the tested pin; the tested range is documented per release)
- Nothing else. No system GEOS, no compiler, no CMake — every platform package bundles a
  pinned GEOS 3.14 build plus a tiny precompiled C shim (~5.5 MB per install).

**Bun-only, by design.** Node.js and browsers are not supported and there is no WASM build —
that's [D1](docs/decisions.md) and it is not up for debate. For browser workloads, use
[geos-wasm](https://github.com/chrispahm/geos-wasm). Because the package ships raw TypeScript
source (Bun executes TS natively), your bundler/typechecker reads the same source you'd read —
there is no build step between this repo and your `node_modules`.

## Install

```sh
bun add @shzd/bun-geos
```

One of seven platform packages is selected automatically via `optionalDependencies`
(`os`/`cpu`/`libc` fields; the [sharp/esbuild model](docs/operations/packaging.md)). On Linux,
Bun's installer downloads both the glibc and musl variants and the loader self-selects at
runtime — a [known Bun behavior](docs/research/spike-results.md), not a bug.

| OS | Arch | libc | Package |
|----|------|------|---------|
| macOS | arm64, x64 | — | `@shzd/bun-geos-darwin-{arm64,x64}` |
| Linux | arm64, x64 | glibc | `@shzd/bun-geos-linux-{arm64,x64}-gnu` |
| Linux | arm64, x64 | musl | `@shzd/bun-geos-linux-{arm64,x64}-musl` |
| Windows | x64 | — | `@shzd/bun-geos-win32-x64` |

## Quickstart

```ts
import { Geos } from "@shzd/bun-geos";

using geos = new Geos(); // owns a GEOS context; Symbol.dispose frees it

const a = geos.fromWKT("POLYGON ((0 0, 4 0, 4 4, 0 4, 0 0))");
const b = geos.fromGeoJSON({ type: "Polygon", coordinates: [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]] });

const overlap = geos.intersection(a, b);   // OverlayNGRobust
const fixed = geos.makeValid(broken);      // topology repair
const merged = geos.unionAll(parcels);     // CoverageUnion / DisjointSubsetUnion dispatch

using prep = a.prepare();                  // RelateNG prepared predicates (3.13+)
const mask: Uint8Array = prep.intersectsAll(points);

const tree = geos.strtree(geoms, 10);
const hits: Int32Array = tree.query(envelope); // ids, one FFI crossing

geos.toWKT(overlap); // "POLYGON ((2 2, 4 2, 4 4, 2 4, 2 2))"
```

## The three rules (read these, avoid every support ticket)

1. **Project to a planar CRS first.** See the warning above. There is no second bullet to this
   rule because there is no exception to this rule.
2. **Dispose what you create.** `using` is the ergonomic path; `geos.arena()` wraps hot loops
   (bulk-destroy in one FFI call); a `FinalizationRegistry` is the leak net, not a strategy.
   → [Memory & disposal guide](docs/guide/memory-and-disposal.md)
3. **One `Geos` per thread; geometries never cross it.** Bun Workers each get their own
   context. To move geometry between threads, transfer a WKB/GeoJSON/Arrow **copy**.
   → [Workers & parallelism guide](docs/guide/workers-and-parallelism.md)

## Batch-first by construction

The [Shapely 2.0 lesson](docs/research/language-bindings.md): the product is the batch loop.
Every op ships a plural form that is *not* a JS loop over the singular — masks come back as
`Uint8Array`, ingest as one `fromWKBMany` crossing, and heavy batch work has a worker-pool
mirror (`geos.parallel.*`) with chunking, `AbortSignal` support, and WKB transfer.

Measured honestly on Bun 1.4.3 ([docs/benchmarks.md](docs/benchmarks.md)): prepared predicate
scans **32×** vs unprepared; STRtree queries **122×** vs a naive JS scan; WKB read-many
**12.5×**; `parallel makeValid` at 10⁵ geometries **~4–5×** over per-object calls.

## Documentation

| Document | Contents |
|----------|----------|
| [Getting started](docs/guide/getting-started.md) | install, first ops, I/O formats, errors |
| [Memory & disposal](docs/guide/memory-and-disposal.md) | `using`, arenas, stats, the GC backstop |
| [Workers & parallelism](docs/guide/workers-and-parallelism.md) | thread rules, `geos.parallel`, cancellation |
| [API reference](docs/reference/api.md) | every public export — signatures, disposal, errors |
| [Symbol reference](docs/reference/symbols.md) | the JS ↔ `geos_c` mapping, generated from the source |
| [`docs/decisions.md`](docs/decisions.md) | the decision record (D1–D30) — every architectural choice and why |
| [`docs/ROADMAP.md`](docs/ROADMAP.md) | phase status & the 1.0 gate |
| [`docs/operations/`](docs/operations/) | packaging & release, licensing, testing |

## Versioning

0.y.z until further notice — semver major-0 *is* the "experimental" label, and it is honest
([D30](docs/decisions.md)): breaking changes and new API bump `y`, fixes bump `z`. Each
release documents its tested Bun range; `engines.bun` floors it in the manifest.
Prereleases (`-rc.N`, burn-in candidates only) publish under the `rc` dist-tag and never
touch `latest`. 1.0.0 is gated on this project's own criteria — the curve-types decision,
two clean Bun minors, a green install matrix — not on bun:ffi's label.

## Known limitations (all deliberate)

- **Bun-only**; requires the JIT (`bun:ffi` has no JIT-less mode — the loader says so plainly).
- **Bun is experimental** and so is this package; `bun:ffi` semantics are pinned per release
  and gated by the FFI roundtrip suite on every Bun bump.
- **Planar math only** — see the warning; the SRIDs you set are carried through WKB, nothing more.
- **`bun build --compile`** works (the embedded `.so` dlopens from `$bunfs`) but currently
  leaks one temp file per run ([#40076](https://github.com/oven-sh/bun/issues/40076)) —
  documented per Bun version, never silently broken.
- **Windows**: GEOS is built with the dynamic VC++ runtime — the usual
  [VC++ 2015–2022 redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) must be
  present (most machines have it; CI runners do).

## License

- `@shzd/bun-geos` itself: [MIT](LICENSE).
- Bundled GEOS binaries: [LGPL-2.1](https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html)+,
  dynamically linked, unmodified, built from the pinned release tarball — license text and
  source link ship in **every platform package** ([licensing](docs/operations/licensing.md)).
  Same compliance model as Shapely's wheels and geos-wasm.
