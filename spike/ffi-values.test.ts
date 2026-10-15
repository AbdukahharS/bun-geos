/**
 * Phase 0 spike, check #4a: FFI value-roundtrip table.
 * Guards against the coercion-bug class of oven-sh/bun#44906 (a double passed
 * to an integer-typed arg arriving as 0). Every cell documents what Bun 1.4.3
 * actually does on linux-x64.
 */

import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import { join } from "node:path";

const values = dlopen(join(import.meta.dir, "build", "values.so"), {
  echo_i32: { args: ["i32"], returns: "i32" },
  echo_u32: { args: ["u32"], returns: "u32" },
  echo_i16: { args: ["i16"], returns: "i16" },
  echo_f64: { args: ["f64"], returns: "f64" },
  echo_bool: { args: ["bool"], returns: "bool" },
  sum_f64: { args: ["ptr", "u32"], returns: "f64" },
  peek_f64: { args: ["ptr", "u32"], returns: "f64" },
  f64_as_i32: { args: ["f64"], returns: "i32" },
  f64_as_u32: { args: ["f64"], returns: "u32" },
  addr_tag: { args: ["ptr", "usize"], returns: "usize" },
});

test("int types roundtrip exact values incl. boundaries", () => {
  const { echo_i32, echo_u32, echo_i16 } = values.symbols;
  expect(echo_i32(42)).toBe(42);
  expect(echo_i32(-42)).toBe(-42);
  expect(echo_i32(2 ** 31 - 1)).toBe(2 ** 31 - 1); // INT32_MAX
  expect(echo_u32(0)).toBe(0);
  expect(echo_u32(2 ** 32 - 1)).toBe(2 ** 32 - 1); // UINT32_MAX
  expect(echo_i16(32767)).toBe(32767);
  expect(echo_i16(-32768)).toBe(-32768);
});

test("f64 roundtrips bit-exact across magnitude range", () => {
  const { echo_f64 } = values.symbols;
  for (const v of [0.1, -0.1, 1e-300, 1e300, 2 ** 53, -(2 ** 53), Math.PI]) {
    expect(echo_f64(v)).toBe(v);
  }
  expect(echo_f64(NaN)).toBeNaN();
});

test("bool roundtrip", () => {
  const { echo_bool } = values.symbols;
  expect(echo_bool(true)).toBe(true);
  expect(echo_bool(false)).toBe(false);
});

test("THE #44906 CLASS: JS number into i32/u32-typed args", () => {
  const { echo_i32, echo_u32 } = values.symbols;
  // integral-valued numbers (the only input our real API sends: sizes, flags)
  expect(echo_i32(1000)).toBe(1000);
  expect(echo_u32(1000)).toBe(1000);
  // non-integral / out-of-range inputs: document the behavior whatever it is
  const trunc = echo_i32(3.7);
  console.log(`i32 arg with 3.7 → ${trunc} (${Number.isInteger(trunc) ? "truncated" : "other"})`);
  const big = echo_i32(2 ** 31); // INT32_MAX+1
  console.log(`i32 arg with 2**31 → ${big}`);
  // Guard the dangerous variant explicitly: a fractional value must NOT
  // silently become 0 (the #44906 failure mode)
  expect(echo_i32(3.7)).not.toBe(0);
  expect(echo_u32(3.7)).not.toBe(0);
});

test("zero-copy: Float64Array passed as ptr reads live memory, not a snapshot", () => {
  const { sum_f64, peek_f64 } = values.symbols;
  const buf = new Float64Array([1.5, 2.5, 3.0]);
  expect(sum_f64(buf, 3)).toBe(7.0);
  // mutate after first call — C must see the new value (no copy)
  buf[1] = 100.25;
  expect(peek_f64(buf, 1)).toBe(100.25);
  expect(sum_f64(buf, 3)).toBe(104.75);
});

test("ptr identity: the address C receives is the buffer's address", () => {
  const { addr_tag } = values.symbols;
  const buf = new Float64Array(4);
  const tag = 0x5eed;
  const tagged = addr_tag(buf, tag); // usize → BigInt
  const recovered = tagged ^ BigInt(tag);
  // the recovered address must point AT our memory: C can prove it by
  // reading the first double through the recovered pointer
  const peekAt = dlopen(join(import.meta.dir, "build", "values.so"), {
    peek_f64: { args: ["ptr", "u32"], returns: "f64" },
  });
  buf[0] = 123.456;
  expect(peekAt.symbols.peek_f64(recovered, 0)).toBe(123.456);
});

test("f64-typed arg conversion: what C's own cast sees (informational)", () => {
  const { f64_as_i32, f64_as_u32 } = values.symbols;
  // C casts: 3.7→3, -3.7→-3, 2**31 as u32 wrap
  console.log(`C (int32_t)3.7 = ${f64_as_i32(3.7)}, (int32_t)-3.7 = ${f64_as_i32(-3.7)}`);
  console.log(`C (uint32_t)2**32-0.5 = ${f64_as_u32(2 ** 32 - 0.5)}`);
  expect(f64_as_i32(3.7)).toBe(3);
});
