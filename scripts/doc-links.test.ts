import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brokenLinks, headingAnchors, linkTargets } from "./doc-links.ts";

// The README and the setup guide (spec 12, The setup guide): their links work, and they hold only
// placeholder keys, tokens, and email addresses.

const DOCS = ["README.md", "docs/self-hosting.md"];

describe("the link check", () => {
  it("passes on the README and the setup guide", () => {
    for (const file of DOCS)
      expect({ file, broken: brokenLinks(file) }).toEqual({ file, broken: [] });
  });

  it("finds a missing file, a missing heading, an anchor into a file that is not Markdown, and a plain http:// link", () => {
    const files: Record<string, string> = {
      "/repo/docs/guide.md": [
        "# Guide",
        "[ok](../README.md#a-heading) [ok](#guide) [ok](https://example.com/x)",
        "[gone](missing.md) [no heading](../README.md#nothing) [not markdown](../LICENSE#x)",
        "[plain](http://example.com/)",
        "`[in code](missing-too.md)`",
        "```",
        "[in a block](missing-three.md)",
        "```",
        "1. A step:",
        "   ```sh",
        "   [in a list's block](missing-four.md)",
        "   ```",
      ].join("\n"),
      "/repo/README.md": "## A heading\n",
      "/repo/LICENSE": "text\n",
    };
    const read = (path: string) => {
      const text = files[path];
      if (text === undefined) throw new Error(`no ${path}`);
      return text;
    };
    const broken = brokenLinks("/repo/docs/guide.md", { read, exists: (path) => path in files });
    expect(broken).toEqual([
      { target: "missing.md", reason: "no such file" },
      { target: "../README.md#nothing", reason: "no heading with this anchor" },
      { target: "../LICENSE#x", reason: "an anchor into a file that is not Markdown" },
      {
        target: "http://example.com/",
        reason: "only https:// and mailto: addresses may leave the repo",
      },
    ]);
  });

  it("reads a heading's anchor as GitHub makes it", () => {
    const anchors = headingAnchors(
      [
        "## HTTPS: three ways",
        "### 1. Tailscale Serve (preferred)",
        "## The `fft` commands",
        "## Encrypt the host's disk",
        "## Changing `APP_URL`",
        "## Restore",
        "## Restore",
        "```",
        "## Not a heading",
        "```",
      ].join("\n"),
    );
    expect([...anchors]).toEqual([
      "https-three-ways",
      "1-tailscale-serve-preferred",
      "the-fft-commands",
      "encrypt-the-hosts-disk",
      "changing-app_url",
      "restore",
      "restore-1",
    ]);
  });

  it("reads each link's target, with its title dropped", () => {
    expect(linkTargets('[a](docs/self-hosting.md#restore "Restore") [b](#x)')).toEqual([
      "docs/self-hosting.md#restore",
      "#x",
    ]);
  });
});

describe("the setup guide's placeholders", () => {
  for (const file of DOCS) {
    const text = readFileSync(file, "utf8");

    it(`${file} holds no Master key, Plaid key, or token`, () => {
      // A Master key is 64 hexadecimal characters; Plaid's client ID 24, and its secret 30.
      expect(text.match(/[0-9a-f]{20,}/gi) ?? []).toEqual([]);
      expect(text.match(/\b(?:access|link|public)-(?:production|sandbox)-[\w-]+/g) ?? []).toEqual(
        [],
      );
    });

    it(`${file} shows only the placeholder setup code`, () => {
      for (const [, code] of text.matchAll(/#code=([^\s`)]*)/g))
        expect(code).toBe("XXXX-XXXX-XXXX");
    });

    it(`${file} names only example.com email addresses`, () => {
      for (const [address] of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
        expect(address).toMatch(/@example\.com$/);
      }
    });
  }
});
