# bun-geos

Small single-package Bun project. Entrypoint is `index.ts` (placeholder until Phase 1 creates
`src/`); tests live in `spike/` for now; CI is a single ubuntu job (`.github/workflows/ci.yml`).

## Toolchain: Bun, not Node

Default to Bun for everything (Bun 1.4.x, TypeScript ^7 native as peerDependency):

- Run a file: `bun <file>` — never `node` / `ts-node`
- Install: `bun install` — never npm/yarn/pnpm
- Typecheck: `bun check` (alias `bun run typecheck`); one file: `bun check src/index.ts`
- Test: `bun test`; spike suite: `bun test spike/` (needs native libs: `./spike/setup.sh`)
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

## Reference

- Bun API docs are vendored locally: `node_modules/bun-types/docs/guides/**/*.mdx`; type definitions in `node_modules/bun-types/*.d.ts`.
