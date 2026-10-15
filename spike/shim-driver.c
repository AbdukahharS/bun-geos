/* Standalone C driver: prove the shim slice works without Bun in the picture. */
#include <stdio.h>
typedef void* GEOSContextHandle_t;
typedef void* GEOSGeometry;
extern GEOSGeometry* GEOSGeomFromWKT_r(GEOSContextHandle_t, const char*);
extern void GEOSGeom_destroy_r(GEOSContextHandle_t, GEOSGeometry*);
#include "../native/shim.c" /* compile the shim in directly — no dlopen needed */

int main(void) {
  GeosShim* s = geos_shim_init();
  if (!s) return 1;
  GEOSGeometry* g = GEOSGeomFromWKT_r(s->ctx, "POLYGON((");
  printf("geom=%p\n", (void*)g);
  const char* err = geos_shim_last_error(s);
  printf("error=%s\n", err ? err : "(null)");
  const char* err2 = geos_shim_last_error(s);
  printf("second read=%s (consumed: %s)\n", err2 ? err2 : "(null)",
         err2 == NULL ? "yes" : "NO");
  if (g) GEOSGeom_destroy_r(s->ctx, g);
  geos_shim_finish(s);
  return 0;
}
