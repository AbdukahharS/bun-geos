# Geometry I/O

Four formats in, four formats out: WKT, WKB/EWKB, GeoJSON, and GeoArrow-shaped
values — the binary and text paths are a single FFI crossing each, and GeoJSON is
parsed in JS with per-part crossings so its errors can point at the exact spot.
Malformed input throws a `GeosError` with structural detail — a `jsonPath` or ring
number — never a bare "parse failed".

Everything here is a method on `Geos`; every geometry you get back is an owned
[`Geometry`](/guide/memory).

## WKT — the debug format

```ts
const g = geos.fromWKT("MULTIPOLYGON (((0 0, 4 0, 4 4, 0 4, 0 0)))");
const text = geos.toWKT(g); // trimmed, Shapely-2 style: "POINT (0 0)" — no 16-digit noise
```

`toWKT` options (all optional):

| Option | Default | Meaning |
|--------|---------|---------|
| `precision` | full | max digits after the decimal point |
| `trim` | `true` | drop trailing zeros |
| `outputDimension` | `2` | `2`, `3` (Z), `4` (ZM) |
| `old3D` | `false` | `POINT Z (…)` vs `POINT Z(…)` |

Malformed WKT throws a `GeosError` carrying the GEOS parser message verbatim.

## WKB / EWKB — the interchange bytes

```ts
const bytes = geos.toWKB(g);            // Uint8Array — always a copy, never C memory
const g2  = geos.fromWKB(bytes);
```

The reader accepts **ISO WKB and PostGIS EWKB**; an embedded SRID rides along natively
(see [SRIDs](#srids)). The writer always copies at the boundary — a returned
`Uint8Array` never aliases C memory, so you can hold it across disposals without fear.

| `WKBOptions` | Default | Meaning |
|--------|---------|---------|
| `byteOrder` | native | `"little"` or `"big"` (`"big"` for stable goldens) |
| `outputDimension` | `2` | `2`, `3` (Z), `4` (ZM) |
| `flavor` | `"iso"` | `"iso"` (default, the "more standard" 3D) or `"extended"` (PostGIS EWKB) |
| `includeSRID` | `false` | embed the SRID — requires `flavor: "extended"` |

### Bulk ingest: `fromWKBMany`

Reading a PostGIS-scale dump one `fromWKB` at a time is N crossings. `fromWKBMany` is
**one**:

```ts
// wkb: one buffer; offsets[i] = end byte of geometry i (offsets[0] = end of the first)
const geoms = geos.fromWKBMany(wkb, offsets);
```

Rules the method enforces up front (as `RangeError`s — these are your bugs, not data
failures): offsets are strictly increasing and the last is ≤ `wkb.length`. Failures
mid-batch are **all-or-nothing** — you never get a half-parsed array.

## GeoJSON — the web format

```ts
const g = geos.fromGeoJSON({
  type: "Polygon",
  coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
});

// A Feature works too — geometry is what's taken:
const g3 = geos.fromGeoJSON({ type: "Feature", geometry: { type: "Point", coordinates: [1, 2] }, properties: {} });

const out = geos.toGeoJSON(g); // GeoJSON geometry object
```

Details that matter:

- Positions are 2–4 finite numbers; dimension is inferred from length (2=XY, 3=XYZ,
  4=XYZM). Anything else throws a `GeosError` with the offending `jsonPath`.
- Structural problems name the exact spot:
  `GEOS fromGeoJSON failed: expected a finite number (at geometry.coordinates[0][2][1])`.
- Ring-level violations carry the ring number alongside the path:
  `… (at geometry.coordinates[0], ring 0)`.
- `toGeoJSON(g, { includeZ })` — Z is kept as 3-length positions by default; pass
  `includeZ: false` to force 2-length.

## GeoArrow — the columnar format

`fromArrow`/`toArrow` speak the [GeoArrow](https://geoarrow.org) memory layouts as
plain typed-array values — no Arrow library required. Tagged by `kind`
(`geoarrow.point`, `geoarrow.polygon`, …):

```ts
import { Geos } from "@shzd/bun-geos";

using geos = new Geos();

// geoarrow.polygon: interleaved coords + ring offsets (end-indices)
using poly = geos.fromArrow({
  kind: "polygon",
  coords: Float64Array.of(0,0, 4,0, 4,4, 0,4, 0,0),
  ringOffsets: Int32Array.of(5),
  hasZ: false,
  hasM: false,
});

const arr = geos.toArrow(poly); // tagged value, same shape vocabulary
```

- **Validity bitmaps**: batch shapes carry an Arrow LSB `validity` bitmap
  (1 = non-null slot, absent = all-valid). A null slot on read throws a `GeosError`
  naming the slot.
- **Legacy shapes accepted**: the older untagged forms (`FlatCoords`, `LineArray`,
  `Polygonal`) are still accepted as input, inferred by shape. `toArrow` emits only
  tagged values.
- **Collections**: `geometrycollection` is the dense-union emulation — slot i lives in
  child `types[i]` at position `offsets[i]`.
- Conformance is pinned byte-for-byte against the reference implementation in this
  library's own test suite — round-trips are real, not aspirational.

## Building geometry directly

Skip text entirely when you already have coordinates:

```ts
const p  = geos.point(1, 2);                        // POINT (1 2) — z/m optional
const l  = geos.fromCoords({                         // linestring from interleaved XY
  coords: Float64Array.of(0,0, 1,1, 2,0),
  n: 3, hasZ: false, hasM: false,
});
using poly = geos.fromPolygonal({                    // polygon/multipolygon from rings
  coords: Float64Array.of(0,0, 4,0, 4,4, 0,4, 0,0),
  ringOffsets: Int32Array.of(5),
  partOffsets: Int32Array.of(1),                     // length 1 → single polygon
  hasZ: false, hasM: false,
});
const gc  = geos.fromParts("geometrycollection", [p, l]);
const e   = geos.empty("linestring");
```

And the accessor side: `geos.coordinates(g)` returns the flat interleaved
`{ coords, n, hasZ, hasM }` view — the fastest path back to raw numbers.

## SRIDs

GEOS geometries carry an SRID slot; this library reads and writes it honestly:

```ts
const withSrid = geos.fromWKB(ewkbBytes); // EWKB SRID rides in
console.log(withSrid instanceof Geometry && geos.srid(withSrid)); // e.g. 32633
geos.setSrid(withSrid, 32633);
const ewkb = geos.toWKB(withSrid, { flavor: "extended", includeSRID: true });
```

**The SRID is a label, not a transformation.** Nothing reprojects; it round-trips
through EWKB so your data stays labeled. The planar-CRS rule from the
[front page](/) still governs everything.

## Where to next

- [Overlays & operations](/guide/overlays) — what to do with the geometry now
- [Errors](/guide/errors) — the full error taxonomy behind those `jsonPath`s
- [Memory & disposal](/guide/memory) — who owns what you just parsed
