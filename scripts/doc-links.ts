import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// The link check for the README and the setup guide (spec 12, The setup guide). It checks every
// link to a file in the repo, and every `#anchor` into a Markdown file, against GitHub's heading
// anchors. It never opens a web address: an `https://` link is left as it is.

export type BrokenLink = { target: string; reason: string };

// Markdown with its fenced code blocks and inline code taken out, so a link-like text in code is
// not read as a link.
function withoutCode(markdown: string): string {
  return markdown.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "").replace(/`[^`\n]*`/g, "");
}

// GitHub's anchor for a heading: the text, lowercased, with only letters, marks, numbers,
// underscores, spaces, and hyphens kept, and each space made a hyphen. A repeated anchor gets -1,
// -2, and so on.
export function headingAnchors(markdown: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  const fenceless = markdown.replace(/^```[^\n]*\n[\s\S]*?^```$/gm, "");
  for (const [, heading] of fenceless.matchAll(/^#{1,6} +(.+?) *#* *$/gm)) {
    const text = (heading ?? "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[`*]/g, "")
      .toLowerCase();
    const base = text.replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

// Every link target in the Markdown: [text](target), with any title after a space dropped.
export function linkTargets(markdown: string): string[] {
  return [...withoutCode(markdown).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
    ([, target]) => target ?? "",
  );
}

// How the check reads files: the disk, or made-up files in a test.
export type DocFiles = { read(path: string): string; exists(path: string): boolean };

const DISK: DocFiles = { read: (path) => readFileSync(path, "utf8"), exists: existsSync };

// The links in `file` that point to no file in the repo, or to no heading in a Markdown file.
export function brokenLinks(file: string, files: DocFiles = DISK): BrokenLink[] {
  const markdown = files.read(file);
  const broken: BrokenLink[] = [];
  for (const target of linkTargets(markdown)) {
    if (/^(?:https:\/\/|mailto:)/.test(target)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      broken.push({ target, reason: "only https:// and mailto: addresses may leave the repo" });
      continue;
    }
    const [path = "", anchor] = target.split("#", 2);
    const linked = path === "" ? file : resolve(dirname(file), decodeURIComponent(path));
    if (!files.exists(linked)) {
      broken.push({ target, reason: "no such file" });
      continue;
    }
    if (anchor === undefined) continue;
    if (!linked.endsWith(".md")) {
      broken.push({ target, reason: "an anchor into a file that is not Markdown" });
    } else if (!headingAnchors(files.read(linked)).has(anchor)) {
      broken.push({ target, reason: "no heading with this anchor" });
    }
  }
  return broken;
}
