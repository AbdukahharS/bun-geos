---
description: I built Bun bindings for GEOS 3.14, the geometry engine inside PostGIS. Here's what it does, how it benchmarks, and where it falls short.
---

# @shzd/bun-geos: GEOS for Bun

**2026-11-03** · [GitHub](https://github.com/AbdukahharS/bun-geos)

I've been working on Bun bindings for [GEOS](https://libgeos.org/), the C++
geometry engine that PostGIS and Shapely are built on. It's called
`@shzd/bun-geos`, it's MIT licensed, and it's at 0.3.0 today.

It wraps GEOS 3.14 through `bun:ffi` plus a small precompiled C shim. You get
overlays, `makeValid`, prepared predicates, an STRtree, clustering, Delaunay and
Voronoi, and WKT/WKB/GeoJSON I/O, all from TypeScript.

```sh
bun add @shzd/bun-geos
```

Needs Bun ≥ 1.4.3 — nothing else. There's no system GEOS to install and nothing
to compile. Each platform package ships a pinned GEOS 3.14 plus the shim (about
5.5 MB), and the right one is picked automatically. There are seven platform
packages; details are on the [Install & platforms](/install) page.

## Why I built it

Honestly, there's no big reason. I didn't have a pain point that this solves,
and nobody was blocked on it.

I wanted to build something open source. I've worked with GIS before, though I'm
not an expert in the field, and GEOS was a library I'd run into and found
interesting. I like Bun, and `bun:ffi` seemed like a good fit for wrapping a C
API. And, like a lot of Bun people, I enjoy looking at good benchmarks. This was
a chance to find out how close a binding could get to calling GEOS directly.

So this is a project I wanted to exist and enjoyed making. If it's useful to you,
great. If you know GIS better than I do and spot something wrong, I'd really like
to hear about it.

## What it looks like

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

The mental model is that a `Geos` owns the native context, and every geometry it
hands you is a `Geometry` that you dispose yourself or give to an arena for bulk
cleanup. A `FinalizationRegistry` acts as a safety net for leaks. You can watch
it in `geos.stats`, but you shouldn't rely on it. The [Quickstart](/quickstart)
goes through this end to end.

## Benchmarks

The benchmarks were the fun part, so I tried to do them properly. The same seeded
workloads run through ten engines, and I compare **answers** as well as times. A
fast wrong answer counts as a mismatch, not a win.

Environment for every cell: Ryzen 7 260 · Bun 1.4.4 · GEOS 3.14.1 · 2026-11-01.
Methodology, full tables, and reproduce commands are on the
[Benchmarks](/benchmarks) page.

| workload                          | bun-geos | direct C | Shapely 2 | geos-wasm |   JSTS |     turf |
|-----------------------------------|---------:|---------:|----------:|----------:|-------:|---------:|
| overlay, 10k pairs (ms)           |    193.4 |    183.1 |     192.1 |     601.7 |  371.7 | 48,293.7 |
| makeValid, 1k bowties (ms)        |     36.6 |     39.3 |      37.9 |     103.7 |      — |        — |
| prepared scan, 100k points (ms)   |      6.7 |      4.5 |       4.5 |      14.3 |      — | 218.5 ¹  |
| WKB ingest, 20k polygons (ms)     |      8.0 |      3.1 |       4.5 |      17.7 |    — ² |        — |
| buffer, 100 geometries (ms)       |     12.4 |     12.3 |      12.0 |      19.3 |   17.9 |     65.2 |

¹ turf has no prepared mode, so this is its unprepared scan.
² JSTS has no WKB codec, so only WKT ingest is possible.

What I take from it:

- **On the heavy operations it lands where calling GEOS from C does.** Overlays,
  `makeValid`, and buffer are all within a few percent of direct C and of Shapely.
  That makes sense, because they all run the same GEOS and the actual work
  dominates the call overhead.
- **On small, fast operations the FFI crossing shows.** Prepared scans are 6.7 ms
  against 4.5 ms for direct C, and WKB ingest is 8.0 ms against 3.1 ms. When an
  operation takes microseconds, the cost of crossing the boundary is a real
  fraction of it. Raw decoding is faster still with a pure codec like wkx
  (2.5 ms), but that only gives you coordinates, not geometries you can run
  predicates on.
- **The batch APIs exist because of that.** `fromWKBMany` parses 20k WKB rows in
  one crossing, about 14× faster than going geometry by geometry. A naive JS scan
  that takes 491.7 ms drops to 4.6 ms behind the STRtree, about 107×. Both of
  those compare the library against itself rather than against other engines;
  the Benchmarks page spells out which results are which.
- **A worker pool helps with heavy batch work.** 100k `makeValid` calls finish in
  about 4.6× less wall time than on a single thread. None of the other engines
  have a pool, so there's nothing to compare against here. See
  [Workers](/guide/workers).
- **About turf:** its buffer was the one result out of 70 in the cross-library
  suite that disagreed with every other engine. That's because turf buffers
  geographically by design, not because it's wrong. I still count it as a
  mismatch because the suite compares raw answers, but it's worth knowing.

Machines differ, so treat the ratios as the useful part and rerun it yourself
with `bun run bench`. If a number doesn't reproduce for you, please open an issue.

## Other things in it

- **Batch-first API.** Predicate masks come back as `Uint8Array`, every operation
  has an element-wise `*All` form, and the heavy ones can run across workers
  through `geos.parallel.*` with chunking and `AbortSignal` support.
- **Repair tools.** `makeValid`, coverage union with a validated `"auto"`
  dispatch, and precision models.
- **Typed I/O.** WKT, WKB/EWKB, GeoJSON, and GeoArrow-shaped interchange.
  Malformed input throws a `GeosError` that names the `jsonPath`, ring, or byte
  at fault.

## What it isn't

- **Bun only, for now.** There's no Node.js support, no browser build, and no WASM
  build. If you need GEOS in a browser, use
  [geos-wasm](https://github.com/chrispahm/geos-wasm). On the Node side, things
  are changing: Node.js recently added an experimental native FFI, the
  [`node:ffi`](https://nodejs.org/dist/latest/docs/api/ffi.html) module (first
  shipped in Node 26.1). When it becomes more stable, I'll try to create a Node.js
  alternative (`@shzd/node-geos`) or an adapter inside bun-geos.
- **Planar only.** GEOS knows nothing about the curvature of the Earth. If your
  data is lat/lon, project it to a planar CRS first (for example with
  [proj4](https://github.com/proj4js/proj4js)). Passing degrees to `buffer()` and
  expecting meters is the classic geospatial mistake, and this library will give
  you a wrong answer without complaint.
- **No sharing across threads.** Use one `Geos` per thread. Geometries can't
  cross threads, so move data between workers as WKB, GeoJSON, or Arrow copies.
- **Not battle-tested.** It's a young project by someone who isn't a GIS expert.
  The tests and the cross-engine answer checks give me reasonable confidence, but
  I wouldn't call it production-proven yet.

## Status and license

It's version 0.3.0. Until 1.0, a release with a breaking change or a new API bumps
the minor version, and fixes, perf work, and docs bump the patch. Everything is in
the [Changelog](/changelog).

`@shzd/bun-geos` is MIT. The bundled GEOS binaries are LGPL-2.1+, dynamically
linked, unmodified, and built from the pinned release tarball. The license text
and source link ship in every platform package, which is the same compliance model
Shapely's wheels and geos-wasm use.

## Where to go from here

| Page                                  | If you want to…                          |
|---------------------------------------|------------------------------------------|
| [Install & platforms](/install)       | get it running                           |
| [Quickstart](/quickstart)             | write some real code                     |
| [Benchmarks](/benchmarks)             | check my numbers                         |
| [Operations tour](/guide/overlays)    | see intersect, union, repair, hull, cluster |
| [API reference](/reference)           | look up a signature                      |

## Contributions, criticism, advice

This is my first library of this kind, and I'm still learning both the GIS side
and the FFI side. I'm open to pull requests, blunt criticism, and advice on the
API design, the benchmarks, the docs, or anything else that looks off. If you
know GEOS or GIS better than I do, I'd especially like to hear what I got wrong.

Bug reports, benchmark reproductions, and "this number looks wrong" issues are all
welcome on [the repository](https://github.com/AbdukahharS/bun-geos/issues).
