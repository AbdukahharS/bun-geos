/**
 * Regenerate native/shim.def — the Windows export list (MSVC /DEF: link).
 *
 * Scans native/shim.c for exported function definitions: every `geos_shim_*`
 * defined at column 0 (the file's strict convention — statics are indented
 * and forward declarations are `static`, so line-start anchoring separates
 * definitions from internal calls). Run with `--write` to update the file
 * in place; the default mode is a check (exit 1 on drift), which the native
 * build runs on every platform so .def drift is caught on Linux/macOS dev
 * and CI paths — never only on the Windows job.
 *
 * Usage: bun run scripts/native/def.ts [--write]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const SHIM_C = join(ROOT, "native", "shim.c");
const DEF_FILE = join(ROOT, "native", "shim.def");

const source = readFileSync(SHIM_C, "utf8");
const found = new Set<string>();
for (const line of source.split("\n")) {
  // Definitions start at column 0: `<Type...> geos_shim_name(...)`. Calls are
  // indented; declarations are `static`. No strings can precede them.
  const m = /^(?:[A-Za-z_][\w\s*]*?)?\b(geos_shim_[a-z0-9_]+)\s*\(/.exec(line);
  if (m?.[1]) found.add(m[1]);
}
if (found.size === 0) {
  console.error("def.ts: no exports found in shim.c — regex or file layout changed?");
  process.exit(1);
}

const names = [...found].sort();
const expected = [
  "; bun-geos C shim — Windows export list (win32-x64, MSVC /DEF: link).",
  ";",
  "; LoadLibrary + GetProcAddress (what bun:ffi's dlopen does on Windows) only",
  "; see symbols the DLL actually exports; unlike ELF, MSVC does not export",
  "; everything by default. This file lists every geos_shim_* definition in",
  "; native/shim.c.",
  ";",
  "; KEEP-IN-SYNC: `bun run build:native` (and the CI matrix) regenerates this",
  "; list from shim.c and fails on drift on EVERY platform, so the fast dev/CI",
  "; paths catch it — not the Windows job. Regenerate with:",
  ";   bun run scripts/native/def.ts --write",
  "LIBRARY shim",
  "EXPORTS",
  ...names.map((n) => `\t${n}`),
  "",
].join("\n");

if (process.argv.includes("--write")) {
  writeFileSync(DEF_FILE, expected);
  console.log(`def.ts: wrote ${names.length} exports → native/shim.def`);
} else {
  const current = readFileSync(DEF_FILE, "utf8");
  if (current !== expected) {
    console.error(
      "def.ts: native/shim.def is out of sync with native/shim.c\n" +
        "  → run `bun run scripts/native/def.ts --write` and commit the result",
    );
    process.exit(1);
  }
  console.log(`def.ts: native/shim.def in sync (${names.length} exports)`);
}
