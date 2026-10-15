# Design: the C shim

> Status: **load-bearing slice proven in the Phase 0 spike** (init/finish/context/
> last_error/last_notice — see [spike results](../research/spike-results.md)); the rest of
> this surface remains a design target. The shim is D4 in the
> [decision record](../decisions.md). It is the only C code in the repository and the
> only place where `bun:ffi`'s limits are engineered around.

## 1. Why a shim is mandatory (not an optimization)

Four capabilities are **impossible or unsafe in pure `bun:ffi`**, independent of
performance:

1. **Variadic error/notice handlers.** `GEOSContext_setErrorHandler_r(ctx, handler)`
   takes `void(*)(const char* fmt, ...)`. `bun:ffi` cannot declare variadic function
   pointers, and invoking a non-variadic function through a variadic call site is
   undefined behavior (x86-64 SysV requires the caller to set `%al`). A binding with no
   shim either drops GEOS's error text entirely or invokes UB on the first error.
2. **Batch geometry construction.** From JS, building an n-ring polygon costs
   `n × (copyFromBuffer + createLinearRing)` + 1 `createPolygon` + an array allocation
   the caller must free — ~2n+1 FFI crossings and a manual `free`. All of it collapses
   into one shim call that walks offsets in C.
3. **STRtree query collection.** `GEOSSTRtree_query` invokes a callback per candidate.
   JSCallbacks are the least mature part of `bun:ffi`; per-candidate crossings would also
   be slow. The shim accepts a caller-provided output buffer and returns a count.
4. **Arena bulk destruction.** `destroy_many(GEOSGeometry**, n)` turns N `GEOSGeom_destroy`
   crossings into one, and frees the pointer array GEOS does not own (the
   "collections take contents, not the array" rule).

Plus one convenience with outsized value: an **interrupt flag** accessor implementing
`GEOSInterruptCallback` state so `AbortSignal` can cancel a running overlay.

## 2. Proposed surface (C, sketch)

```c
/* Thread-local state: last error/notice text, interrupt flag, per-context
 * bookkeeping for memory accounting. */
typedef struct GeosShim GeosShim;

GeosShim*     geos_shim_init(void);            /* GEOS_init_r + install handlers   */
void          geos_shim_finish(GeosShim*);     /* GEOS_finish_r + teardown          */
const char*   geos_shim_last_error(GeosShim*); /* NULL if none; consumed on read    */

/* Batch builders — offsets are element counts, not bytes. */
GEOSGeometry* geos_shim_build_linestring(GeosShim*, const double* xy,
                                         unsigned int n, int hasZ, int hasM);
GEOSGeometry* geos_shim_build_polygon(GeosShim*,
                                      const double* xy,   /* all rings, concatenated */
                                      const unsigned int* ringOffsets, unsigned int nrings,
                                      int hasZ, int hasM);
GEOSGeometry* geos_shim_build_collection(GeosShim*, int typeId,
                                         GEOSGeometry** parts, unsigned int n);

/* STRtree: items are integer ids we control; results land in the caller's buffer. */
unsigned int  geos_shim_strtree_query(GEOSSTRtree*, const GEOSGeometry* query,
                                      int64_t* out, unsigned int maxOut);

/* Arena teardown: frees the geoms AND the pointer array we allocated. */
void          geos_shim_destroy_many(GeosShim*, GEOSGeometry** geoms, unsigned int n);

/* Interrupt: pair of accessors the JS side flips from an AbortSignal listener. */
void          geos_shim_interrupt_request(void);
void          geos_shim_interrupt_reset(void);

/* Optional batch WKB codec (Phase 3). */
unsigned int  geos_shim_read_wkb_many(GeosShim*, const unsigned char* buf,
                                      const unsigned int* offsets, unsigned int n,
                                      GEOSGeometry** out);
```

Rules the code follows:

- Every exported function uses only C ABI types `bun:ffi` declares (`ptr`, `i32`, `u32`,
  `f64`, `usize`) — no structs, no varargs *across* the boundary (variadic handling stays
  *inside* the shim where the GEOS handlers are installed).
- The shim never allocates JS-visible memory; it allocates C memory it either transfers to
  GEOS (ownership rules) or frees itself.
- Every failure path stores a message in thread-local state and returns a sentinel;
  **nothing throws through the FFI boundary**.

## 3. What deliberately does *not* go in the shim

The shim is not a wrapper library. Predicates, overlay ops, buffer, measures, MakeValid,
CoverageClean, readers/writers (singular) — all plain `dlopen` symbols bound in TS. If a
function isn't loop-shaped, handler-shaped, or ownership-tricky, it does not belong in C.
This keeps the audited surface ~300 lines and the JS layer the place where behavior lives.

## 4. Build story

| Path | When | How |
|------|------|-----|
| **CI-prebuilt** (production) | Always, for supported platforms | Compiled with real clang/MSVC in the platform build jobs, linked against the bundled `libgeos_c`, stripped, shipped in the platform package. Link with `--disable-new-dtags` (DT_RPATH, not RUNPATH — RUNPATH is not transitive and will not resolve `libgeos.so` through the shim's own rpath; verified in Phase 0) |
| **System compiler, dev only** | Dev iteration | One gcc/clang line — see `spike/setup.sh`; Phase 1 wraps it as a `bun run build:native` script |
| ~~`cc()` / TinyCC~~ | **Dropped (Phase 0)** | Bun's embedded TCC cannot compile the shim: it rejects `__thread` ("thread-local storage is not supported at run time"), and thread-local capture is load-bearing (per-worker contexts, D3). Verified on linux-x64 Bun 1.4.3 |
| Pure FFI degraded mode | Not planned | Not pursued — the varargs handler makes honest pure-FFI impossible (§1.1); Phase 0 additionally showed a JSCallback handler receives only the `"%s"` format string, so pure FFI loses the message entirely |

TinyCC cannot compile C++ — irrelevant: the shim only uses the C API, and GEOS's own
compiled units do the heavy lifting. (It also cannot compile the shim's `__thread` usage at
all — see the build table above; that is why TinyCC is out entirely.)

## 5. Testing the shim

- **ASan/Valgrind** runs over the shim's test suite (ownership transfers, offset edge
  cases, empty rings, `destroy_many` on partially-built arrays).
- Unit tests assert error capture end-to-end: force a GEOS failure (e.g. malformed WKB),
  assert the thrown `GeosError` carries the GEOS message.
- Fuzz offsets/counts against the builders (property test: builder roundtrips equal
  per-ring construction).
