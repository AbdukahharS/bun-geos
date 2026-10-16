# Operations: licensing

> Status: **IMPLEMENTED (Phase 4)** — compliance is mechanized: the pinned
> tarball + SHA-256 lives in `scripts/native/lib.ts`; every platform
> package ships the verbatim LGPL-2.1 `LICENSE` + generated `THIRD_PARTY.md`
> (`scripts/package-platform.ts`); `scripts/native/licensing-check.ts` runs
> the §4 checklist's dynamic-linking and no-static-symbols checks in CI on
> every target. GEOS is licensed LGPL-2.1+ (the npm metadata
> of geos-wasm records LGPL-3.0-or-later; the GEOS source tree ships LGPL-2.1 — we comply
> with both ends of the "+" and credit accordingly).

## 1. Why this is legally boring (if done exactly as written here)

`@shzd/bun-geos` **dynamically links** an **unmodified** GEOS build, distributed as
separate binaries. Under LGPL-2.1 §6(dynamic) this is the standard "aggregate works with
the library" case: the LGPL covers the library; the application's own code stays MIT.
This is precisely the model already used at scale by:

- **Shapely** — its PyPI wheels bundle `libgeos` inside the wheel;
- **geos-wasm** — distributes a compiled GEOS in an npm package;
- **Julia's `GEOS_jll`** — distributes prebuilt GEOS binaries per platform;
- effectively **every OS distribution** that ships PostGIS/QGIS.

## 2. What each platform package must contain

| File | Purpose |
|------|---------|
| `shim.<so\|dylib\|dll>` | our code (MIT) — links GEOS dynamically |
| `libgeos` + `libgeos_c` | unmodified GEOS 3.14.x binaries, built from the official tagged source |
| `LICENSE` | verbatim LGPL-2.1 text (plus LGPL-3.0 notice if the build ever claims 3.0-or-later) |
| `THIRD_PARTY.md` | attribution, exact GEOS version + source URL + commit/tag, build flags, SHA-256 of the source tarball |
| (source offer) | link to the exact upstream tag — satisfies §6(a)'s source-availability for LGPL'd binaries we distribute |

**Never do:** static-link GEOS into the shim (triggers §6's object-file/relink
obligations for zero benefit — the shim is 300 lines and GEOS's compiled units do the
real work); modify GEOS sources for the build (if a patch ever becomes necessary, the
patch must be published alongside under the LGPL).

## 3. License split

| Code | License |
|------|---------|
| `@shzd/bun-geos` TS + `shim.c` | **MIT** (planned — confirm before first publish) |
| Bundled GEOS binaries | LGPL-2.1+ (covered by the files above, per platform package) |
| Anything else | nothing — the dependency tree of the *native* side is exactly GEOS |

## 4. Compliance checklist (per release, per platform package)

- [ ] Binaries built from the official unmodified GEOS tag; tarball hash recorded in `THIRD_PARTY.md`
- [ ] Dynamically linked only (`otool -L` / `ldd` / `dumpbin /dependents` spot check in CI)
- [ ] Verbatim LGPL license text shipped
- [ ] Source link (exact tag) shipped
- [ ] Own code notice (MIT) present in main package
- [ ] No GEOS symbols statically present in the shim binary
