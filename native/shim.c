/*
 * bun-geos C shim — Phase 0 spike slice.
 *
 * Implements the one thing pure bun:ffi cannot do at all (D4): install GEOS's
 * *variadic* error/notice handlers. Messages are captured into thread-local
 * buffers; the JS side reads them via geos_shim_last_error/last_notice and
 * turns them into thrown GeosErrors (D13). Nothing throws through the FFI
 * boundary; every export uses only bun:ffi-declarable C ABI types.
 *
 * Later shim phases (batch builders, strtree collection, destroy_many,
 * interrupt flag) are deliberately absent — this slice retires the Phase 0
 * risk only. See docs/design/shim.md for the full surface.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

/* Minimal inline prototypes so this file can also be compiled by cc()/TinyCC
 * without GEOS headers present (docs/design/shim.md §4). Matches geos_c.h. */
typedef void* GEOSContextHandle_t;
typedef void (*GEOSMessageHandler_r)(const char* fmt, ...);

extern GEOSContextHandle_t GEOS_init_r(void);
extern void GEOS_finish_r(GEOSContextHandle_t handle);
extern void GEOSContext_setErrorHandler_r(GEOSContextHandle_t handle,
                                          GEOSMessageHandler_r handler);
extern void GEOSContext_setNoticeHandler_r(GEOSContextHandle_t handle,
                                           GEOSMessageHandler_r handler);

#define SHIM_MSG_MAX 1024

static __thread char t_error[SHIM_MSG_MAX];
static __thread char t_notice[SHIM_MSG_MAX];
static __thread int t_has_error = 0;
static __thread int t_has_notice = 0;

/* GEOS invokes these with printf-style fmt+args; only the shim side ever
 * touches varargs (it is the callee, compiled by a real C compiler). */
static void shim_error_handler(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(t_error, sizeof(t_error), fmt, ap);
  va_end(ap);
  t_has_error = 1;
}

static void shim_notice_handler(const char* fmt, ...) {
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
GeosShim* geos_shim_init(void) {
  GeosShim* shim = (GeosShim*)malloc(sizeof(GeosShim));
  if (!shim) return NULL;
  shim->ctx = GEOS_init_r();
  GEOSContext_setErrorHandler_r(shim->ctx, shim_error_handler);
  GEOSContext_setNoticeHandler_r(shim->ctx, shim_notice_handler);
  return shim;
}

/* The GEOS context for THIS shim. JS must pass this handle to every geos_c
 * function — never the GeosShim* itself (the wrapper is opaque bookkeeping;
 * treating it as a context reads garbage and eventually segfaults). */
GEOSContextHandle_t geos_shim_context(GeosShim* shim) {
  return shim ? shim->ctx : NULL;
}

void geos_shim_finish(GeosShim* shim) {
  if (!shim) return;
  GEOS_finish_r(shim->ctx);
  free(shim);
}

/* Last error message on this thread, or NULL. Consumed on read (D13:
 * one GEOS failure → one thrown GeosError; no stale messages). */
const char* geos_shim_last_error(GeosShim* shim) {
  (void)shim;
  if (!t_has_error) return NULL;
  t_has_error = 0;
  return t_error;
}

/* Last notice, or NULL. Same consume-on-read rule. */
const char* geos_shim_last_notice(GeosShim* shim) {
  (void)shim;
  if (!t_has_notice) return NULL;
  t_has_notice = 0;
  return t_notice;
}
