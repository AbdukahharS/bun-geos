# Research: the GEOS engine

> Status: reference. Facts here were verified against [libgeos.org](https://libgeos.org)
> (C API programming guide, FAQ, release posts) in October 2026. This is the contract our
> binding must respect — every design doc traces back to something on this page.

## 1. What GEOS is

GEOS (Geometry Engine Open Source) is a C/C++ computational-geometry library implementing
the OGC Simple Features model. It began as a direct C++ port of the
[JTS Topology Suite](https://github.com/locationtech/jts) and remains tightly synced with it
(the two projects **share their test corpus** — this matters for our testing strategy).
It is the geometry engine inside PostGIS, QGIS, GDAL, Shapely, R `sf`, and DuckDB spatial.

Capabilities relevant to this project: the full Simple Features geometry model and
predicates; overlay/boolean operations; prepared geometry (internal spatial indexes);
the STR (Sort-Tile-Recursive) packed R-tree; WKT/WKB/GeoJSON readers and writers.

**License:** LGPL-2.1+. Compliance model: [licensing](../operations/licensing.md).

## 2. The C API is the only binding surface

- The **C API** (`geos_c.h`, `libgeos_c`) promises *stable API and stable ABI* — new GEOS
  binaries drop in without rebuilding dependents.
- The **C++ API** is explicitly unstable: "may have changes in every release" (GEOS FAQ).

Every mature binding wraps the C API. We bind to `libgeos_c` only (D2).

## 3. The reentrant (thread-safe) API

Every function exists in two forms:

```c
GEOSGeometry* GEOSIntersection(GEOSGeometry* a, GEOSGeometry* b);            // global state
GEOSGeometry* GEOSIntersection_r(GEOSContextHandle_t ctx,
                                 GEOSGeometry* a, GEOSGeometry* b);          // reentrant
```

- The `GEOSContextHandle_t` carries thread-local state (memory arena bookkeeping, the
  installed message handlers). Created with `GEOS_init_r()`, released with `GEOS_finish_r()`.
- **Each thread that touches GEOS must have its own context.** We use `_r` exclusively,
  one handle per JS thread (D3).
- Geometries belong to the context that created them; they must be destroyed by the same
  context. This is why Worker isolation rules exist (D11).

## 4. Object model and ownership rules

The two core objects are `GEOSCoordSequence` and `GEOSGeometry`.

| Rule | Detail |
|------|--------|
| Explicit destruction | Everything created by a `GEOS*Create*`/`*read*`/`*write*` function must be destroyed by its matching destructor (`GEOSGeom_destroy`, `GEOSWKTReader_destroy`, …). |
| `GEOSFree`, never `free` | Memory GEOS allocated (e.g. WKT output strings) must be freed with `GEOSFree` — the allocating and freeing CRT must match, which matters most on Windows. |
| Transfer on create | `GEOSGeom_createPoint/LineString/LinearRing` **take ownership** of the coord sequence; destroying the geometry frees it. |
| Collections | `GEOSGeom_createPolygon/createCollection` take ownership of the *contained* objects but **not** the array holding them — the array must be freed by the caller. |
| Readers/writers are separate objects | Created, used, destroyed independently of the geometries they produce/consume. |
| STRtree items are borrowed | `GEOSSTRtree_insert(tree, geom, item)` stores raw pointers; the tree takes no ownership. A tree that outlives freed geometries is a use-after-free — our JS-side id registry exists because of this rule. |

## 5. Coordinate marshaling — the golden path

```c
GEOSCoordSequence* GEOSCoordSeq_copyFromBuffer(const double* buf,
                                               unsigned int size,
                                               int hasZ, int hasM);
int GEOSCoordSeq_copyToBuffer(GEOSCoordSequence* seq, double* buf,
                              int hasZ, int hasM);
```

`buf` is interleaved coordinates: `X Y [Z [M]] × size`. This is:

- **one FFI call** per coordinate sequence in each direction,
- directly fed by / into a JS `Float64Array` (zero-copy pointer passing),
- **the same layout as GeoArrow coordinate buffers** (see [io design](../design/io.md)).

Per-coordinate accessors (`GEOSCoordSeq_setX`, `getOrdinate`, …) exist but are the
anti-pattern at scale — one FFI crossing per number.

## 6. Error and interrupt protocol

- On failure, C API functions return `NULL` (pointer returns) or `0` (int returns) and
  invoke the context's installed handlers:
  - notice handler: `void(*)(const char* fmt, ...)`
  - error handler: `void(*)(const char* fmt, ...)`
- **The handlers are variadic.** This is the single hardest constraint on a pure-FFI
  binding: variadic function pointers cannot be declared in `bun:ffi`, and passing a
  non-variadic function where a variadic one is invoked is undefined behavior (on x86-64
  SysV the caller must set `%al` for variadic calls). → the C shim installs real variadic
  handlers that stash the formatted message in a thread-local buffer
  ([shim](../design/shim.md)).
- Long operations can be cancelled cooperatively via `GEOSInterruptCallback`
  (`void(*)(void)`) + `GEOS_interrupt_request()` — a signature `bun:ffi` *can* express;
  we wire it to `AbortSignal` (D11).

## 7. Prepared geometry

`GEOSPrepare(geom)` → `const GEOSPreparedGeometry*` — an indexed structure analogous to a
prepared statement. Repeated predicate calls (`GEOSPreparedIntersects`, `…Contains`,
`…Covers`, …) against it are dramatically faster. Destroy with
`GEOSPreparedGeom_destroy` — a separate lifetime from the source geometry.

Since **3.13 (RelateNG)**, every predicate — and the full DE-9IM matrix via
`GEOSPreparedRelate` / `GEOSPreparedRelatePattern` — is available in prepared form, with
short-circuit speedups even unprepared.

## 8. STRtree

```c
GEOSSTRtree* tree = GEOSSTRtree_create(10);      // 10 = node capacity (recommended default)
GEOSSTRtree_insert(tree, geom, item);            // item = void* we choose (we use ids)
GEOSSTRtree_query(tree, queryGeom, callback, userdata);
GEOSSTRtree_nearest_generic(tree, item, geom, distCallback, userdata);
```

Bounds are computed from the inserted geometry. Query returns *candidates* (envelope
intersection) — exact filtering is the caller's job (prepared predicates slot in here).
The query callback is per-candidate → collected by the shim into a preallocated array
instead of crossing into JS per hit (D4).

## 9. Version feature map

Everything in this table is assumed available — we ship GEOS 3.14 (D5).

| GEOS | Year | Features this project relies on |
|------|------|--------------------------------|
| 3.10 | 2021 | **OverlayNG + OverlayNGRobust** — the standard overlay ops now self-heal near-degenerate inputs via snapping heuristics instead of failing; `GEOSMakeValidWithParams` (linework vs structure method, keep-collapsed) |
| 3.11 | 2022 | Concave hulls; GeoJSON reader/writer; offset-curve rework |
| 3.12 | 2023 | **Coverage ops**: `CoverageUnion` (orders-of-magnitude union for aligned polygonal coverages), `CoverageIsValid`, `CoverageSimplifyVW`; `DisjointSubsetUnion`; M-dimension support; `GEOSSTRtree_build`; Voronoi; `GEOSOrientPolygons`; `GEOSEqualsIdentical` |
| 3.13 | 2024 | **RelateNG** — rewritten predicate engine: all predicates + full DE-9IM available *prepared*, short-circuit speedups; ISO SQL/MM curve types (create/read/write) |
| 3.14 | 2025 | **`GEOSCoverageClean(WithParams)`** — remove small gaps/overlaps in polygonal coverages, with tolerance and gap-removal heuristics (longest-border / max-area / min-area); C-API clustering (`GEOSClusterDBSCAN` + geometry/envelope distance/intersects variants); `GEOSGridIntersectionFractions`; `GEOSCoordSeq_hasZ/hasM/getM/setM`; `GEOSGeoJSONWriter_setOutputDimension`; `GEOSIsSimpleDetail` (locates self-intersections — used in our repair diagnostics) |

Distribution context (why bundling is mandatory, D6): Ubuntu 24.04 ships GEOS 3.12,
Debian 12 ships 3.11, Homebrew ships 3.14. No common distro ships 3.14.

## 10. Semantics gotchas (document loudly or they become issues)

1. **Planar, Cartesian, 2D only.** No geodetic/ellipsoidal math (GEOS FAQ is explicit).
   Users coming from turf will buffer in degrees and get garbage. Docs must say: *project
   to a planar CRS first*.
2. **IEEE-754 robustness.** `intersects(intersection(A, B), A)` can legitimately be `false`;
   interpolated points rarely lie *exactly* on a line. Not a bug — finite precision. The
   real tools are OverlayNGRobust (automatic since 3.10) and the precision model
   (`GEOSGeom_setPrecision`, `*Prec` overlay variants), which we expose first-class.
3. **Empty geometries** are typed but quirky (the Shapely 1.x saga: `Polygon()` producing
   `GEOMETRYCOLLECTION EMPTY`; empty points serialized as `POINT (NaN NaN)` in WKB).
   Shapely 2.0's fix — typed, consistent empties — is our target behavior.
4. **Ring orientation.** GEOS has `GEOSOrientPolygons` for a reason; GeoJSON (RFC 7946)
   recommends right-hand-rule exterior rings. We preserve input order and expose an
   explicit orient helper rather than silently normalizing.
5. **Z/M preservation is best-effort.** GEOS retains Z/M through I/O and many ops but
   documents no guarantee through every computation. We surface `hasZ/hasM` (3.14 accessors)
   and document per-op behavior honestly.

## 11. Testing gift

GEOS and JTS share their test corpus (the `xmltester` XML suite: thousands of
overlay/predicate cases with expected results). We run it as a differential gate —
see [testing strategy](../operations/testing.md).
