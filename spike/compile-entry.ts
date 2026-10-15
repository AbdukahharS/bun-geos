/**
 * Phase 0 spike, check #4c: does a --compile binary embed and load a native
 * .so? Known rough edges: oven-sh/bun#44238 (re-extraction every run),
 * #40076 (TMPDIR leak). This script documents actual behavior on 1.4.3.
 * Run: bun build --compile spike/compile-entry.ts --outfile spike/build/testbin
 */
import { dlopen } from "bun:ffi";
import soPath from "./build/values.so" with { type: "file" };

const t0 = performance.now();
const { sum_f64 } = dlopen(soPath, {
  sum_f64: { args: ["ptr", "u32"], returns: "f64" },
}).symbols;
const result = sum_f64(new Float64Array([1.25, 2.5, 3.75]), 3);
const ms = (performance.now() - t0).toFixed(1);
console.log(`sum=${result} load+call=${ms}ms so=${soPath}`);
