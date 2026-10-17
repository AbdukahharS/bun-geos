# bun-geos

Bun-native TypeScript library wrapping GEOS 3.14 (`bun:ffi` + a small C shim).
Phase 1 (core), Phase 2 (differentiators: prepared predicates, STRtree,
unionAll dispatch, repair suite, precision model, interrupt), Phase 3
(batch ops, worker pool, memory accounting), Phase 4 (packaging &
release tooling), and Phase 5 (hardening & polish: the complete
construction-op surface, permanent corpus/Valgrind/benchmark gates,
GeoArrow shapes v2, reference docs) are implemented under `src/`,
`native/`, and `scripts/`; the Phase 0 spike remains under `spike/` as
the FFI-semantics regression net; research/design/operations docs live
in `docs/`.

## Layout

```
index.ts                 public barrel — re-exports src/index.ts
src/                     the library (loader, symbols, geos/geometry/arena,
                         construct, ops/, io/, parallel/, spatial/)
native/shim.c            the entire C surface, reviewed as prose (portable:
                         GCC/Clang + MSVC — SHIM_TLS/atomics macros)
native/shim.def          Windows export list; sync-checked on every build
scripts/native/          the per-target toolchain table + GEOS/shim builds
                         (targets.ts is the single source for CI + dev)
scripts/build-native.ts  bun run build:native — host build → build/native/
scripts/package-*.ts     stage the 8 publish trees → packages/ (gitignored)
scripts/release.ts       the publish pipeline (token auth; OIDC reserved)
scripts/release-dry-run.ts  verdaccio end-to-end rehearsal
scripts/platform-smoke.ts   the per-platform gate against a STAGED tree
scripts/gen-symbol-reference.ts   `bun run docs:reference` — docs/reference/symbols.md
scripts/test-native-valgrind.ts   `bun run test:native:valgrind` (Phase 5 gate)
test/
  unit/ properties/ soak/ differential/   bun test test/
  native/shim_selftest.c                  bun run test:native (ASan/UBSan)
spike/                   Phase 0 evidence; `bun test spike/` gates Bun bumps
docs/reference/          api.md (freshness-gated) + symbols.md (generated)
vendor/, build/          legacy spike checkout + native build tree (gitignored)
packages/                staged publish trees (gitignored; generated)
.github/workflows/       ci.yml (dev gate) · release.yml (matrix+publish) ·
                         install-matrix.yml (the <60s exit criterion)
```

## Toolchain: Bun, not Node

Default to Bun for everything (Bun 1.4.x, TypeScript ^7 native as peerDependency):

- Run a file: `bun <file>` — never `node` / `ts-node`
- Install: `bun install` — never npm/yarn/pnpm
- Typecheck: `bun check` (alias `bun run typecheck`); one file: `bun check src/index.ts`
- Test: `bun test test/`; spike suite: `bun test spike/` (needs native libs: `bun run build:native`)
- Native build: `bun run build:native` (GEOS + shim into `build/native/`)
- Lint + format: Biome — `bun run lint` / `bun run lint:fix` / `bun run format`
- Scripts: `bun run <script>`; one-off binaries: `bunx <pkg> <cmd>`
- Shell out from code with `Bun.$` instead of execa

## TypeScript gotchas (tsconfig.json)

- `verbatimModuleSyntax` is on: type-only imports must use `import type`.
- `allowImportingTsExtensions` + bundler resolution: relative imports use `.ts` extensions; there is no build step (`noEmit`) — Bun runs TS directly.
- `noUncheckedIndexedAccess` is on: `arr[i]` and `obj[key]` are `T | undefined`.
- Also on: `exactOptionalPropertyTypes`, `noUncheckedSideEffectImports`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`.
- `strict` is on. `noExplicitAny` is a lint error (biome) — an FFI library carries zero `any`.

## Lint & format (Biome)

- Config: `biome.jsonc` (strict JSON would reject comments; `biome.jsonc` allows them).
- `bun run lint` must stay at 0 errors; the only tolerated warnings are
  `noNonNullAssertion` on FFI out-params (visible, not blocking — D15).
- `spike/` may use `console.log` (tests print verdicts); `src/` may not.

## Bun runtime conventions

- Bun auto-loads `.env` / `.env.local`; don't add dotenv.
- Prefer built-ins over extra dependencies: `Bun.serve()` (not express), `bun:sqlite` (not better-sqlite3), `Bun.sql` (not pg), `Bun.redis` (not ioredis), built-in `WebSocket` (not ws), `Bun.file` over node:fs read/write.

## Phase 1+2 house rules (from docs/decisions.md — binding)

- Bind `geos_c` `_r` functions ONLY via the declarative table in `src/symbols.ts`;
  keep its binding rules: `cstring` for `const char*` args; `returns: "ptr"` +
  `CString` + `GEOSFree_r` for GEOS-owned strings (a `cstring` return leaks them, F10);
  failed pointer returns are JS `null`, never `0`.
- Branded handles (`GeomPtr`, `GeosCtx`, `ShimPtr`, `PreparedPtr`, `StrTreePtr`, … in
  `src/types.ts`) are the type system's guard against the F8 wrapper/context mixup —
  never widen them. New in Phase 2: `PreparedPred` / `UnionStrategy` numeric ids MUST
  match the shim's `SHIM_PREP_*` / `SHIM_UNION_*` enums (the selftest pins them).
  Phase 5: `UnaryOp` / `BinaryOp` MUST match the shim's `SHIM_UNARY_*` /
  `SHIM_BINARY_*` (selftest scenarios 29–30). INT-returning GEOS functions
  (`GEOSMinimumClearance_r` = 0 ok / 2 failure, `GEOSGridIntersectionFractions_r` =
  1 ok / 0 fail) are NOT masked.
- Char-returning GEOS predicates need `& 0xff` (upper register bits are garbage —
  x86-64 psABI); see `charResult` in `src/ops/predicates.ts`. EXCEPTION: int returns
  (`GEOSOrientPolygons_r` = 0 ok / -1 failure, `geos_shim_strtree_nearest` = -1/-2)
  are NOT masked — masking -1 reads 255.
- GEOS quirk (verified in geos_ts_c.cpp): `createCollection`/`createPolygon`/
  `createLineString`/`createPoint` consume their inputs EVEN ON FAILURE (the
  unique_ptr move happens before construction). Never free a consumed input on
  the error path — the shim comments document each site.
- All geometry creation flows through `Geos.take()` (registration, stats, arena,
  finalization backstop). Never bind a raw `GEOSGeom_destroy_r` call outside
  `geos.ts`/the shim. Unregistered temporaries from shim calls are freed via
  `Geos.destroyRaw` only (coverage ops pattern).
- Consumer pins (D17): `Prepared`/`STRtree` register via `Geos.registerConsumable`
  and pin their source geometries (`geometry.pinBy`) — pinned geometry disposal
  throws, arena ownership is relinquished at pin time, and `Geos[Symbol.dispose]`
  tears down consumables FIRST. Never destroy a pinned geometry's C object.
- STRtree items are integer ids, never geometry pointers (D16) — the plain
  `GEOSSTRtree_nearest` is UNUSABLE with id items (it derefs items); nearest goes
  through the shim's `nearest_generic` wrapper + bound id→geom table.
- Interrupt flag (D19): atomic GLOBAL in the shim, never thread-local; every
  signal-taking op resets it in `finally` (`withSignal`). No op may leave the flag
  set on return.
- Coverage/repair outputs are OWNED clones (`geos_shim_clone_members`), never
  borrowed views into an internal collection; error diagnostics are strings (D21).
- src/ may not `console.log` (Biome `noConsole`); scripts/, spike/, bench/, and test/
  may.

## Phase 3 house rules (from docs/decisions.md D22–D25 — binding)

- New shim batch functions (`geos_shim_*_all`) follow the D18 contract exactly:
  return `0 ok / 1 exception / 2 interrupted`; **partial C outputs are destroyed
  before returning** (shared `destroy_partials`); interrupt checks between items.
  Op-id tables in the shim (`SHIM_OVERLAY_*`/`SHIM_PRED_*`/`SHIM_MEASURE_*`)
  MUST match `OverlayOp`/`UnpreparedPred`/`MeasureOp` in `src/types.ts` and are
  pinned by known-answer selftests (scenarios 20–28) — never renumber casually.
- `GEOSGeomGetNumPoints_r` is LINESTRING-ONLY: any type-generic vertex counting
  goes through the shim's `vertex_count` (polygons sum rings, collections
  recurse) — never call the raw accessor on arbitrary geometry.
- Batch outputs wrap via `Geos.takeMany`; batch inputs normalize through
  `withBatchInputs`, which captures the caller's arena BEFORE opening the
  transient one — never capture `currentArena()` inside its callback (that
  grabs the transient arena and frees the outputs: a measured use-after-free).
- Element-wise batch naming is `*All` (`intersectionAll(a, bs)[i] =
  intersection(a, bs[i])`); `unionAll(gs)` stays the aggregate (D20). No
  element-wise `unionAll(a, bs)`, ever.
- `geos.parallel` (D23): at most ONE signal-taking parallel op in flight per
  pool; results reassemble in input order; failures aggregate into
  `GeosParallelError` (strings only); workers get the shutdown-ack protocol
  (`bye` before terminate). Worker jobs carry watchdogs (`jobTimeoutMs`);
  the Bun 1.4.3 worker-dispatch flake (parent futex-deadlock under heap
  churn) is re-verified on every Bun bump — the bench runs the pool suite in
  a dedicated process (`bench/parallel.ts`), keep it that way.
- Batch measure/mask output arrays are discarded wholesale on failure
  (all-or-nothing) — the C side may leave prefix entries written; that is
  fine, but C-side geometry outputs are always fully destroyed.

## Reference

- Bun API docs are vendored locally: `node_modules/bun-types/docs/guides/**/*.mdx`; type definitions in `node_modules/bun-types/*.d.ts`.
