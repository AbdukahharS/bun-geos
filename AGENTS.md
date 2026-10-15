# bun-geos

Small single-package Bun project. Entrypoint is `index.ts`; no src/, no tests, no CI yet.

## Toolchain: Bun, not Node

Default to Bun for everything (Bun 1.4.x, TypeScript ^7 native as peerDependency):

- Run a file: `bun <file>` — never `node` / `ts-node`
- Install: `bun install` — never npm/yarn/pnpm
- Typecheck: `bun check` (alias `bun run typecheck`); one file: `bun check src/index.ts`
- Test: `bun test`; single file/filter: `bun test <file>` or `bun test -t <name>`
- Scripts: `bun run <script>`; one-off binaries: `bunx <pkg> <cmd>`
- Shell out from code with `Bun.$` instead of execa

## TypeScript gotchas (tsconfig.json)

- `verbatimModuleSyntax` is on: type-only imports must use `import type`.
- `allowImportingTsExtensions` + bundler resolution: relative imports use `.ts` extensions; there is no build step (`noEmit`) — Bun runs TS directly.
- `noUncheckedIndexedAccess` is on: `arr[i]` and `obj[key]` are `T | undefined`.
- `strict` is on.

## Bun runtime conventions

- Bun auto-loads `.env` / `.env.local`; don't add dotenv.
- Prefer built-ins over extra dependencies: `Bun.serve()` (not express), `bun:sqlite` (not better-sqlite3), `Bun.sql` (not pg), `Bun.redis` (not ioredis), built-in `WebSocket` (not ws), `Bun.file` over node:fs read/write.

## Reference

- Bun API docs are vendored locally: `node_modules/bun-types/docs/guides/**/*.mdx`; type definitions in `node_modules/bun-types/*.d.ts`.
