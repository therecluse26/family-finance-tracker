import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_VERSION,
  githubRepository,
  repositoryUrl,
  SOURCE_CODE_LINK,
  sourceCodeLink,
  USER_AGENT,
} from "./version.ts";

// The version and the "Source code" link the build writes into the app (spec 10, Version and
// source link).

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("the version and the Source code link", () => {
  it("come from package.json: its version, and its repository at the release's tag", () => {
    expect(APP_VERSION).toBe(packageJson.version);
    expect(SOURCE_CODE_LINK).toBe(
      `https://github.com/therecluse26/family-finance-tracker/tree/v${packageJson.version}`,
    );
    expect(USER_AGENT).toBe(`family-finance-tracker/${packageJson.version}`);
  });

  it("links a fork that changes repository to the fork's own code", () => {
    expect(
      sourceCodeLink(
        { type: "git", url: "git+https://github.com/some-fork/fft-fork.git" },
        "1.4.2",
      ),
    ).toBe("https://github.com/some-fork/fft-fork/tree/v1.4.2");
  });

  it.each([
    ["git+https://github.com/some-fork/fft-fork.git", "https://github.com/some-fork/fft-fork"],
    ["https://github.com/some-fork/fft-fork", "https://github.com/some-fork/fft-fork"],
    ["git://github.com/some-fork/fft-fork.git", "https://github.com/some-fork/fft-fork"],
    ["git+ssh://git@github.com/some-fork/fft-fork.git", "https://github.com/some-fork/fft-fork"],
    ["git@github.com:some-fork/fft-fork.git", "https://github.com/some-fork/fft-fork"],
    ["some-fork/fft-fork", "https://github.com/some-fork/fft-fork"],
    ["github:some-fork/fft-fork", "https://github.com/some-fork/fft-fork"],
    ["gitlab:some-fork/fft-fork", "https://gitlab.com/some-fork/fft-fork"],
    ["https://git.example.org/team/apps/fft.git", "https://git.example.org/team/apps/fft"],
  ])("reads the repository %s", (repository, url) => {
    expect(repositoryUrl(repository)).toBe(url);
  });

  it.each([
    "",
    "not a repository",
    "file:///home/someone/fft",
    "https://github.com/",
    "javascript:alert(1)",
  ])("refuses %j, so the build fails rather than ship no Source code link", (repository) => {
    expect(repositoryUrl(repository)).toBeUndefined();
    expect(() => sourceCodeLink(repository, "1.0.0")).toThrow(/repository field/);
  });

  it("asks GitHub's releases API only for a GitHub repository", () => {
    expect(githubRepository("git+https://github.com/some-fork/fft-fork.git")).toEqual({
      owner: "some-fork",
      name: "fft-fork",
    });
    expect(githubRepository("gitlab:some-fork/fft-fork")).toBeUndefined();
    expect(githubRepository("https://github.com/some-fork/fft-fork/tree/main")).toBeUndefined();
  });
});
