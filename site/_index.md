---
description: Bun-native TypeScript bindings for GEOS 3.14 — robust overlays, topology repair, and spatial predicates at native speed, with ownership rules that keep you from leaking.
---

# @shzd/bun-geos

**Bun-native TypeScript bindings for [GEOS](https://libgeos.org) 3.14 — the geometry engine
inside PostGIS — for complex overlays, topology repair, and boolean operations at native speed.**

> [!WARNING]
> **GEOS is a planar, Cartesian engine. It knows nothing about the curvature of the Earth.**
> Coordinates are x/y numbers on an infinite plane — there is no geodetic math, no ellipsoids,
> no SRID-aware transformations. If your data is lat/lon, **project it to a planar CRS first**
> (e.g. with [proj4](https://github.com/proj4js/proj4js)); buffer distances and areas are
> expressed in those projected units. Feeding degrees to `buffer()` and expecting meters is
> the classic geospatial bug — this library will happily hand you garbage with a straight face.

## Install

```sh
bun add @shzd/bun-geos
```

Nothing else. No system GEOS, no compiler, no CMake — one of seven platform packages
(bundling a pinned GEOS 3.14 plus a tiny precompiled C shim, ~5.5 MB per install) is
selected automatically. Details: [Install & platforms](/install).

## Thirty seconds in

```ts
import { Geos } from "@shzd/bun-geos";

using geos = new Geos(); // owns a GEOS context; Symbol.dispose frees it

const parcels = geos.fromWKT("MULTIPOLYGON (((0 0, 4 0, 4 4, 0 4, 0 0)))");
const zone = geos.fromGeoJSON({
  type: "Polygon",
  coordinates: [[[2, 2], [6, 2], [6, 6], [2, 6], [2, 2]]],
});

using overlap = geos.intersection(parcels, zone); // OverlayNGRobust
console.log(geos.area(overlap)); // 4
console.log(geos.toWKT(overlap)); // "POLYGON ((2 2, 4 2, 4 4, 2 4, 2 2))"
```

That is the whole mental model: a `Geos` owns the native context, every geometry it hands
you is a `Geometry` you dispose (or hand to an arena), and the hot paths are single FFI
crossings. [Quickstart](/quickstart) walks it end to end.

## The three rules (read these, avoid every support ticket)

1. **Project to a planar CRS first.** See the warning above. There is no second bullet to
   this rule because there is no exception to this rule.
2. **Dispose what you create.** `using` is the ergonomic path; `geos.arena()` wraps hot
   loops (bulk-destroy in one FFI call); a `FinalizationRegistry` is the leak net, not a
   strategy. → [Memory & disposal](/guide/memory)
3. **One `Geos` per thread; geometries never cross it.** Bun Workers each get their own
   context. To move geometry between threads, transfer a WKB/GeoJSON/Arrow **copy**.
   → [Workers & parallelism](/guide/workers)

## What's inside

- **The deep GEOS 3.14 C surface**: overlays, repair, prepared predicates, STRtree,
  coverage algebra, Delaunay/voronoi, offset curves, precision models, clustering —
  every op with element-wise batch forms. → [Operations tour](/guide/overlays)
- **Batch-first by construction**: masks come back as `Uint8Array`, ingest as one
  `fromWKBMany` crossing, and heavy batch work has a worker-pool mirror (`geos.parallel.*`)
  with chunking and `AbortSignal` support. → [Predicates & indexing](/guide/predicates),
  [Workers & parallelism](/guide/workers)
- **Typed I/O**: WKT, WKB/EWKB, GeoJSON, and GeoArrow-shaped interchange — malformed
  input throws a `GeosError` that tells you the `jsonPath`, ring, or byte that offended.
  → [Geometry I/O](/guide/io)
- **Honest memory accounting**: `geos.stats` reports live geometries and heap floor at
  any time. → [Memory & disposal](/guide/memory)
- **Errors you can act on**: programming mistakes throw `TypeError`/`RangeError`; data
  and GEOS failures throw `GeosError` with the op, the GEOS message, and structural
  detail. → [Errors](/guide/errors)

## Requirements

- [Bun](https://bun.com) ≥ **1.4.3** (the tested pin; the tested range is documented per release)
- Nothing else.

**Bun-only, by design.** Node.js and browsers are not supported and there is no WASM
build — that decision is not up for debate. For browser workloads, use
[geos-wasm](https://github.com/chrispahm/geos-wasm).

## Where to next

| Page | You want to… |
|------|--------------|
| [Install & platforms](/install) | get it running, pick apart the platform packages, override the library path |
| [Quickstart](/quickstart) | type real code in the next five minutes |
| [Geometry I/O](/guide/io) | move geometries between WKT/WKB/GeoJSON/Arrow and JS |
| [Overlays & operations](/guide/overlays) | intersect, union, repair, hull, simplify, triangulate, cluster |
| [Predicates & indexing](/guide/predicates) | ask spatial questions fast (prepared + STRtree + batch masks) |
| [Memory & disposal](/guide/memory) | never leak, and prove it |
| [Workers & parallelism](/guide/workers) | scale across cores safely |
| [Errors](/guide/errors) | know what throws what, and why |
| [Benchmarks](/benchmarks) | see the numbers, the methodology, and the cross-library comparison |
| [API reference](/reference) | look up a signature |
| [Changelog](/changelog) | see what changed |

## License

- `@shzd/bun-geos` itself: MIT.
- Bundled GEOS binaries: LGPL-2.1+, dynamically linked, unmodified, built from the pinned
  release tarball — license text and source link ship in **every platform package**.
  Same compliance model as Shapely's wheels and geos-wasm.

---

These docs live in the [bun-geos repository](https://github.com/AbdukahharS/bun-geos)
as plain Markdown and are served by [**Cirth**](https://cirth.app).
