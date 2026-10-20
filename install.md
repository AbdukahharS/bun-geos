# Install & platforms

## Requirements

- [Bun](https://bun.com) ≥ **1.4.3** (the tested pin; the tested range is documented per
  release)
- Nothing else. Really — keep reading.

```sh
bun add @shzd/bun-geos
```

The install is self-contained: a pinned GEOS 3.14 build plus a tiny precompiled C shim,
~5.5 MB per platform. No system GEOS, no compiler, no CMake. Because the package ships
raw TypeScript source (Bun executes TS natively), your bundler/typechecker reads the same
source you'd read — there is no build step between this repo and your `node_modules`.

**Bun-only, by design.** Node.js and browsers are not supported and there is no WASM
build — that decision is not up for debate. For browser workloads, use
[geos-wasm](https://github.com/chrispahm/geos-wasm).

## Platform packages

One of seven platform packages is selected automatically via `optionalDependencies`
(`os`/`cpu`/`libc` fields — the sharp/esbuild model):

| OS | Arch | libc | Package |
|----|------|------|---------|
| macOS | arm64, x64 | — | `@shzd/bun-geos-darwin-{arm64,x64}` |
| Linux | arm64, x64 | glibc | `@shzd/bun-geos-linux-{arm64,x64}-gnu` |
| Linux | arm64, x64 | musl | `@shzd/bun-geos-linux-{arm64,x64}-musl` |
| Windows | x64 | — | `@shzd/bun-geos-win32-x64` |

Notes from the field:

- **Linux**: Bun's installer downloads **both** the glibc and musl variants and the
  loader self-selects at runtime. This is a known Bun installer behavior, not a bug —
  it is why your `node_modules` is heavier than the table above suggests.
- **Windows**: GEOS is built with the dynamic VC++ runtime — the usual
  [VC++ 2015–2022 redistributable](https://aka.ms/vs/17/release/vc_redist.x64.exe) must
  be present. Most machines have it; CI runners do.

## Verify the install

```ts
import { Geos } from "@shzd/bun-geos";

using geos = new Geos();
console.log(geos.version); // "3.14.x" — the pinned GEOS the shim was built against
```

If `new Geos()` throws, it is a `LoaderError` — see the next section. Anything else
failing at import time is a bug; [file it](https://github.com/AbdukahharS/bun-geos/issues).

## Loader errors, and what each one means

The loader fails loudly and specifically. The messages you can hit:

- **"no native libraries found"** — the platform package for your OS/arch isn't installed
  (you probably installed with `--no-optional` or a frozen lockfile from another
  platform). Reinstall without excluding optionals, or run `bun run build:native` in a
  checkout of the repo.
- **"shim not found at …"** — the platform package is installed but damaged/incomplete.
  Reinstall the package.
- **"BUN_GEOS_LIBRARY points at a missing file"** — see the override below.
- **"native libraries are already loaded with a different BUN_GEOS_LIBRARY"** — you
  created two `Geos` contexts with different library settings in one process. One GEOS
  per process; create all contexts with the same setting (or none — the default).

## Overriding the GEOS library

You can point the loader at a specific `libgeos_c` instead of the bundled one:

```sh
BUN_GEOS_LIBRARY=/usr/lib/x86_64-linux-gnu/libgeos_c.so.1 bun run app.ts
```

```ts
// …or per-context, in code (must be consistent for the whole process):
using geos = new Geos({ library: "/usr/lib/libgeos_c.so.1" });
```

The first load pins the process; every later `Geos` must use the same setting or the
loader refuses (a silently-ignored second override would be split-brain). The override
is asserted to be GEOS **3.14.x** at load — a mismatching library fails with remediation
text, not a mystery crash two hours later. Exotic setups (debugging against a system
GEOS, unsupported platforms) are exactly what this escape hatch is for; everything else
should use the bundled build.

## Licensing

`@shzd/bun-geos` is MIT. The bundled GEOS binaries are LGPL-2.1+, dynamically linked,
unmodified, built from the pinned release tarball — the license text and source link ship
in **every platform package**, so your distribution obligations are the usual
LGPL dynamic-linking ones. Same compliance model as Shapely's wheels and geos-wasm.
