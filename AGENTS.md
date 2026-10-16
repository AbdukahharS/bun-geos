# bun-geos

Bun-native TypeScript library wrapping GEOS 3.14 (`bun:ffi` + a small C shim).
Phase 1 (core) is implemented under `src/`; the Phase 0 spike remains under
`spike/` as the FFI-semantics regression net; research/design/operations docs
live in `docs/`.

## Layout

```
index.ts                 public barrel — re-exports src/index.ts
src/                     the library (loader, symbols, geos/geometry/arena,
                         construct, ops/, io/)
native/shim.c            the entire C surface (~300 lines, reviewed as prose)
scripts/build-native.ts  bun run build:native — GEOS 3.14.1 + shim → build/native/
test/
  unit/ properties/ soak/ differential/   bun test test/
  native/shim_selftest.c                  bun run test:native (ASan/UBSan)
spike/                   Phase 0 evidence; `bun test spike/` gates Bun bumps
vendor/, build/          GEOS checkout + native build tree (gitignored)
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

## Phase 1 house rules (from docs/decisions.md — binding)

- Bind `geos_c` `_r` functions ONLY via the declarative table in `src/symbols.ts`;
  keep its binding rules: `cstring` for `const char*` args; `returns: "ptr"` +
  `CString` + `GEOSFree_r` for GEOS-owned strings (a `cstring` return leaks them, F10);
  failed pointer returns are JS `null`, never `0`.
- Branded handles (`GeomPtr`, `GeosCtx`, `ShimPtr` in `src/types.ts`) are the type
  system's guard against the F8 wrapper/context mixup — never widen them.
- Char-returning GEOS predicates need `& 0xff` (upper register bits are garbage —
  x86-64 psABI); see `charResult` in `src/ops/predicates.ts`.
- GEOS quirk (verified in geos_ts_c.cpp): `createCollection`/`createPolygon`/
  `createLineString`/`createPoint` consume their inputs EVEN ON FAILURE (the
  unique_ptr move happens before construction). Never free a consumed input on
  the error path — the shim comments document each site.
- All geometry creation flows through `Geos.take()` (registration, stats, arena,
  finalization backstop). Never bind a raw `GEOSGeom_destroy_r` call outside
  `geos.ts`/the shim.
- src/ may not `console.log` (Biome `noConsole`); scripts/ and spike/ may.

## Reference

- Bun API docs are vendored locally: `node_modules/bun-types/docs/guides/**/*.mdx`; type definitions in `node_modules/bun-types/*.d.ts`.
