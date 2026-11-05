/**
 * The Cirth docs-site sync (`bun run docs:site`).
 *
 * The live site (bun-geos.cirth.app) imports the `site/` tree from `main`
 * DIRECTLY — the docs-site orphan-branch workflow was retired (0.3.0). The
 * Cirth poller picks up pushes to main, so publishing is: edit `site/`,
 * push, and (when a page was edited in Cirth) one full refresh with
 * "repository wins" on the dashboard's Import page.
 *
 * The generated tree is `site/changelog/`: Cirth's changelog SECTION is a
 * feed with one dated entry per release, so the old whole-file mirror
 * (`site/docs/changelog.md`) is gone. CHANGELOG.md stays the single
 * source; the sync splits it per `## <version>` heading into entry pages
 * carrying exactly the front-matter keys the importer maps (title, slug —
 * there is NO date key: feed order is first-publish time with a
 * path-ascending tie-break, and semver order is chronological order here,
 * so one batch import lands in release order). The section index is
 * rendered from the file's preamble. `## Unreleased` is skipped — it must
 * not leak into the public feed before release. Display dates are
 * first-publish times, so the historical entries all carry the import
 * day; that is the platform's honest behavior, accepted.
 *
 * The permanent gates live in `test/unit/site.test.ts`: the release↔page
 * bijection (no strays, no Unreleased page), and — for the hand-written
 * pages — the site-absolute link discipline and the no-D-references rule
 * (the whole generated changelog/ tree is exempt: it mirrors the root
 * file, whose D-references are its own historical record).
 *
 * Usage: bun run docs:site
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const GITHUB_BASE = "https://github.com/AbdukahharS/bun-geos";
const UNRELEASED = "unreleased";

/** A `## <version> …` section of CHANGELOG.md (Unreleased is filtered out). */
export interface ReleaseSection {
  /** The version token, e.g. "0.3.0". */
  version: string;
  /** The full heading text, e.g. "0.3.0 — the crossing-amortized boundary". */
  heading: string;
  /** The body below the heading: leading blanks stripped, one trailing \n. */
  body: string;
}

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

interface RawSection {
  heading: string;
  body: string[];
}

/**
 * Split CHANGELOG.md into its preamble (everything before the first
 * `## ` heading) and its release sections. `## Unreleased` is recognized
 * and dropped here — the public feed only ever sees shipped releases.
 */
export function splitChangelog(text: string): {
  preamble: string;
  releases: ReleaseSection[];
} {
  const sections: RawSection[] = [];
  const preambleLines: string[] = [];
  let current: RawSection | undefined;
  for (const line of text.split("\n")) {
    if (/^## /.test(line)) {
      current = { heading: line.slice(3).trim(), body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    else preambleLines.push(line);
  }
  if (sections.length === 0) throw new Error("CHANGELOG.md: no `## ` sections found");

  const releases: ReleaseSection[] = [];
  for (const { heading, body } of sections) {
    const version = heading.split(/\s+/)[0];
    if (!version) throw new Error(`CHANGELOG.md: malformed section heading "## ${heading}"`);
    if (version.toLowerCase() === UNRELEASED) continue;
    releases.push({
      version,
      // the feed renders titles as plain text — bold markers would show literally
      heading: heading.replaceAll("**", ""),
      body: `${body.join("\n")}`.replace(/^\n+/, "").replace(/\s+$/, "\n"),
    });
  }
  return { preamble: preambleLines.join("\n").trim(), releases };
}

/** The entry slug for a version: dots dashed — "0.3.0" feeds at /changelog/0-3-0. */
export function releaseSlug(version: string): string {
  return version.replaceAll(".", "-");
}

/** Front matter carrying only the keys the Cirth importer maps. */
function entryFrontMatter(title: string, slug: string): string {
  // JSON.stringify is a valid YAML double-quoted scalar (\" escapes only).
  return `---\ntitle: ${JSON.stringify(title)}\nslug: ${slug}\n---\n`;
}

/**
 * The full generated `site/changelog/` tree as `<file name, content>`
 * (paths relative to `site/changelog/`): the section index rendered from
 * the CHANGELOG preamble, plus one front-mattered entry page per release
 * section. Deterministic; the CLI writes exactly this, the freshness gate
 * compares exactly this.
 */
export function generateChangelogSite(changelog: string): Map<string, string> {
  const { preamble, releases } = splitChangelog(changelog);
  // The feed layout renders the section name itself — the preamble's H1
  // is dropped, the page title carries "Changelog".
  const intro = preamble.replace(/^#\s+[^\n]*\n*/, "").trim();
  const tree = new Map<string, string>();
  tree.set("_index.md", `${pointLinksAtGithub(intro)}\n`);
  for (const { version, heading, body } of releases) {
    const slug = releaseSlug(version);
    tree.set(`${slug}.md`, `${entryFrontMatter(heading, slug)}\n${pointLinksAtGithub(body)}`);
  }
  // plain (non-locale) ordering — deterministic everywhere, matches the gate
  return new Map([...tree].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

if (import.meta.main) {
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  const target = join(ROOT, "site", "changelog");
  const tree = generateChangelogSite(changelog);
  mkdirSync(target, { recursive: true });
  for (const existing of readdirSync(target)) {
    if (!tree.has(existing)) {
      rmSync(join(target, existing), { recursive: true });
      console.log(`site-sync: removed stale site/changelog/${existing}`);
    }
  }
  for (const [name, content] of tree) writeFileSync(join(target, name), content);
  console.log(`site-sync: site/changelog/ written from CHANGELOG.md (${tree.size} files)`);
}
