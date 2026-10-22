/**
 * Best-effort installed-package version: resolve the module, walk up to its
 * package root, read the manifest. Purely informational metadata for the
 * report — never load-bearing.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function installedVersion(spec: string): string {
  try {
    const resolved = Bun.resolveSync(spec, import.meta.dir);
    let dir = dirname(resolved);
    for (let i = 0; i < 6; i++) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.version !== undefined) return `${spec} ${pkg.version}`;
      }
      dir = dirname(dir);
    }
  } catch {
    // not installed / unresolvable — caller falls back
  }
  return spec;
}
