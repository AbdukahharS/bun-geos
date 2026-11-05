/**
 * Cirth site gates (permanent). The docs-site-prepare script that used to
 * enforce these was retired when the site switched to importing `site/`
 * from `main` directly — the gates became tests instead of build steps:
 *   1. site/changelog/ is fresh — exactly what scripts/site-sync.ts
 *      generates from CHANGELOG.md: one front-mattered entry page per
 *      release section (never Unreleased), the rendered section index,
 *      no strays (regenerate with `bun run docs:site` when the changelog
 *      changes).
 *   2. Link discipline: every markdown link in a hand-written site page is
 *      site-absolute (/…), an in-page anchor, or external — Cirth preserves
 *      these verbatim and GitHub renders them as no-ops at worst.
 *   3. User-docs discipline: hand-written pages never cite D-number
 *      decisions (that language stays in docs/); the generated changelog
 *      tree is exempt (it mirrors the root file, whose D-references are
 *      its own historical record).
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { generateChangelogSite } from "../../scripts/site-sync.ts";

const ROOT = join(import.meta.dir, "..", "..");
const SITE = join(ROOT, "site");
const CHANGELOG_DIR = join(SITE, "changelog");
const GENERATED_PREFIX = "changelog/";
const FENCE_RE = /^\s*(?:>\s*)?(```|~~~)/;

/** Site pages, as `<dir>/<name>` (or bare name at the root), sorted. */
function sitePages(): string[] {
  const pages: string[] = [];
  for (const entry of readdirSync(SITE).sort()) {
    const p = join(SITE, entry);
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p).sort()) if (f.endsWith(".md")) pages.push(`${entry}/${f}`);
    } else if (entry.endsWith(".md")) {
      pages.push(entry);
    }
  }
  return pages;
}

describe("cirth site gates", () => {
  it("site/changelog/ is fresh (generated from CHANGELOG.md)", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    const expected = generateChangelogSite(changelog);
    let onDisk: string[];
    try {
      onDisk = readdirSync(CHANGELOG_DIR);
    } catch {
      throw new Error("site/changelog/ is missing — run `bun run docs:site`");
    }
    const actual = new Map(
      onDisk.sort().map((name) => [name, readFileSync(join(CHANGELOG_DIR, name), "utf8")]),
    );
    expect([...actual.keys()]).toEqual([...expected.keys()]);
    for (const [name, content] of expected) expect(actual.get(name)).toEqual(content);
  });

  it("hand-written pages use only site-absolute, anchor or external links", () => {
    const failures: string[] = [];
    for (const page of sitePages()) {
      if (page.startsWith(GENERATED_PREFIX)) continue;
      const lines = readFileSync(join(SITE, page), "utf8").split("\n");
      let fenced = false;
      lines.forEach((line, i) => {
        if (FENCE_RE.test(line)) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        if (/\]\(\s*(?!#|\/|https?:\/\/|mailto:)[^)\s]+/.test(line)) {
          failures.push(`site/${page}:${i + 1} — relative link: ${line.trim()}`);
        }
      });
    }
    expect(failures).toEqual([]);
  });

  it("hand-written pages never cite D-number decisions", () => {
    const failures: string[] = [];
    for (const page of sitePages()) {
      if (page.startsWith(GENERATED_PREFIX)) continue;
      const lines = readFileSync(join(SITE, page), "utf8").split("\n");
      let fenced = false;
      lines.forEach((line, i) => {
        if (FENCE_RE.test(line)) {
          fenced = !fenced;
          return;
        }
        if (fenced) return;
        const m = line.match(/\bD\d+\b/);
        if (m) failures.push(`site/${page}:${i + 1} — cites "${m[0]}"`);
      });
    }
    expect(failures).toEqual([]);
  });
});
