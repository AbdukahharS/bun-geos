/*
 * bun-geos C shim — Phase 1 surface.
 *
 * Two responsibilities, per docs/design/shim.md (D4):
 *
 * 1. Install GEOS's *variadic* error/notice handlers — the one thing pure
 *    bun:ffi cannot do at all. Messages are captured into thread-local
 *    buffers; the JS side reads them via geos_shim_last_error/last_notice
 *    and turns them into thrown GeosErrors (D13).
 * 2. Absorb everything loop-shaped (the Shapely-2.0 lesson): batch geometry
 *    builders that walk offsets in C, and arena bulk destruction. What is
 *    not loop-shaped, handler-shaped, or ownership-tricky stays in TS.
 *
 * Rules (shim.md §2): every export uses only bun:ffi-declarable C ABI types;
 * nothing throws across the FFI boundary; every failure path stores a
 * thread-local message and returns NULL/0; the shim never leaks what it
 * allocates. Offset arguments are element counts, never bytes.
 *
 * (cc()/TinyCC was once considered as the dev fallback for this file; it is
 * dropped — Bun's embedded TCC rejects the __thread state below, and
 * thread-local capture is load-bearing. See shim.md §4 and spike-results F7.)
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

/* Minimal inline prototypes so this file compiles without GEOS headers
 * present (docs/design/shim.md §4). Matches geos_c.h.
 * Only the functions the shim itself calls are declared here — everything
 * else is bound in TS (src/symbols.ts) against the same shared library. */
typedef void *GEOSContextHandle_t;
typedef struct GEOSCoordSequence GEOSCoordSequence;
typedef struct GEOSGeometry GEOSGeometry;
typedef void (*GEOSMessageHandler_r)(const char *fmt, ...);

extern GEOSContextHandle_t GEOS_init_r(void);
extern void GEOS_finish_r(GEOSContextHandle_t handle);
extern void GEOSContext_setErrorHandler_r(GEOSContextHandle_t handle, GEOSMessageHandler_r handler);
extern void GEOSContext_setNoticeHandler_r(GEOSContextHandle_t handle,
                                           GEOSMessageHandler_r handler);

extern GEOSCoordSequence *GEOSCoordSeq_copyFromBuffer_r(GEOSContextHandle_t handle,
                                                        const double *buf, unsigned int size,
                                                        int hasZ, int hasM);
extern void GEOSCoordSeq_destroy_r(GEOSContextHandle_t handle, GEOSCoordSequence *s);
extern GEOSGeometry *GEOSGeom_createLinearRing_r(GEOSContextHandle_t handle, GEOSCoordSequence *s);
extern GEOSGeometry *GEOSGeom_createLineString_r(GEOSContextHandle_t handle, GEOSCoordSequence *s);
extern GEOSGeometry *GEOSGeom_createPolygon_r(GEOSContextHandle_t handle, GEOSGeometry *shell,
                                              GEOSGeometry **holes, unsigned int nholes);
extern GEOSGeometry *GEOSGeom_createCollection_r(GEOSContextHandle_t handle, int type,
                                                 GEOSGeometry **geoms, unsigned int ngeoms);
extern void GEOSGeom_destroy_r(GEOSContextHandle_t handle, GEOSGeometry *g);

#define SHIM_MSG_MAX 1024

static __thread char t_error[SHIM_MSG_MAX];
static __thread char t_notice[SHIM_MSG_MAX];
static __thread int t_has_error = 0;
static __thread int t_has_notice = 0;

/* GEOS invokes these with printf-style fmt+args; only the shim side ever
 * touches varargs (it is the callee, compiled by a real C compiler). */
static void shim_error_handler(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(t_error, sizeof(t_error), fmt, ap);
  va_end(ap);
  t_has_error = 1;
}

static void shim_notice_handler(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(t_notice, sizeof(t_notice), fmt, ap);
  va_end(ap);
  t_has_notice = 1;
}

typedef struct GeosShim {
  GEOSContextHandle_t ctx;
} GeosShim;

/* GEOS_init_r + install handlers. Returns NULL only on malloc failure. */
GeosShim *geos_shim_init(void) {
  GeosShim *shim = (GeosShim *)malloc(sizeof(GeosShim));
  if (!shim)
    return NULL;
  shim->ctx = GEOS_init_r();
  GEOSContext_setErrorHandler_r(shim->ctx, shim_error_handler);
  GEOSContext_setNoticeHandler_r(shim->ctx, shim_notice_handler);
  return shim;
}

/* The GEOS context for THIS shim. JS must pass this handle to every geos_c
 * function — never the GeosShim* itself (the wrapper is opaque bookkeeping;
 * treating it as a context reads garbage and eventually segfaults). */
GEOSContextHandle_t geos_shim_context(GeosShim *shim) { return shim ? shim->ctx : NULL; }

void geos_shim_finish(GeosShim *shim) {
  if (!shim)
    return;
  GEOS_finish_r(shim->ctx);
  free(shim);
}

/* Last error message on this thread, or NULL. Consumed on read (D13:
 * one GEOS failure → one thrown GeosError; no stale messages). */
const char *geos_shim_last_error(GeosShim *shim) {
  (void)shim;
  if (!t_has_error)
    return NULL;
  t_has_error = 0;
  return t_error;
}

/* Last notice, or NULL. Same consume-on-read rule. */
const char *geos_shim_last_notice(GeosShim *shim) {
  (void)shim;
  if (!t_has_notice)
    return NULL;
  t_has_notice = 0;
  return t_notice;
}

/* Store a shim-side (non-GEOS) failure message into thread-local state, with
 * the same contract the GEOS handlers follow, so JS error handling is
 * uniform: op returned NULL -> read last_error -> throw GeosError. */
static void shim_set_error(const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(t_error, sizeof(t_error), fmt, ap);
  va_end(ap);
  t_has_error = 1;
}

/* ============ Batch builders (the loop-shaped surface, D4) ============ */

/*
 * Build a linestring from n interleaved coordinates in one FFI crossing.
 * `xy` holds n × (2 + hasZ + hasM) doubles. Returns NULL on failure with the
 * message captured thread-locally.
 */
GEOSGeometry *geos_shim_build_linestring(GeosShim *shim, const double *xy, unsigned int n, int hasZ,
                                         int hasM) {
  if (!shim || !xy || n == 0) {
    shim_set_error("build_linestring: invalid arguments (shim=%p xy=%p n=%u)", (void *)shim,
                   (const void *)xy, n);
    return NULL;
  }
  GEOSCoordSequence *cs = GEOSCoordSeq_copyFromBuffer_r(shim->ctx, xy, n, hasZ, hasM);
  if (!cs)
    return NULL; /* GEOS already invoked the error handler */
  GEOSGeometry *g = GEOSGeom_createLineString_r(shim->ctx, cs);
  if (!g) {
    /* createLineString takes the coordseq via unique_ptr BEFORE constructing;
     * on failure GEOS has consumed it — do not destroy (double free). */
    return NULL;
  }
  return g;
}

/*
 * Build a polygon from concatenated rings in one FFI crossing.
 * `xy` holds every ring's coordinates back to back; `ringOffsets` holds
 * nrings end-indices into coordinate space (ring i spans
 * [offsets[i-1], offsets[i]), offsets[-1] = 0). Ring 0 is the shell, the
 * rest are holes. GEOS consumes every ring it accepts; this function frees
 * everything it allocated on the failure path.
 */
GEOSGeometry *geos_shim_build_polygon(GeosShim *shim, const double *xy,
                                      const unsigned int *ringOffsets, unsigned int nrings,
                                      int hasZ, int hasM) {
  if (!shim || !xy || !ringOffsets || nrings == 0) {
    shim_set_error("build_polygon: invalid arguments (shim=%p xy=%p offsets=%p nrings=%u)",
                   (void *)shim, (const void *)xy, (const void *)ringOffsets, nrings);
    return NULL;
  }
  if (ringOffsets[0] == 0) {
    shim_set_error("build_polygon: ringOffsets[0] must be > 0 (got 0)");
    return NULL;
  }
  for (unsigned int i = 1; i < nrings; i++) {
    if (ringOffsets[i] <= ringOffsets[i - 1]) {
      shim_set_error("build_polygon: ringOffsets not strictly increasing at %u (%u <= %u)", i,
                     ringOffsets[i], ringOffsets[i - 1]);
      return NULL;
    }
  }

  /* Rings are handed to GEOS one by one: createLinearRing consumes the
   * coordseq on success; the polygon consumes all rings on success. */
  GEOSGeometry **rings = (GEOSGeometry **)malloc(nrings * sizeof(GEOSGeometry *));
  if (!rings) {
    shim_set_error("build_polygon: out of memory");
    return NULL;
  }
  const int dim = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  unsigned int start = 0;
  for (unsigned int i = 0; i < nrings; i++) {
    unsigned int count = ringOffsets[i] - start;
    /* Offsets are in coordinate space; the buffer is interleaved, so ring i's
     * data starts at double index start * dim. */
    GEOSCoordSequence *cs =
        GEOSCoordSeq_copyFromBuffer_r(shim->ctx, xy + (size_t)start * dim, count, hasZ, hasM);
    if (!cs) {
      for (unsigned int j = 0; j < i; j++)
        GEOSGeom_destroy_r(shim->ctx, rings[j]);
      free(rings);
      return NULL; /* GEOS message already captured */
    }
    GEOSGeometry *ring = GEOSGeom_createLinearRing_r(shim->ctx, cs);
    if (!ring) {
      /* Same GEOS quirk as below: the coordseq moved into a unique_ptr
       * before the ring was constructed; on failure it is consumed. */
      for (unsigned int j = 0; j < i; j++)
        GEOSGeom_destroy_r(shim->ctx, rings[j]);
      free(rings);
      return NULL;
    }
    rings[i] = ring;
    start = ringOffsets[i];
  }

  GEOSGeometry *shell = rings[0];
  GEOSGeometry **holes = nrings > 1 ? &rings[1] : NULL;
  GEOSGeometry *poly = GEOSGeom_createPolygon_r(shim->ctx, shell, holes, nrings - 1);
  if (!poly) {
    /* GEOS QUIRK (same class as createCollection, verified against
     * geos_ts_c.cpp): shell and holes are moved into unique_ptrs BEFORE the
     * polygon is constructed, so on ANY failure — an unclosed ring throws —
     * GEOS has already consumed and freed them. Only the ring array (ours)
     * is freed here; destroying the rings again would be a double free. */
    free(rings);
    return NULL;
  }
  /* "Collections take contents, not the array" (geos research §4): the ring
   * array is ours; GEOS owns the rings now. */
  free(rings);
  return poly;
}

/*
 * Build a homogeneous or heterogeneous collection in one FFI crossing.
 * `parts` are n GEOSGeometry pointers (JS-side array, e.g. a BigUint64Array);
 * on success GEOS takes ownership of every part but NOT of the array (the
 * JS GC frees it). GEOS QUIRK (verified against geos_ts_c.cpp): the parts
 * are moved into an internal unique_ptr vector BEFORE the type switch, so on
 * ANY failure — including an unsupported typeId — GEOS has already consumed
 * and freed them. The shim therefore must NOT destroy parts on the failure
 * path (doing so is a double free / SIGSEGV).
 */
GEOSGeometry *geos_shim_build_collection(GeosShim *shim, int typeId, GEOSGeometry **parts,
                                         unsigned int n) {
  if (!shim || (!parts && n > 0)) {
    shim_set_error("build_collection: invalid arguments (shim=%p parts=%p n=%u)", (void *)shim,
                   (void *)parts, n);
    return NULL;
  }
  /* Failure (NULL) leaves the parts owned-and-freed by GEOS; nothing to do. */
  return GEOSGeom_createCollection_r(shim->ctx, typeId, parts, n);
}

/*
 * Arena teardown: destroy n geometries in one FFI crossing (D10).
 * Frees the geometries ONLY — the pointer array is JS-owned (GC frees it).
 * (shim.md's "frees the pointer array" wording applies to arrays the shim
 * itself allocated, e.g. strtree query results in Phase 2; here the caller
 * owns the array.)
 */
void geos_shim_destroy_many(GeosShim *shim, GEOSGeometry **geoms, unsigned int n) {
  if (!shim || !geoms)
    return;
  for (unsigned int i = 0; i < n; i++) {
    if (geoms[i])
      GEOSGeom_destroy_r(shim->ctx, geoms[i]);
  }
}
