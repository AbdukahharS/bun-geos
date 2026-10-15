/* Spike: trivial echo/coerce functions for the FFI value-roundtrip table.
 * Compiled to spike/build/values.so by the test setup script. */
#include <stddef.h>
#include <stdint.h>

int32_t  echo_i32(int32_t x) { return x; }
uint32_t echo_u32(uint32_t x) { return x; }
int16_t  echo_i16(int16_t x) { return x; }
double   echo_f64(double x) { return x; }
_Bool    echo_bool(_Bool x) { return x; }

/* GEOS-style consumer of a typed array: sum of n doubles (zero-copy probe). */
double sum_f64(const double* p, uint32_t n) {
  double s = 0.0;
  for (uint32_t i = 0; i < n; i++) s += p[i];
  return s;
}

/* Zero-copy proof: read a live element (no snapshot). */
double peek_f64(const double* p, uint32_t i) { return p[i]; }

/* What C sees when a double is declared into an int-typed arg (the #44906 class). */
int32_t f64_as_i32(double x) { return (int32_t)x; }
uint32_t f64_as_u32(double x) { return (uint32_t)x; }

/* Pointer roundtrip: return the pointer's low bits XOR a tag so JS can check
 * that the address it sent is the address C received. */
uintptr_t addr_tag(const void* p, uintptr_t tag) {
  return (uintptr_t)p ^ tag;
}
