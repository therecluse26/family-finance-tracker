import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { brokenLinks } from "./doc-links.ts";

// What each release changes with its version (docs/releasing.md): the quick start's fetch
// addresses, and the release notes the release job reads.

const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const TAG = `v${version}`;
const REPO = "therecluse26/family-finance-tracker";

describe("the release", () => {
  it.each(["README.md", "docs/self-hosting.md"])(
    "%s fetches compose.yaml and .env.example from the release's tag",
    (file) => {
      const raw = [
        ...readFileSync(file, "utf8").matchAll(/https:\/\/raw\.githubusercontent\.com\/\S+/g),
      ];

      expect(raw.map(([address]) => address)).toEqual([
        `https://raw.githubusercontent.com/${REPO}/${TAG}/compose.yaml`,
        `https://raw.githubusercontent.com/${REPO}/${TAG}/.env.example`,
      ]);
    },
  );

  it("has release notes that link the setup guide at the release's tag", () => {
    const notes = `docs/release-notes/${TAG}.md`;

    expect(existsSync(notes)).toBe(true);
    expect(readFileSync(notes, "utf8")).toContain(
      `(https://github.com/${REPO}/blob/${TAG}/docs/self-hosting.md)`,
    );
  });

  it("has release steps whose links work", () => {
    expect(brokenLinks("docs/releasing.md")).toEqual([]);
  });
});
