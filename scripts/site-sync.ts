/**
 * The Cirth docs-site sync (`bun run docs:site`).
 *
 * The live site (bun-geos.cirth.app) imports the `site/` tree from `main`
 * DIRECTLY — the docs-site orphan-branch workflow was retired (0.3.0). The
 * Cirth poller picks up pushes to main, so publishing is: edit `site/`,
 * push, and (when a page was edited in Cirth) one full refresh with
 * "repository wins" on the dashboard's Import page.
 *
 * The only generated page is `site/changelog.md`: an exact mirror of the
 * root CHANGELOG.md with repo-relative links pointed at the GitHub tree
 * (the changelog legitimately cites dev docs the site does not carry).
 * The permanent gates live in `test/unit/site.test.ts`: changelog
 * freshness, the site-absolute link discipline, and the no-D-references
 * rule for the hand-written pages.
 *
 * Usage: bun run docs:site
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GITHUB_BASE = "https://github.com/AbdukahharS/bun-geos";

/**
 * Rewrite repo-relative markdown links to absolute GitHub URLs, outside
 * code fences (fences toggle on ```/~~~ including inside blockquotes —
 * the same walker the old docs-site-prepare step used).
 */
export function pointLinksAtGithub(text: string): string {
  const lines = text.split("\n");
  let fenced = false;
  return lines
    .map((line) => {
      if (/^\s*(?:>\s*)?(```|~~~)/.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced) return line;
      return line.replace(
        /\]\(\s*(?!#|\/|https?:\/\/|mailto:)([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g,
        (_whole, target: string, title: string) => `](${GITHUB_BASE}/blob/main/${target}${title})`,
      );
    })
    .join("\n");
}

if (import.meta.main) {
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  mkdirSync(join(ROOT, "site"), { recursive: true });
  writeFileSync(join(ROOT, "site", "changelog.md"), `${pointLinksAtGithub(changelog)}\n`);
  console.log("site-sync: site/changelog.md written from CHANGELOG.md");
}
