/*
 * bun-geos C shim — Phase 1 + Phase 2 surface.
 *
 * Two responsibilities, per docs/design/shim.md (D4):
 *
 * 1. Install GEOS's *variadic* error/notice handlers — the one thing pure
 *    bun:ffi cannot do at all. Messages are captured into thread-local
 *    buffers; the JS side reads them via geos_shim_last_error/last_notice
 *    and turns them into thrown GeosErrors (D13).
 * 2. Absorb everything loop-shaped (the Shapely-2.0 lesson): batch geometry
 *    builders that walk offsets in C, arena bulk destruction, and (Phase 2)
 *    prepared-predicate mask loops, STRtree query/nearest collection,
 *    union_all strategy dispatch, and bulk clones. What is not loop-shaped,
 *    handler-shaped, or ownership-tricky stays in TS.
 *
 * Rules (shim.md §2): every export uses only bun:ffi-declarable C ABI types;
 * nothing throws across the FFI boundary; every failure path stores a
 * thread-local message and returns NULL/0/negative; the shim never leaks
 * what it allocates. Offset arguments are element counts, never bytes.
 *
 * Phase 2 notes (decisions D16–D21 in docs/decisions.md):
 * - The interrupt flag is an ATOMIC GLOBAL, not thread-local: a synchronous
 *   FFI call blocks the JS thread, so only another thread can flip the flag
 *   mid-flight. The per-context GEOSContextInterruptCallback installed at
 *   init reads it at GEOS's own interruption points.
 * - STRtree items are integer ids ((void*)(intptr_t)id). GEOS's plain
 *   GEOSSTRtree_nearest dereferences items as geometry pointers, so nearest
 *   goes through nearest_generic with the shim's own C distance callback
 *   over an id -> geometry table the JS side binds at build() time.
 * - geos_shim_union_all dispatches CoverageUnion / DisjointSubsetUnion /
 *   UnaryUnion over a temporary GEOMETRYCOLLECTION of cloned inputs; the
 *   "coverage" strategy validates first (CoverageUnion on a non-coverage is
 *   silently wrong, not an error).
 *
 * (cc()/TinyCC was once considered as the dev fallback for this file; it is
 * dropped — Bun's embedded TCC rejects the thread-local state below, and
 * thread-local capture is load-bearing. See shim.md §4 and spike-results F7.)
 *
 * Phase 4 portability notes: the shim compiles under GCC/Clang (Linux glibc
 * + musl, macOS) and MSVC (win32-x64). GNU-isms are confined to the
 * SHIM_TLS / interrupt-flag macros near their definitions; Windows exports
 * (LoadLibrary + GetProcAddress need visible symbols) are listed in
 * native/shim.def, linked via /DEF: on the MSVC path.
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Minimal inline prototypes so this file compiles without GEOS headers
 * present (docs/design/shim.md §4). Matches geos_c.h.
 * Only the functions the shim itself calls are declared here — everything
 * else is bound in TS (src/symbols.ts) against the same shared library. */
typedef void *GEOSContextHandle_t;
typedef struct GEOSCoordSequence GEOSCoordSequence;
typedef struct GEOSGeometry GEOSGeometry;
typedef struct GEOSPreparedGeometry GEOSPreparedGeometry;
typedef struct GEOSSTRtree GEOSSTRtree;
typedef struct GEOSWKBReader GEOSWKBReader;
typedef struct GEOSBufferParams GEOSBufferParams;
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
extern GEOSGeometry *GEOSGeom_clone_r(GEOSContextHandle_t handle, const GEOSGeometry *g);
extern int GEOSGetNumGeometries_r(GEOSContextHandle_t handle, const GEOSGeometry *g);
extern const GEOSGeometry *GEOSGetGeometryN_r(GEOSContextHandle_t handle, const GEOSGeometry *g,
                                              int n);

/* Phase 2: interrupt (per-context callback), coverage unions, prepared
 * predicates, STRtree query/nearest, distance. */
typedef int GEOSContextInterruptCallback(void *);
extern GEOSContextInterruptCallback *GEOSContext_setInterruptCallback_r(
    GEOSContextHandle_t handle, GEOSContextInterruptCallback *cb, void *userData);

extern GEOSGeometry *GEOSCoverageUnion_r(GEOSContextHandle_t handle, const GEOSGeometry *g);
extern int GEOSCoverageIsValid_r(GEOSContextHandle_t handle, const GEOSGeometry *g, double gapWidth,
                                 GEOSGeometry **invalidEdges);
extern GEOSGeometry *GEOSDisjointSubsetUnion_r(GEOSContextHandle_t handle, const GEOSGeometry *g);
extern GEOSGeometry *GEOSUnaryUnion_r(GEOSContextHandle_t handle, const GEOSGeometry *g);

extern char GEOSPreparedIntersects_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                     const GEOSGeometry *g);
extern char GEOSPreparedContains_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                   const GEOSGeometry *g);
extern char GEOSPreparedContainsProperly_r(GEOSContextHandle_t handle,
                                           const GEOSPreparedGeometry *pg, const GEOSGeometry *g);
extern char GEOSPreparedCoveredBy_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                    const GEOSGeometry *g);
extern char GEOSPreparedCovers_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                 const GEOSGeometry *g);
extern char GEOSPreparedCrosses_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                  const GEOSGeometry *g);
extern char GEOSPreparedDisjoint_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                   const GEOSGeometry *g);
extern char GEOSPreparedOverlaps_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                   const GEOSGeometry *g);
extern char GEOSPreparedTouches_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                  const GEOSGeometry *g);
extern char GEOSPreparedWithin_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                 const GEOSGeometry *g);
extern char GEOSPreparedRelatePattern_r(GEOSContextHandle_t handle, const GEOSPreparedGeometry *pg,
                                        const GEOSGeometry *g, const char *im);

/* Phase 3 batch op layer: overlay/precision, unprepared predicates,
 * measures, buffer, batch WKB read, vertex counts, heap accounting. */
extern GEOSGeometry *GEOSIntersection_r(GEOSContextHandle_t, const GEOSGeometry *,
                                        const GEOSGeometry *);
extern GEOSGeometry *GEOSUnion_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern GEOSGeometry *GEOSDifference_r(GEOSContextHandle_t, const GEOSGeometry *,
                                      const GEOSGeometry *);
extern GEOSGeometry *GEOSSymDifference_r(GEOSContextHandle_t, const GEOSGeometry *,
                                         const GEOSGeometry *);
extern GEOSGeometry *GEOSIntersectionPrec_r(GEOSContextHandle_t, const GEOSGeometry *,
                                            const GEOSGeometry *, double);
extern GEOSGeometry *GEOSUnionPrec_r(GEOSContextHandle_t, const GEOSGeometry *,
                                     const GEOSGeometry *, double);
extern GEOSGeometry *GEOSDifferencePrec_r(GEOSContextHandle_t, const GEOSGeometry *,
                                          const GEOSGeometry *, double);
extern GEOSGeometry *GEOSSymDifferencePrec_r(GEOSContextHandle_t, const GEOSGeometry *,
                                             const GEOSGeometry *, double);

extern char GEOSIntersects_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSContains_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSCoveredBy_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSCovers_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSCrosses_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSDisjoint_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSOverlaps_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSTouches_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);
extern char GEOSWithin_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *);

extern int GEOSArea_r(GEOSContextHandle_t, const GEOSGeometry *, double *);
extern int GEOSLength_r(GEOSContextHandle_t, const GEOSGeometry *, double *);
extern int GEOSHausdorffDistance_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *,
                                   double *);
extern int GEOSFrechetDistance_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *,
                                 double *);

/* Phase 5 construction batch ops (D27): only what unary_call/binary_call
 * dispatch to — everything else stays bound in TS (src/symbols.ts). */
extern GEOSGeometry *GEOSConvexHull_r(GEOSContextHandle_t, const GEOSGeometry *);
extern GEOSGeometry *GEOSSimplify_r(GEOSContextHandle_t, const GEOSGeometry *, double);
extern GEOSGeometry *GEOSTopologyPreserveSimplify_r(GEOSContextHandle_t, const GEOSGeometry *,
                                                    double);
extern GEOSGeometry *GEOSGetCentroid_r(GEOSContextHandle_t, const GEOSGeometry *);
extern GEOSGeometry *GEOSBoundary_r(GEOSContextHandle_t, const GEOSGeometry *);
extern GEOSGeometry *GEOSPointOnSurface_r(GEOSContextHandle_t, const GEOSGeometry *);
extern GEOSGeometry *GEOSNode_r(GEOSContextHandle_t, const GEOSGeometry *);
extern GEOSGeometry *GEOSLineMerge_r(GEOSContextHandle_t, const GEOSGeometry *);
extern GEOSGeometry *GEOSClipByRect_r(GEOSContextHandle_t, const GEOSGeometry *, double, double,
                                      double, double);
extern GEOSGeometry *GEOSSnap_r(GEOSContextHandle_t, const GEOSGeometry *, const GEOSGeometry *,
                                double);
extern GEOSGeometry *GEOSSharedPaths_r(GEOSContextHandle_t, const GEOSGeometry *,
                                       const GEOSGeometry *);

extern GEOSGeometry *GEOSBufferWithParams_r(GEOSContextHandle_t, const GEOSGeometry *,
                                            const GEOSBufferParams *, double);
extern GEOSGeometry *GEOSWKBReader_read_r(GEOSContextHandle_t, GEOSWKBReader *reader,
                                          const unsigned char *wkb, size_t size);
extern int GEOSGeomGetNumPoints_r(GEOSContextHandle_t, const GEOSGeometry *);
extern int GEOSGeom_getCoordinateDimension_r(GEOSContextHandle_t, const GEOSGeometry *);
extern int GEOSGeomTypeId_r(GEOSContextHandle_t, const GEOSGeometry *);
extern const GEOSGeometry *GEOSGetExteriorRing_r(GEOSContextHandle_t, const GEOSGeometry *);
extern int GEOSGetNumInteriorRings_r(GEOSContextHandle_t, const GEOSGeometry *);
extern const GEOSGeometry *GEOSGetInteriorRingN_r(GEOSContextHandle_t, const GEOSGeometry *, int);
extern char GEOSisEmpty_r(GEOSContextHandle_t, const GEOSGeometry *);

typedef void (*GEOSQueryCallback)(void *item, void *userdata);
typedef int (*GEOSDistanceCallback)(const void *item1, const void *item2, double *distance,
                                    void *userdata);
extern void GEOSSTRtree_query_r(GEOSContextHandle_t handle, GEOSSTRtree *tree,
                                const GEOSGeometry *g, GEOSQueryCallback callback, void *userdata);
extern const void *GEOSSTRtree_nearest_generic_r(GEOSContextHandle_t handle, GEOSSTRtree *tree,
                                                 const void *item, const GEOSGeometry *itemEnvelope,
                                                 GEOSDistanceCallback distancefn, void *userdata);
extern int GEOSDistance_r(GEOSContextHandle_t handle, const GEOSGeometry *g1,
                          const GEOSGeometry *g2, double *d);

#define SHIM_MSG_MAX 1024

/* Thread-local storage, portably (Phase 4: the shim ships precompiled per
 * platform, including win32-x64 built with MSVC):
 * - MSVC's C compiler has no `__thread` and no usable C11 `_Thread_local`
 *   in its default mode — `__declspec(thread)` is the supported spelling;
 * - GCC/Clang spell it `__thread` (pre-C11-compatible everywhere we build);
 * - anything else C11 gets `_Thread_local`.
 * The capture buffers are load-bearing (per-worker contexts, D3) — there is
 * no TLS-free build of this shim (the cc()/TinyCC lesson, spike-results F7).
 */
#if defined(_MSC_VER)
#define SHIM_TLS __declspec(thread)
#elif defined(__GNUC__) || defined(__clang__)
#define SHIM_TLS __thread
#else
#define SHIM_TLS _Thread_local
#endif

static SHIM_TLS char t_error[SHIM_MSG_MAX];
static SHIM_TLS char t_notice[SHIM_MSG_MAX];
static SHIM_TLS int t_has_error = 0;
static SHIM_TLS int t_has_notice = 0;

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

/* Interrupt callback (defined in the Phase 2 section below); installed by
 * geos_shim_init. */
static int shim_interrupt_callback(void *userdata);

/* One-polygon builder shared by geos_shim_build_polygon and the Phase 3
 * polygonal bulk builder (defined below the batch builders). */
static GEOSGeometry *build_one_polygon(GeosShim *shim, const double *xy,
                                       const unsigned int *ringOffsets, unsigned int ringLo,
                                       unsigned int ringHi, int hasZ, int hasM);

/* Destroy out[0..count) — partial batch results — and null the slots
 * (Phase 3 batch-loop discipline: all-or-nothing, D18). */
static void destroy_partials(GeosShim *shim, GEOSGeometry **out, unsigned int count);

/* GEOS_init_r + install handlers + the interrupt callback (D19). Returns
 * NULL only on malloc failure. */
GeosShim *geos_shim_init(void) {
  GeosShim *shim = (GeosShim *)malloc(sizeof(GeosShim));
  if (!shim)
    return NULL;
  shim->ctx = GEOS_init_r();
  GEOSContext_setErrorHandler_r(shim->ctx, shim_error_handler);
  GEOSContext_setNoticeHandler_r(shim->ctx, shim_notice_handler);
  /* The callback reads the atomic global flag at GEOS's own interruption
   * points; flipping the flag is geos_shim_interrupt_request (any thread). */
  GEOSContext_setInterruptCallback_r(shim->ctx, shim_interrupt_callback, NULL);
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
  return build_one_polygon(shim, xy, ringOffsets, 0, nrings, hasZ, hasM);
}

/*
 * Build ONE polygon from rings [ringLo, ringHi) of the shared coordinate
 * buffer (ring r spans coordinates [ringOffsets[r-1], ringOffsets[r])).
 * Caller validates the offsets. Returns NULL on failure having freed
 * everything IT allocated; GEOS consumes accepted rings even when the final
 * createPolygon fails (the createCollection-class quirk), so only the ring
 * POINTER ARRAY is freed on that path.
 */
static GEOSGeometry *build_one_polygon(GeosShim *shim, const double *xy,
                                       const unsigned int *ringOffsets, unsigned int ringLo,
                                       unsigned int ringHi, int hasZ, int hasM) {
  unsigned int nrings = ringHi - ringLo;
  GEOSGeometry **rings = (GEOSGeometry **)malloc(nrings * sizeof(GEOSGeometry *));
  if (!rings) {
    shim_set_error("build_polygon: out of memory");
    return NULL;
  }
  const int dim = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  unsigned int start = ringLo == 0 ? 0 : ringOffsets[ringLo - 1];
  for (unsigned int r = ringLo; r < ringHi; r++) {
    unsigned int idx = r - ringLo;
    unsigned int count = ringOffsets[r] - start;
    /* Offsets are in coordinate space; the buffer is interleaved, so ring r's
     * data starts at double index start * dim. */
    GEOSCoordSequence *cs =
        GEOSCoordSeq_copyFromBuffer_r(shim->ctx, xy + (size_t)start * dim, count, hasZ, hasM);
    if (!cs) {
      for (unsigned int j = 0; j < idx; j++)
        GEOSGeom_destroy_r(shim->ctx, rings[j]);
      free(rings);
      return NULL; /* GEOS message already captured */
    }
    GEOSGeometry *ring = GEOSGeom_createLinearRing_r(shim->ctx, cs);
    if (!ring) {
      /* Same GEOS quirk as below: the coordseq moved into a unique_ptr
       * before the ring was constructed; on failure it is consumed. */
      for (unsigned int j = 0; j < idx; j++)
        GEOSGeom_destroy_r(shim->ctx, rings[j]);
      free(rings);
      return NULL;
    }
    rings[idx] = ring;
    start = ringOffsets[r];
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

/* =============== Interrupt (D19): atomic global flag =============== */

/*
 * A synchronous FFI call blocks the JS thread, so an AbortSignal listener on
 * the calling thread can never run mid-call — only ANOTHER thread (Worker,
 * or the aborting thread of a cross-thread setup) can flip the flag while
 * GEOS is executing. The flag is therefore process-global and atomic; the
 * per-context callback installed at init reads it at GEOS's own
 * interruption points.
 */
/* MSVC is excluded even when it advertises C11: its <stdatomic.h> support
 * is incomplete in the toolchains we build with, and the fallback below is
 * sufficient — aligned 32-bit volatile reads/writes are atomic on every
 * target we ship (x86-64/aarch64, Windows included), the flag is a single
 * int with relaxed semantics (D19), and the reset ordering is enforced by
 * the JS layer's `finally` (withSignal), not by memory ordering. */
#if !defined(_MSC_VER) && defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L && \
    !defined(__STDC_NO_ATOMICS__)
#include <stdatomic.h>
static atomic_int g_interrupt = 0;
static void shim_set_interrupt(int v) {
  atomic_store_explicit(&g_interrupt, v, memory_order_relaxed);
}
static int shim_get_interrupt(void) {
  return atomic_load_explicit(&g_interrupt, memory_order_relaxed);
}
#else
/* Pre-C11 / MSVC fallback (D19's "volatile fallback"): single-word flag,
 * relaxed ordering — see the note above. */
static volatile int g_interrupt = 0;
static void shim_set_interrupt(int v) { g_interrupt = v; }
static int shim_get_interrupt(void) { return g_interrupt; }
#endif

static int shim_interrupt_callback(void *userdata) {
  (void)userdata;
  return shim_get_interrupt();
}

/* Request interruption of any running GEOS op (thread-safe). */
void geos_shim_interrupt_request(void) { shim_set_interrupt(1); }

/* Clear the interrupt flag (thread-safe). Called after every op that took a
 * signal, and after handling an abort. */
void geos_shim_interrupt_reset(void) { shim_set_interrupt(0); }

/* ========= Bulk clones (loop-shaped, one crossing) ========= */

/*
 * Clone n geometries into `out` (JS-owned array). Returns 0 on success; on
 * failure the partial clones are destroyed (and nulled), a message is
 * captured, and -1 is returned.
 */
int geos_shim_clone_many(GeosShim *shim, GEOSGeometry **src, unsigned int n, GEOSGeometry **out) {
  if (!shim || (!src && n > 0) || (!out && n > 0)) {
    shim_set_error("clone_many: invalid arguments (shim=%p src=%p out=%p n=%u)", (void *)shim,
                   (void *)src, (void *)out, n);
    return -1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (!src[i]) {
      shim_set_error("clone_many: NULL geometry at index %u", i);
      return -1;
    }
    out[i] = GEOSGeom_clone_r(shim->ctx, src[i]);
    if (!out[i]) {
      for (unsigned int j = 0; j < i; j++) {
        GEOSGeom_destroy_r(shim->ctx, out[j]);
        out[j] = NULL;
      }
      return -1; /* GEOS message already captured */
    }
  }
  return 0;
}

/*
 * Clone n geometries and hand them to a fresh GEOMETRYCOLLECTION (the
 * container the coverage/unary ops take). The collection CONSUMES the
 * clones — including on failure (the createCollection quirk — the parts are
 * moved before construction), so the failure path frees nothing but the
 * array we allocated.
 * Returns NULL with a captured message on failure.
 */
static GEOSGeometry *clone_collect(GeosShim *shim, GEOSGeometry **parts, unsigned int n) {
  GEOSGeometry **clones = (GEOSGeometry **)malloc((n ? n : 1) * sizeof(GEOSGeometry *));
  if (!clones) {
    shim_set_error("clone_collect: out of memory");
    return NULL;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (!parts[i]) {
      shim_set_error("clone_collect: NULL geometry at index %u", i);
      for (unsigned int j = 0; j < i; j++)
        GEOSGeom_destroy_r(shim->ctx, clones[j]);
      free(clones);
      return NULL;
    }
    clones[i] = GEOSGeom_clone_r(shim->ctx, parts[i]);
    if (!clones[i]) {
      for (unsigned int j = 0; j < i; j++)
        GEOSGeom_destroy_r(shim->ctx, clones[j]);
      free(clones);
      return NULL; /* GEOS message already captured */
    }
  }
  /* typeId 7 = GEOS_GEOMETRYCOLLECTION: accepts heterogeneous members, so
   * the same container serves coverage checks and unary/disjoint unions. */
  GEOSGeometry *coll = GEOSGeom_createCollection_r(shim->ctx, 7, clones, n);
  free(clones); /* "collections take contents, not the array" */
  return coll;  /* on failure the clones were consumed by GEOS (quirk) */
}

/* Clone n inputs into a GEOMETRYCOLLECTION — public helper for the TS-side
 * coverage ops (CoverageIsValid/Clean/Simplify take one collection). */
GEOSGeometry *geos_shim_clone_collect(GeosShim *shim, GEOSGeometry **parts, unsigned int n) {
  if (!shim || (!parts && n > 0) || n == 0) {
    shim_set_error("clone_collect: invalid arguments (shim=%p parts=%p n=%u)", (void *)shim,
                   (void *)parts, n);
    return NULL;
  }
  return clone_collect(shim, parts, n);
}

/*
 * Clone the members of a collection into `out` (JS-owned array, capacity
 * maxOut). Members are BORROWED interior pointers, cloned before handing
 * them out. Returns the member count, or -1 with a captured message.
 */
int geos_shim_clone_members(GeosShim *shim, const GEOSGeometry *collection, GEOSGeometry **out,
                            unsigned int maxOut) {
  if (!shim || !collection || !out) {
    shim_set_error("clone_members: invalid arguments (shim=%p coll=%p out=%p)", (void *)shim,
                   (void *)collection, (void *)out);
    return -1;
  }
  int n = GEOSGetNumGeometries_r(shim->ctx, collection);
  if (n < 0)
    return -1; /* GEOS message captured */
  if ((unsigned int)n > maxOut) {
    shim_set_error("clone_members: buffer too small (maxOut=%u need=%d)", maxOut, n);
    return -1;
  }
  for (int i = 0; i < n; i++) {
    const GEOSGeometry *member = GEOSGetGeometryN_r(shim->ctx, collection, i);
    if (!member) {
      for (int j = 0; j < i; j++) {
        GEOSGeom_destroy_r(shim->ctx, out[j]);
        out[j] = NULL;
      }
      return -1;
    }
    out[i] = GEOSGeom_clone_r(shim->ctx, member);
    if (!out[i]) {
      for (int j = 0; j < i; j++) {
        GEOSGeom_destroy_r(shim->ctx, out[j]);
        out[j] = NULL;
      }
      return -1; /* GEOS message already captured */
    }
  }
  return n;
}

/* ========= union_all strategy dispatch (D20) ========= */

/*
 * Strategy ids — must match UnionStrategy in src/types.ts.
 *   0 auto: valid coverage -> CoverageUnion; otherwise (invalid OR
 *     non-polygonal) DisjointSubsetUnion.
 *   1 coverage: validate first (CoverageUnion on a non-coverage is silently
 *     WRONG, not an error) then CoverageUnion.
 *   2 disjointSubset: GEOSDisjointSubsetUnion (correct for any input).
 *   3 unary: GEOSUnaryUnion over a temp collection.
 * Returns a NEW owned geometry (never consumes the inputs). n == 1 is the
 * identity (a clone). The temporary collection is always destroyed.
 */
#define SHIM_UNION_AUTO 0
#define SHIM_UNION_COVERAGE 1
#define SHIM_UNION_DISJOINT 2
#define SHIM_UNION_UNARY 3

/* 1 valid, 0 invalid, 2 exception (message captured) — an INT return, never
 * masked (masking would turn a future -1 sentinel into 255). */
static int coverage_check(GeosShim *shim, const GEOSGeometry *coll) {
  GEOSGeometry *invalidEdges = NULL;
  int r = GEOSCoverageIsValid_r(shim->ctx, coll, 0.0, &invalidEdges);
  if (invalidEdges)
    GEOSGeom_destroy_r(shim->ctx, invalidEdges);
  return r;
}

GEOSGeometry *geos_shim_union_all(GeosShim *shim, GEOSGeometry **parts, unsigned int n,
                                  int strategy) {
  if (!shim || (!parts && n > 0)) {
    shim_set_error("union_all: invalid arguments (shim=%p parts=%p n=%u)", (void *)shim,
                   (void *)parts, n);
    return NULL;
  }
  if (n == 0) {
    shim_set_error("union_all: empty input (need at least one geometry)");
    return NULL;
  }
  if (n == 1)
    return GEOSGeom_clone_r(shim->ctx, parts[0]);
  GEOSGeometry *coll = clone_collect(shim, parts, n);
  if (!coll)
    return NULL;
  GEOSGeometry *result = NULL;
  if (strategy == SHIM_UNION_UNARY) {
    result = GEOSUnaryUnion_r(shim->ctx, coll);
  } else if (strategy == SHIM_UNION_DISJOINT) {
    result = GEOSDisjointSubsetUnion_r(shim->ctx, coll);
  } else if (strategy == SHIM_UNION_COVERAGE) {
    int ok = coverage_check(shim, coll);
    if (ok == 1)
      result = GEOSCoverageUnion_r(shim->ctx, coll);
    else if (ok == 0)
      shim_set_error("union_all: strategy \"coverage\" requires a valid aligned coverage "
                     "(GEOSCoverageIsValid found overlaps/gaps; use strategy \"auto\" or clean "
                     "with coverageClean first)");
    /* ok == 2: GEOS exception — message already captured (e.g. non-polygonal input). */
  } else if (strategy == SHIM_UNION_AUTO) {
    int ok = coverage_check(shim, coll);
    if (ok == 1)
      result = GEOSCoverageUnion_r(shim->ctx, coll);
    else
      /* Invalid coverage OR non-polygonal input (exception): the disjoint
       * subset path is correct for both. A genuine GEOS error surfaces from
       * this call too. */
      result = GEOSDisjointSubsetUnion_r(shim->ctx, coll);
  } else {
    shim_set_error("union_all: unknown strategy %d", strategy);
  }
  GEOSGeom_destroy_r(shim->ctx, coll);
  return result;
}

/*
 * Raw CoverageUnion over cloned inputs — the caller-asserts fast path
 * (documented: garbage in, garbage out on a non-coverage).
 */
GEOSGeometry *geos_shim_coverage_union(GeosShim *shim, GEOSGeometry **parts, unsigned int n) {
  if (!shim || (!parts && n > 0) || n == 0) {
    shim_set_error("coverage_union: invalid arguments (shim=%p parts=%p n=%u)", (void *)shim,
                   (void *)parts, n);
    return NULL;
  }
  GEOSGeometry *coll = clone_collect(shim, parts, n);
  if (!coll)
    return NULL;
  GEOSGeometry *result = GEOSCoverageUnion_r(shim->ctx, coll);
  GEOSGeom_destroy_r(shim->ctx, coll);
  return result;
}

/* ========= Prepared predicate batch masks (D18) ========= */

/* Predicate ids — must match PreparedPred in src/types.ts. */
enum {
  SHIM_PREP_INTERSECTS = 0,
  SHIM_PREP_CONTAINS,
  SHIM_PREP_CONTAINS_PROPERLY,
  SHIM_PREP_COVERED_BY,
  SHIM_PREP_COVERS,
  SHIM_PREP_CROSSES,
  SHIM_PREP_DISJOINT,
  SHIM_PREP_OVERLAPS,
  SHIM_PREP_TOUCHES,
  SHIM_PREP_WITHIN
};

static char prep_call(int predId, GEOSContextHandle_t ctx, const GEOSPreparedGeometry *pg,
                      const GEOSGeometry *g) {
  switch (predId) {
  case SHIM_PREP_INTERSECTS:
    return GEOSPreparedIntersects_r(ctx, pg, g);
  case SHIM_PREP_CONTAINS:
    return GEOSPreparedContains_r(ctx, pg, g);
  case SHIM_PREP_CONTAINS_PROPERLY:
    return GEOSPreparedContainsProperly_r(ctx, pg, g);
  case SHIM_PREP_COVERED_BY:
    return GEOSPreparedCoveredBy_r(ctx, pg, g);
  case SHIM_PREP_COVERS:
    return GEOSPreparedCovers_r(ctx, pg, g);
  case SHIM_PREP_CROSSES:
    return GEOSPreparedCrosses_r(ctx, pg, g);
  case SHIM_PREP_DISJOINT:
    return GEOSPreparedDisjoint_r(ctx, pg, g);
  case SHIM_PREP_OVERLAPS:
    return GEOSPreparedOverlaps_r(ctx, pg, g);
  case SHIM_PREP_TOUCHES:
    return GEOSPreparedTouches_r(ctx, pg, g);
  case SHIM_PREP_WITHIN:
    return GEOSPreparedWithin_r(ctx, pg, g);
  default:
    shim_set_error("prepared_pred_all: unknown predicate id %d", predId);
    return 2;
  }
}

/*
 * Evaluate one prepared predicate over n geometries in one FFI crossing,
 * writing 0/1 into `out` (JS-owned Uint8Array).
 * Returns 0 ok; 1 GEOS exception (message captured; no partial masks —
 * out entries past the failure are untouched, the mask is discarded);
 * 2 interrupted (flag set mid-loop).
 * Char returns are masked to the low byte (upper register bits are garbage).
 */
int geos_shim_prepared_pred_all(GeosShim *shim, const GEOSPreparedGeometry *pg, int predId,
                                GEOSGeometry **geoms, unsigned int n, uint8_t *out) {
  if (!shim || !pg || (!geoms && n > 0) || (!out && n > 0)) {
    shim_set_error("prepared_pred_all: invalid arguments (shim=%p pg=%p geoms=%p out=%p n=%u)",
                   (void *)shim, (void *)pg, (void *)geoms, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("prepared_pred_all: interrupted by request");
      return 2;
    }
    if (!geoms[i]) {
      shim_set_error("prepared_pred_all: NULL geometry at index %u", i);
      return 1;
    }
    char r = prep_call(predId, shim->ctx, pg, geoms[i]) & 0xff;
    if (r == 2)
      return 1; /* GEOS message already captured */
    out[i] = (uint8_t)(r == 1);
  }
  return 0;
}

/* Same loop for DE-9IM pattern matches (pattern is a NUL-terminated UTF-8
 * string, exactly as GEOSRelatePattern takes). */
int geos_shim_prepared_relate_pattern_all(GeosShim *shim, const GEOSPreparedGeometry *pg,
                                          GEOSGeometry **geoms, unsigned int n, const char *pattern,
                                          uint8_t *out) {
  if (!shim || !pg || (!geoms && n > 0) || !pattern || (!out && n > 0)) {
    shim_set_error("prepared_relate_pattern_all: invalid arguments (shim=%p pg=%p geoms=%p "
                   "pattern=%p out=%p n=%u)",
                   (void *)shim, (void *)pg, (void *)geoms, (const void *)pattern, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("prepared_relate_pattern_all: interrupted by request");
      return 2;
    }
    if (!geoms[i]) {
      shim_set_error("prepared_relate_pattern_all: NULL geometry at index %u", i);
      return 1;
    }
    char r = GEOSPreparedRelatePattern_r(shim->ctx, pg, geoms[i], pattern) & 0xff;
    if (r == 2)
      return 1;
    out[i] = (uint8_t)(r == 1);
  }
  return 0;
}

/* ========= STRtree query / nearest collection (D16) ========= */

typedef struct {
  int32_t *out;
  unsigned int max;
  unsigned int count;
} QueryCtx;

/* Items are stored 1-BASED ((void*)(intptr_t)(id + 1)): GEOS hands the
 * stored item back from nearest_generic, and a 0-valued item would be
 * indistinguishable from the NULL "no answer" return — nearest to item 0
 * would misreport -1 (audited: the NULL-overload collision). Decode
 * (item - 1) everywhere an id crosses back to JS. */
static void shim_query_cb(void *item, void *userdata) {
  QueryCtx *q = (QueryCtx *)userdata;
  if (q->count < q->max)
    q->out[q->count] = (int32_t)(intptr_t)(uintptr_t)item - 1;
  q->count++;
}

/*
 * Collect query candidates into `out` in ONE crossing. Returns the TOTAL
 * number of candidates (may exceed maxOut — the JS side then requeries with
 * a right-sized buffer), or -1 on invalid arguments.
 */
int geos_shim_strtree_query(GeosShim *shim, GEOSSTRtree *tree, const GEOSGeometry *query,
                            int32_t *out, unsigned int maxOut) {
  if (!shim || !tree || !query || (!out && maxOut > 0)) {
    shim_set_error("strtree_query: invalid arguments (shim=%p tree=%p query=%p out=%p maxOut=%u)",
                   (void *)shim, (void *)tree, (const void *)query, (void *)out, maxOut);
    return -1;
  }
  QueryCtx q = {out, maxOut, 0};
  GEOSSTRtree_query_r(shim->ctx, tree, query, shim_query_cb, &q);
  return (int)q.count;
}

/*
 * id -> geometry table for `nearest`. The JS side binds the CURRENT inserted
 * geometries once at build() time; the shim owns the copy (free with
 * strtree_table_free at tree dispose).
 */
void *geos_shim_strtree_bind_geoms(GeosShim *shim, GEOSGeometry **geoms, unsigned int n) {
  if (!shim || (!geoms && n > 0)) {
    shim_set_error("strtree_bind_geoms: invalid arguments (shim=%p geoms=%p n=%u)", (void *)shim,
                   (void *)geoms, n);
    return NULL;
  }
  GEOSGeometry **copy = (GEOSGeometry **)malloc((n ? n : 1) * sizeof(GEOSGeometry *));
  if (!copy) {
    shim_set_error("strtree_bind_geoms: out of memory");
    return NULL;
  }
  if (n > 0)
    memcpy(copy, geoms, n * sizeof(GEOSGeometry *));
  return copy;
}

void geos_shim_strtree_table_free(void *table) { free(table); }

/*
 * Distance callback for nearest_generic: map item ids back to geometries;
 * the sentinel id (-1) is the query geometry itself; stored items are
 * 1-based, so the table index is (item - 1). GEOSDistance_r failure
 * propagates as 0 = failed, which nearest_generic turns into a GEOS
 * exception -> captured message -> shim return -2.
 */
#define SHIM_NEAREST_SENTINEL ((const void *)(uintptr_t)-1)

typedef struct {
  GEOSContextHandle_t ctx;
  const GEOSGeometry *query;
  GEOSGeometry **table;
} NearestCtx;

static int shim_nearest_distance_cb(const void *a, const void *b, double *distance,
                                    void *userdata) {
  NearestCtx *n = (NearestCtx *)userdata;
  const GEOSGeometry *ga = (a == SHIM_NEAREST_SENTINEL)
                               ? n->query
                               : n->table[(size_t)(intptr_t)(uintptr_t)a - 1];
  const GEOSGeometry *gb = (b == SHIM_NEAREST_SENTINEL)
                               ? n->query
                               : n->table[(size_t)(intptr_t)(uintptr_t)b - 1];
  return GEOSDistance_r(n->ctx, ga, gb, distance);
}

/*
 * Nearest item id, or -1 when the tree has no answer, or -2 on failure with
 * a captured message. (The plain GEOSSTRtree_nearest is UNUSABLE with id
 * items — it casts items to GEOSGeometry* to compute distances; see the
 * module comment / decisions.md D16. Items are 1-based so a genuine nearest
 * of id 0 can never collide with the NULL "no answer" return.)
 */
int geos_shim_strtree_nearest(GeosShim *shim, GEOSSTRtree *tree, const GEOSGeometry *query,
                              GEOSGeometry **table) {
  if (!shim || !tree || !query || !table) {
    shim_set_error("strtree_nearest: invalid arguments (shim=%p tree=%p query=%p table=%p)",
                   (void *)shim, (void *)tree, (const void *)query, (void *)table);
    return -2;
  }
  NearestCtx n = {shim->ctx, query, table};
  const void *item = GEOSSTRtree_nearest_generic_r(shim->ctx, tree, SHIM_NEAREST_SENTINEL, query,
                                                   shim_nearest_distance_cb, &n);
  if (!item)
    return t_has_error ? -2 : -1;
  return (int)(intptr_t)(uintptr_t)item - 1;
}

/* ================================================================= */
/* ========= Phase 3: the batch op layer (D22, decisions.md) ======== */
/* ================================================================= */

/*
 * Many-geometry overlay/predicate/measure loops executed in C — one FFI
 * call per array (the literal Shapely-2.0 lesson). Every function here
 * follows the D18 contract exactly:
 *   - JS passes a pointer array + a preallocated output array;
 *   - the loop checks the atomic interrupt flag between items;
 *   - the FIRST GEOS exception aborts the whole call; partial outputs are
 *     destroyed and the slots nulled (all-or-nothing — the JS side discards
 *     the output array, but C must not leak);
 *   - return codes 0 ok / 1 exception (message captured) / 2 interrupted.
 * Op ids are small enum tables mirrored in src/types.ts and pinned by
 * known-answer selftests (the PreparedPred discipline).
 */

/* Overlay op ids — must match OverlayOp in src/types.ts. */
enum {
  SHIM_OVERLAY_INTERSECTION = 0,
  SHIM_OVERLAY_UNION,
  SHIM_OVERLAY_DIFFERENCE,
  SHIM_OVERLAY_SYMDIFFERENCE,
  SHIM_OVERLAY_INTERSECTION_PREC,
  SHIM_OVERLAY_UNION_PREC,
  SHIM_OVERLAY_DIFFERENCE_PREC,
  SHIM_OVERLAY_SYMDIFFERENCE_PREC
};

static GEOSGeometry *overlay_call(int opId, GEOSContextHandle_t ctx, const GEOSGeometry *a,
                                  const GEOSGeometry *b, double grid) {
  switch (opId) {
  case SHIM_OVERLAY_INTERSECTION:
    return GEOSIntersection_r(ctx, a, b);
  case SHIM_OVERLAY_UNION:
    return GEOSUnion_r(ctx, a, b);
  case SHIM_OVERLAY_DIFFERENCE:
    return GEOSDifference_r(ctx, a, b);
  case SHIM_OVERLAY_SYMDIFFERENCE:
    return GEOSSymDifference_r(ctx, a, b);
  case SHIM_OVERLAY_INTERSECTION_PREC:
    return GEOSIntersectionPrec_r(ctx, a, b, grid);
  case SHIM_OVERLAY_UNION_PREC:
    return GEOSUnionPrec_r(ctx, a, b, grid);
  case SHIM_OVERLAY_DIFFERENCE_PREC:
    return GEOSDifferencePrec_r(ctx, a, b, grid);
  case SHIM_OVERLAY_SYMDIFFERENCE_PREC:
    return GEOSSymDifferencePrec_r(ctx, a, b, grid);
  default:
    shim_set_error("overlay_all: unknown op id %d", opId);
    return NULL;
  }
}

/*
 * Element-wise overlay of `a` with each of n geometries: out[i] = op(a, gs[i]).
 * `grid` is the fixed-precision grid size for the *_PREC op ids (ignored by
 * the plain ids). `a` and `gs` are borrowed — never consumed, never freed.
 * Outputs are NEW owned geometries; on any failure every output produced so
 * far is destroyed before returning.
 */
int geos_shim_overlay_all(GeosShim *shim, int opId, const GEOSGeometry *a, GEOSGeometry **gs,
                          unsigned int n, double grid, GEOSGeometry **out) {
  if (!shim || (!a && n > 0) || (!gs && n > 0) || (!out && n > 0)) {
    shim_set_error("overlay_all: invalid arguments (shim=%p a=%p gs=%p out=%p n=%u)", (void *)shim,
                   (const void *)a, (void *)gs, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("overlay_all: interrupted by request");
      destroy_partials(shim, out, i);
      return 2;
    }
    if (!gs[i]) {
      shim_set_error("overlay_all: NULL geometry at index %u", i);
      destroy_partials(shim, out, i);
      return 1;
    }
    out[i] = overlay_call(opId, shim->ctx, a, gs[i], grid);
    if (!out[i]) {
      destroy_partials(shim, out, i); /* GEOS message already captured */
      return 1;
    }
  }
  return 0;
}

/* Unprepared predicate ids — must match UnpreparedPred in src/types.ts.
 * (Prepared batch masks keep their own table; the numbering here is pinned
 * by the selftest independently.) */
enum {
  SHIM_PRED_INTERSECTS = 0,
  SHIM_PRED_CONTAINS,
  SHIM_PRED_COVERED_BY,
  SHIM_PRED_COVERS,
  SHIM_PRED_CROSSES,
  SHIM_PRED_DISJOINT,
  SHIM_PRED_OVERLAPS,
  SHIM_PRED_TOUCHES,
  SHIM_PRED_WITHIN
};

static char unprep_call(int predId, GEOSContextHandle_t ctx, const GEOSGeometry *a,
                        const GEOSGeometry *b) {
  switch (predId) {
  case SHIM_PRED_INTERSECTS:
    return GEOSIntersects_r(ctx, a, b);
  case SHIM_PRED_CONTAINS:
    return GEOSContains_r(ctx, a, b);
  case SHIM_PRED_COVERED_BY:
    return GEOSCoveredBy_r(ctx, a, b);
  case SHIM_PRED_COVERS:
    return GEOSCovers_r(ctx, a, b);
  case SHIM_PRED_CROSSES:
    return GEOSCrosses_r(ctx, a, b);
  case SHIM_PRED_DISJOINT:
    return GEOSDisjoint_r(ctx, a, b);
  case SHIM_PRED_OVERLAPS:
    return GEOSOverlaps_r(ctx, a, b);
  case SHIM_PRED_TOUCHES:
    return GEOSTouches_r(ctx, a, b);
  case SHIM_PRED_WITHIN:
    return GEOSWithin_r(ctx, a, b);
  default:
    shim_set_error("pred_all: unknown predicate id %d", predId);
    return 2;
  }
}

/*
 * Unprepared batch masks — the free-function mirror of Prepared.*All (D18):
 * out[i] = pred(a, gs[i]) as 0/1. Same all-or-nothing contract.
 */
int geos_shim_pred_all(GeosShim *shim, int predId, const GEOSGeometry *a, GEOSGeometry **gs,
                       unsigned int n, uint8_t *out) {
  if (!shim || !a || (!gs && n > 0) || (!out && n > 0)) {
    shim_set_error("pred_all: invalid arguments (shim=%p a=%p gs=%p out=%p n=%u)", (void *)shim,
                   (const void *)a, (void *)gs, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("pred_all: interrupted by request");
      return 2;
    }
    if (!gs[i]) {
      shim_set_error("pred_all: NULL geometry at index %u", i);
      return 1;
    }
    char r = unprep_call(predId, shim->ctx, a, gs[i]) & 0xff;
    if (r == 2)
      return 1; /* GEOS message already captured */
    out[i] = (uint8_t)(r == 1);
  }
  return 0;
}

/* ------------------------------------------------------- unary batch ops
 * Phase 5 (D27): one shim call per array for the loop-shaped construction
 * ops (hulls, simplification, clipping, centroid/boundary/interior point,
 * node, line merge). Op ids must match UnaryOp in src/types.ts; the numeric
 * values are pinned by selftest scenarios. `d1..d4` carry each op's scalar
 * params (simplify tolerance, clip rectangle); unused ids ignore them.
 */
enum {
  SHIM_UNARY_CONVEX_HULL = 0,
  SHIM_UNARY_SIMPLIFY_DP,
  SHIM_UNARY_SIMPLIFY_TP,
  SHIM_UNARY_CENTROID,
  SHIM_UNARY_BOUNDARY,
  SHIM_UNARY_INTERIOR_POINT,
  SHIM_UNARY_NODE,
  SHIM_UNARY_LINE_MERGE,
  SHIM_UNARY_CLIP_BY_RECT
};

static GEOSGeometry *unary_call(int opId, GEOSContextHandle_t ctx, const GEOSGeometry *g, double d1,
                                double d2, double d3, double d4) {
  switch (opId) {
  case SHIM_UNARY_CONVEX_HULL:
    return GEOSConvexHull_r(ctx, g);
  case SHIM_UNARY_SIMPLIFY_DP:
    return GEOSSimplify_r(ctx, g, d1);
  case SHIM_UNARY_SIMPLIFY_TP:
    return GEOSTopologyPreserveSimplify_r(ctx, g, d1);
  case SHIM_UNARY_CENTROID:
    return GEOSGetCentroid_r(ctx, g);
  case SHIM_UNARY_BOUNDARY:
    return GEOSBoundary_r(ctx, g);
  case SHIM_UNARY_INTERIOR_POINT:
    return GEOSPointOnSurface_r(ctx, g);
  case SHIM_UNARY_NODE:
    return GEOSNode_r(ctx, g);
  case SHIM_UNARY_LINE_MERGE:
    return GEOSLineMerge_r(ctx, g);
  case SHIM_UNARY_CLIP_BY_RECT:
    return GEOSClipByRect_r(ctx, g, d1, d2, d3, d4);
  default:
    shim_set_error("unary_all: unknown op id %d", opId);
    return NULL;
  }
}

/*
 * Element-wise unary construction ops: out[i] = op(gs[i]). Inputs are
 * borrowed; outputs are NEW owned geometries. First failure destroys every
 * output produced so far (D18 contract; interrupt checks between items).
 */
int geos_shim_unary_all(GeosShim *shim, int opId, GEOSGeometry **gs, unsigned int n, double d1,
                        double d2, double d3, double d4, GEOSGeometry **out) {
  if (!shim || (!gs && n > 0) || (!out && n > 0)) {
    shim_set_error("unary_all: invalid arguments (shim=%p gs=%p out=%p n=%u)", (void *)shim,
                   (void *)gs, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("unary_all: interrupted by request");
      destroy_partials(shim, out, i);
      return 2;
    }
    if (!gs[i]) {
      shim_set_error("unary_all: NULL geometry at index %u", i);
      destroy_partials(shim, out, i);
      return 1;
    }
    out[i] = unary_call(opId, shim->ctx, gs[i], d1, d2, d3, d4);
    if (!out[i]) {
      destroy_partials(shim, out, i); /* GEOS message already captured */
      return 1;
    }
  }
  return 0;
}

/* ----------------------------------------------------- binary batch ops
 * Phase 5 (D27): out[i] = op(a, gs[i]) for the 2-ary construction ops.
 * Op ids must match BinaryOp in src/types.ts. `d1` carries the snap
 * tolerance for SHIM_BINARY_SNAP; shared-paths ignores it.
 */
enum {
  SHIM_BINARY_SNAP = 0,
  SHIM_BINARY_SHARED_PATHS
};

static GEOSGeometry *binary_call(int opId, GEOSContextHandle_t ctx, const GEOSGeometry *a,
                                 const GEOSGeometry *b, double d1) {
  switch (opId) {
  case SHIM_BINARY_SNAP:
    return GEOSSnap_r(ctx, a, b, d1);
  case SHIM_BINARY_SHARED_PATHS:
    return GEOSSharedPaths_r(ctx, a, b);
  default:
    shim_set_error("binary_all: unknown op id %d", opId);
    return NULL;
  }
}

int geos_shim_binary_all(GeosShim *shim, int opId, const GEOSGeometry *a, GEOSGeometry **gs,
                         unsigned int n, double d1, GEOSGeometry **out) {
  if (!shim || (!a && n > 0) || (!gs && n > 0) || (!out && n > 0)) {
    shim_set_error("binary_all: invalid arguments (shim=%p a=%p gs=%p out=%p n=%u)", (void *)shim,
                   (const void *)a, (void *)gs, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("binary_all: interrupted by request");
      destroy_partials(shim, out, i);
      return 2;
    }
    if (!gs[i]) {
      shim_set_error("binary_all: NULL geometry at index %u", i);
      destroy_partials(shim, out, i);
      return 1;
    }
    out[i] = binary_call(opId, shim->ctx, a, gs[i], d1);
    if (!out[i]) {
      destroy_partials(shim, out, i); /* GEOS message already captured */
      return 1;
    }
  }
  return 0;
}

/* Measure op ids — must match MeasureOp in src/types.ts. */
enum {
  SHIM_MEASURE_AREA = 0,
  SHIM_MEASURE_LENGTH,
  SHIM_MEASURE_DISTANCE,
  SHIM_MEASURE_HAUSDORFF,
  SHIM_MEASURE_FRECHET
};

/*
 * Batch measures: area/length of each geometry (unary — `a` must be NULL),
 * or distance/hausdorff/frechet from `a` to each geometry (binary). First
 * failure aborts; out[i] entries before the failure are stale-but-discarded
 * (numbers, nothing to free).
 */
int geos_shim_measure_all(GeosShim *shim, int opId, const GEOSGeometry *a, GEOSGeometry **gs,
                          unsigned int n, double *out) {
  if (!shim || (!gs && n > 0) || (!out && n > 0)) {
    shim_set_error("measure_all: invalid arguments (shim=%p a=%p gs=%p out=%p n=%u)", (void *)shim,
                   (const void *)a, (void *)gs, (void *)out, n);
    return 1;
  }
  int unary = opId == SHIM_MEASURE_AREA || opId == SHIM_MEASURE_LENGTH;
  if (unary && a != NULL) {
    shim_set_error("measure_all: op %d takes no reference geometry", opId);
    return 1;
  }
  if (!unary && a == NULL) {
    shim_set_error("measure_all: op %d needs a reference geometry", opId);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("measure_all: interrupted by request");
      return 2;
    }
    if (!gs[i]) {
      shim_set_error("measure_all: NULL geometry at index %u", i);
      return 1;
    }
    double d = 0.0;
    int ok;
    switch (opId) {
    case SHIM_MEASURE_AREA:
      ok = GEOSArea_r(shim->ctx, gs[i], &d);
      break;
    case SHIM_MEASURE_LENGTH:
      ok = GEOSLength_r(shim->ctx, gs[i], &d);
      break;
    case SHIM_MEASURE_DISTANCE:
      ok = GEOSDistance_r(shim->ctx, a, gs[i], &d);
      break;
    case SHIM_MEASURE_HAUSDORFF:
      ok = GEOSHausdorffDistance_r(shim->ctx, a, gs[i], &d);
      break;
    case SHIM_MEASURE_FRECHET:
      ok = GEOSFrechetDistance_r(shim->ctx, a, gs[i], &d);
      break;
    default:
      shim_set_error("measure_all: unknown op id %d", opId);
      return 1;
    }
    if (!ok)
      return 1; /* GEOS message already captured */
    out[i] = d;
  }
  return 0;
}

/*
 * Batch buffer with caller-provided params (created/destroyed by the TS
 * side — pooling stays per-Geos, memory.md §2). Outputs are new owned
 * geometries; all-or-nothing.
 */
int geos_shim_buffer_all(GeosShim *shim, const GEOSBufferParams *params, double dist,
                         GEOSGeometry **gs, unsigned int n, GEOSGeometry **out) {
  if (!shim || !params || (!gs && n > 0) || (!out && n > 0)) {
    shim_set_error("buffer_all: invalid arguments (shim=%p params=%p gs=%p out=%p n=%u)",
                   (void *)shim, (const void *)params, (void *)gs, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("buffer_all: interrupted by request");
      destroy_partials(shim, out, i);
      return 2;
    }
    if (!gs[i]) {
      shim_set_error("buffer_all: NULL geometry at index %u", i);
      destroy_partials(shim, out, i);
      return 1;
    }
    out[i] = GEOSBufferWithParams_r(shim->ctx, gs[i], params, dist);
    if (!out[i]) {
      destroy_partials(shim, out, i); /* GEOS message already captured */
      return 1;
    }
  }
  return 0;
}

/*
 * Batch WKB read (shim.md §2 sketch; io.md §4): n geometries from one
 * buffer, geometry i spanning bytes [byteOffsets[i-1], byteOffsets[i]) —
 * end-indices, element counts in BYTES (the one offset family measured in
 * bytes; everything else in this shim counts elements). The reader is the
 * TS-pooled per-Geos reader. Outputs are new owned geometries;
 * all-or-nothing. u32 offsets cap one buffer at 4 GB — documented.
 */
int geos_shim_read_wkb_many(GeosShim *shim, GEOSWKBReader *reader, const unsigned char *buf,
                            const unsigned int *byteOffsets, unsigned int n, GEOSGeometry **out) {
  if (!shim || !reader || !buf || (!byteOffsets && n > 0) || (!out && n > 0)) {
    shim_set_error("read_wkb_many: invalid arguments (shim=%p reader=%p buf=%p offsets=%p out=%p "
                   "n=%u)",
                   (void *)shim, (void *)reader, (const void *)buf, (const void *)byteOffsets,
                   (void *)out, n);
    return 1;
  }
  size_t start = 0;
  for (unsigned int i = 0; i < n; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("read_wkb_many: interrupted by request");
      destroy_partials(shim, out, i);
      return 2;
    }
    size_t end = byteOffsets[i];
    if (end < start) {
      shim_set_error("read_wkb_many: byteOffsets not increasing at %u (%zu < %zu)", i, end, start);
      destroy_partials(shim, out, i);
      return 1;
    }
    out[i] = GEOSWKBReader_read_r(shim->ctx, reader, buf + start, end - start);
    if (!out[i]) {
      destroy_partials(shim, out, i); /* GEOS message already captured */
      return 1;
    }
    start = end;
  }
  return 0;
}

/*
 * Total vertex count for ANY geometry type (the chunk weights for
 * geos.parallel, D23) in one crossing — never N per-item JS crossings.
 * GEOSGeomGetNumPoints_r is linestring-only, so polygons sum their rings
 * and collections recurse over parts (borrowed pointers — nothing freed).
 */
static int vertex_count(GEOSContextHandle_t ctx, const GEOSGeometry *g, int depth) {
  if (depth > 32)
    return -1; /* pathological nesting guard */
  int typeId = GEOSGeomTypeId_r(ctx, g);
  if (typeId < 0)
    return -1;
  if (typeId == 3) { /* POLYGON: shell + holes */
    int total = 0;
    const GEOSGeometry *shell = GEOSGetExteriorRing_r(ctx, g);
    if (!shell)
      return -1;
    int pts = GEOSGeomGetNumPoints_r(ctx, shell);
    if (pts < 0)
      return -1;
    total += pts;
    int nholes = GEOSGetNumInteriorRings_r(ctx, g);
    if (nholes < 0)
      return -1;
    for (int h = 0; h < nholes; h++) {
      const GEOSGeometry *hole = GEOSGetInteriorRingN_r(ctx, g, h);
      if (!hole)
        return -1;
      pts = GEOSGeomGetNumPoints_r(ctx, hole);
      if (pts < 0)
        return -1;
      total += pts;
    }
    return total;
  }
  if (typeId == 0) { /* POINT: GEOSGeomGetNumPoints_r throws on points in
                       * 3.14 (SimpleCurve dynamic_cast) — a point is 1
                       * vertex, 0 when empty. */
    return GEOSisEmpty_r(ctx, g) == 1 ? 0 : 1;
  }
  if (typeId >= 4) { /* MULTI* / GEOMETRYCOLLECTION: recurse */
    int n = GEOSGetNumGeometries_r(ctx, g);
    if (n < 0)
      return -1;
    int total = 0;
    for (int i = 0; i < n; i++) {
      const GEOSGeometry *part = GEOSGetGeometryN_r(ctx, g, i);
      if (!part)
        return -1;
      int pts = vertex_count(ctx, part, depth + 1);
      if (pts < 0)
        return -1;
      total += pts;
    }
    return total;
  }
  return GEOSGeomGetNumPoints_r(ctx, g); /* linestring / linearring */
}

int geos_shim_num_points_many(GeosShim *shim, GEOSGeometry **gs, unsigned int n, uint32_t *out) {
  if (!shim || (!gs && n > 0) || (!out && n > 0)) {
    shim_set_error("num_points_many: invalid arguments (shim=%p gs=%p out=%p n=%u)", (void *)shim,
                   (void *)gs, (void *)out, n);
    return 1;
  }
  for (unsigned int i = 0; i < n; i++) {
    if (!gs[i]) {
      shim_set_error("num_points_many: NULL geometry at index %u", i);
      return 1;
    }
    int c = vertex_count(shim->ctx, gs[i], 0);
    if (c < 0)
      return 1; /* GEOS message already captured */
    out[i] = (uint32_t)c;
  }
  return 0;
}

/*
 * Data-derived heap estimate over the live pointer set (D24): per geometry
 * 64 bytes overhead + NumPoints × coordinateDimension × 8. M ordinates are
 * not separately detectable per-geometry on the C API — documented as an
 * approximation, never a quota. Read-only: no interrupt checks (accounting
 * must complete once started; it is called outside op loops).
 */
int geos_shim_heap_bytes(GeosShim *shim, GEOSGeometry **gs, unsigned int n, int64_t *outBytes) {
  if (!shim || (!gs && n > 0) || !outBytes) {
    shim_set_error("heap_bytes: invalid arguments (shim=%p gs=%p out=%p n=%u)", (void *)shim,
                   (void *)gs, (void *)outBytes, n);
    return 1;
  }
  int64_t total = 0;
  for (unsigned int i = 0; i < n; i++) {
    if (!gs[i]) {
      shim_set_error("heap_bytes: NULL geometry at index %u", i);
      return 1;
    }
    int pts = vertex_count(shim->ctx, gs[i], 0);
    if (pts < 0)
      return 1;
    int dim = GEOSGeom_getCoordinateDimension_r(shim->ctx, gs[i]);
    if (dim < 2)
      return 1;
    total += 64 + (int64_t)pts * dim * 8;
  }
  *outBytes = total;
  return 0;
}

/* destroy_partials — defined here (forward-declared at the top for the
 * Phase 3 loops above). */
static void destroy_partials(GeosShim *shim, GEOSGeometry **out, unsigned int count) {
  for (unsigned int j = 0; j < count; j++) {
    if (out[j])
      GEOSGeom_destroy_r(shim->ctx, out[j]);
    out[j] = NULL;
  }
}

/* ========= Phase 3: bulk Arrow-shaped builders (D9/D22) ========= */

/*
 * Build n polygons from ONE concatenated coordinate buffer in one crossing
 * — the one-crossing normalization for Polygonal/GeoArrow batch input
 * (api-surface Phase-2 note: "ArrowArray normalization lands with the
 * Phase 3 batch layer"). Polygon j spans rings [partOffsets[j-1],
 * partOffsets[j]); rings are end-indices into coordinate space, exactly as
 * geos_shim_build_polygon takes them. Outputs are new owned geometries;
 * all-or-nothing (completed polygons destroyed on any failure).
 */
int geos_shim_build_polygonal_many(GeosShim *shim, const double *xy, const unsigned int *ringOffsets,
                                   unsigned int nrings, const unsigned int *partOffsets,
                                   unsigned int npolys, int hasZ, int hasM, GEOSGeometry **out) {
  if (!shim || !xy || !ringOffsets || !partOffsets || npolys == 0 || nrings == 0 ||
      (!out && npolys > 0)) {
    shim_set_error("build_polygonal_many: invalid arguments (shim=%p xy=%p rings=%p parts=%p "
                   "out=%p nrings=%u npolys=%u)",
                   (void *)shim, (const void *)xy, (const void *)ringOffsets,
                   (const void *)partOffsets, (void *)out, nrings, npolys);
    return 1;
  }
  if (ringOffsets[0] == 0) {
    shim_set_error("build_polygonal_many: ringOffsets[0] must be > 0 (got 0)");
    return 1;
  }
  for (unsigned int r = 1; r < nrings; r++) {
    if (ringOffsets[r] <= ringOffsets[r - 1]) {
      shim_set_error("build_polygonal_many: ringOffsets not strictly increasing at %u", r);
      return 1;
    }
  }
  if (partOffsets[0] == 0 || partOffsets[npolys - 1] != nrings) {
    shim_set_error("build_polygonal_many: partOffsets must start > 0 and end at nrings (%u != %u)",
                   partOffsets[npolys - 1], nrings);
    return 1;
  }
  for (unsigned int p = 1; p < npolys; p++) {
    if (partOffsets[p] <= partOffsets[p - 1]) {
      shim_set_error("build_polygonal_many: partOffsets not strictly increasing at %u", p);
      return 1;
    }
  }
  unsigned int ringLo = 0;
  for (unsigned int j = 0; j < npolys; j++) {
    if (shim_get_interrupt()) {
      shim_set_error("build_polygonal_many: interrupted by request");
      destroy_partials(shim, out, j);
      return 2;
    }
    unsigned int ringHi = partOffsets[j];
    out[j] = build_one_polygon(shim, xy, ringOffsets, ringLo, ringHi, hasZ, hasM);
    if (!out[j]) {
      destroy_partials(shim, out, j); /* GEOS message already captured */
      return 1;
    }
    ringLo = ringHi;
  }
  return 0;
}

/*
 * Build n linestrings from one concatenated coordinate buffer in one
 * crossing (the LineArray/GeoArrow batch normalization). Line i spans
 * coordinates [lineOffsets[i-1], lineOffsets[i]); end-indices, strictly
 * increasing, each line needs ≥ 2 coordinates. All-or-nothing.
 */
int geos_shim_build_linestrings_many(GeosShim *shim, const double *xy,
                                     const unsigned int *lineOffsets, unsigned int nlines, int hasZ,
                                     int hasM, GEOSGeometry **out) {
  if (!shim || !xy || !lineOffsets || nlines == 0 || (!out && nlines > 0)) {
    shim_set_error("build_linestrings_many: invalid arguments (shim=%p xy=%p offsets=%p out=%p "
                   "nlines=%u)",
                   (void *)shim, (const void *)xy, (const void *)lineOffsets, (void *)out, nlines);
    return 1;
  }
  if (lineOffsets[0] == 0) {
    shim_set_error("build_linestrings_many: lineOffsets[0] must be > 0 (got 0)");
    return 1;
  }
  for (unsigned int l = 1; l < nlines; l++) {
    if (lineOffsets[l] <= lineOffsets[l - 1]) {
      shim_set_error("build_linestrings_many: lineOffsets not strictly increasing at %u", l);
      return 1;
    }
  }
  const int dim = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  unsigned int start = 0;
  for (unsigned int i = 0; i < nlines; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("build_linestrings_many: interrupted by request");
      destroy_partials(shim, out, i);
      return 2;
    }
    unsigned int count = lineOffsets[i] - start;
    if (count < 2) {
      shim_set_error("build_linestrings_many: line %u has %u coordinates; need ≥ 2", i, count);
      destroy_partials(shim, out, i);
      return 1;
    }
    GEOSCoordSequence *cs =
        GEOSCoordSeq_copyFromBuffer_r(shim->ctx, xy + (size_t)start * dim, count, hasZ, hasM);
    if (!cs) {
      destroy_partials(shim, out, i);
      return 1; /* GEOS message already captured */
    }
    GEOSGeometry *g = GEOSGeom_createLineString_r(shim->ctx, cs);
    if (!g) {
      /* coordseq consumed even on failure (the createLineString quirk). */
      destroy_partials(shim, out, i);
      return 1;
    }
    out[i] = g;
    start = lineOffsets[i];
  }
  return 0;
}

/* ========= Phase 3: fused spatial-index filter (api-surface §Spatial
 * index — query + prepared predicate in one crossing) ========= */

typedef struct {
  const GEOSGeometry *g;
  int32_t id;
} FusedCand;

typedef struct {
  GEOSContextHandle_t ctx;
  GEOSGeometry **table;
  FusedCand *cand;
  unsigned int count;
  unsigned int cap;
  int failed;
} FusedCtx;

/* Query callback (C-to-C, D4): decode the 1-based item to (id, geometry)
 * via the bound table and append to the growing candidate array. */
static void shim_fused_query_cb(void *item, void *userdata) {
  FusedCtx *f = (FusedCtx *)userdata;
  if (f->failed)
    return;
  if (f->count == f->cap) {
    unsigned int ncap = f->cap ? f->cap * 2 : 64;
    FusedCand *nc = (FusedCand *)realloc(f->cand, ncap * sizeof(FusedCand));
    if (!nc) {
      f->failed = 1;
      return;
    }
    f->cand = nc;
    f->cap = ncap;
  }
  int32_t id = (int32_t)(intptr_t)(uintptr_t)item - 1;
  f->cand[f->count].g = f->table[id];
  f->cand[f->count].id = id;
  f->count++;
}

/*
 * Fused filter: STRtree query (envelope candidates, C-collected) + prepared
 * predicate + compaction, ONE crossing. Writes up to maxOut MATCHING ids;
 * returns the TOTAL match count (re-call with a right-sized buffer when it
 * exceeds maxOut — the geos_shim_strtree_query contract), -1 on invalid
 * arguments / GEOS exception / OOM, -2 interrupted.
 */
int geos_shim_strtree_query_prepared(GeosShim *shim, GEOSSTRtree *tree, const GEOSGeometry *query,
                                     const GEOSPreparedGeometry *pg, int predId,
                                     GEOSGeometry **table, int32_t *out, unsigned int maxOut) {
  if (!shim || !tree || !query || !pg || !table || (!out && maxOut > 0)) {
    shim_set_error("strtree_query_prepared: invalid arguments (shim=%p tree=%p query=%p pg=%p "
                   "table=%p out=%p)",
                   (void *)shim, (void *)tree, (const void *)query, (const void *)pg,
                   (void *)table, (void *)out);
    return -1;
  }
  FusedCtx f = {shim->ctx, table, NULL, 0, 0, 0};
  GEOSSTRtree_query_r(shim->ctx, tree, query, shim_fused_query_cb, &f);
  if (f.failed) {
    free(f.cand);
    shim_set_error("strtree_query_prepared: out of memory");
    return -1;
  }
  int total = 0;
  for (unsigned int i = 0; i < f.count; i++) {
    if (shim_get_interrupt()) {
      shim_set_error("strtree_query_prepared: interrupted by request");
      free(f.cand);
      return -2;
    }
    char r = prep_call(predId, shim->ctx, pg, f.cand[i].g) & 0xff;
    if (r == 2) {
      free(f.cand);
      return -1; /* GEOS message already captured */
    }
    if (r == 1 && total < (int)maxOut)
      out[total] = f.cand[i].id;
    if (r == 1)
      total++;
  }
  free(f.cand);
  return total;
}
