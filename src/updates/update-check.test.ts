import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, readUpdateCheck, storeHouseholdFacts } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import type { Repository } from "../version.ts";
import { startUpdateCheck, switchUpdateCheck, UpdateCheckJob, updateStatus } from "./index.ts";

// The daily Update check (spec 12, Updates), against a stubbed GitHub releases API. No test
// reaches GitHub.

const OURS = "git+https://github.com/therecluse26/family-finance-tracker.git";
const FORK = "git+https://github.com/some-fork/fft-fork.git";

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

// A stub of the global fetch. Each request takes the next answer, or a release tagged `tag`.
class StubGitHub {
  readonly sent: Sent[] = [];
  readonly answers: (Response | Error)[] = [];
  tag = "v1.3.0";

  readonly fetch: typeof fetch = async (input, init) => {
    this.sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
    });
    const answer = this.answers.shift();
    if (answer instanceof Error) throw answer;
    return (
      answer ??
      Response.json({
        tag_name: this.tag,
        name: `Release ${this.tag}`,
        html_url: "https://elsewhere.example/notes",
        draft: false,
        prerelease: false,
      })
    );
  };
}

describe("the Update check", () => {
  let test: TestDatabase;
  let database: Database;
  let github: StubGitHub;
  let stop: (() => void) | undefined;

  beforeEach(async () => {
    test = await newTestDatabase();
    database = test.database;
    github = new StubGitHub();
  });

  afterEach(() => {
    stop?.();
    test.close();
  });

  const start = (repository: Repository = OURS) => {
    stop = startUpdateCheck({
      database,
      fetch: github.fetch,
      now: () => new Date("2026-11-04T10:00:00.000Z"),
      repository,
    }).stop;
  };
  const runCheck = () => new UpdateCheckJob().run();
  const status = (version: string, repository: Repository = OURS) =>
    updateStatus(database, { version, repository });

  it("is on by default, and asks GitHub's releases API with a request that holds nothing about the Household", async () => {
    await storeHouseholdFacts(database, {
      zipCode: "10001",
      state: "NY",
      timeZone: "America/New_York",
      ages: [41, 39, 8],
      rentOrOwn: "rent",
      updatedAt: new Date("2026-11-01T00:00:00.000Z"),
      updatedBy: null,
    });
    start();

    await runCheck();

    expect(github.sent).toEqual([
      {
        url: "https://api.github.com/repos/therecluse26/family-finance-tracker/releases/latest",
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": expect.stringMatching(/^family-finance-tracker\/\d+\.\d+\.\d+$/),
        },
        body: undefined,
      },
    ]);
    const text = JSON.stringify(github.sent);
    for (const fact of ["10001", "NY", "41", "39", "rent", "America"]) {
      expect(text).not.toContain(fact);
    }
    expect((await status("1.2.0")).checkedAt).toEqual(new Date("2026-11-04T10:00:00.000Z"));
  });

  it("shows a newer minor version as an update, with no image change", async () => {
    start();

    await runCheck();

    expect(await status("1.2.0")).toEqual({
      on: true,
      checkedAt: new Date("2026-11-04T10:00:00.000Z"),
      update: {
        version: "1.3.0",
        newMajor: false,
        imageMajor: { now: 1, update: 1 },
        releaseNotes: "https://github.com/therecluse26/family-finance-tracker/releases/tag/v1.3.0",
      },
      lastFailure: null,
    });
  });

  it("marks a newer major version, which needs a new image version in compose.yaml, and links its release notes", async () => {
    github.tag = "v2.0.0";
    start();

    await runCheck();

    expect((await status("1.2.0")).update).toEqual({
      version: "2.0.0",
      newMajor: true,
      imageMajor: { now: 1, update: 2 },
      releaseNotes: "https://github.com/therecluse26/family-finance-tracker/releases/tag/v2.0.0",
    });
  });

  it("shows no update for the running version or an older one", async () => {
    github.tag = "v1.2.0";
    start();

    await runCheck();

    expect((await status("1.2.0")).update).toBeNull();
    expect((await status("1.10.0")).update).toBeNull();
    expect((await status("1.1.9")).update).toMatchObject({ version: "1.2.0" });
  });

  it("asks a fork's own repository, and links the fork's release notes", async () => {
    start(FORK);

    await runCheck();

    expect(github.sent.map((sent) => sent.url)).toEqual([
      "https://api.github.com/repos/some-fork/fft-fork/releases/latest",
    ]);
    expect((await status("1.2.0", FORK)).update?.releaseNotes).toBe(
      "https://github.com/some-fork/fft-fork/releases/tag/v1.3.0",
    );
  });

  it("makes no request for a repository outside GitHub", async () => {
    start("https://gitlab.com/someone/fft.git");

    await runCheck();

    expect(github.sent).toEqual([]);
  });

  it("makes no request once a Member turns it off, and shows no update while off", async () => {
    start();
    await runCheck();
    expect(github.sent).toHaveLength(1);

    const off = await switchUpdateCheck(database, false);

    expect(off).toMatchObject({ on: false, update: null });
    await runCheck();
    await runCheck();
    expect(github.sent).toHaveLength(1);

    const on = await switchUpdateCheck(database, true);
    expect(on).toMatchObject({ on: true });
    await runCheck();
    expect(github.sent).toHaveLength(2);
  });

  it.each([
    ["a request error", new TypeError("fetch failed"), "unreachable"],
    ["a timeout", new DOMException("The operation timed out.", "TimeoutError"), "timed out"],
    ["a 429", new Response("", { status: 429 }), "rate limited"],
    [
      "a 403 with no requests left",
      new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      "rate limited",
    ],
    ["another 403", new Response("", { status: 403 }), "refused"],
    ["a 502", new Response("", { status: 502 }), "unreachable"],
    ["an answer that is not JSON", new Response("<html>"), "bad answer"],
    ["a tag that is not a release version", Response.json({ tag_name: "nightly" }), "bad answer"],
    ["a pre-release tag", Response.json({ tag_name: "v2.0.0-rc1" }), "bad answer"],
  ])(
    "maps %s to its own failure, makes one request, and keeps the last update it found",
    async (_case, answer, failure) => {
      start();
      await runCheck();
      github.answers.push(answer);

      await runCheck();

      expect(github.sent).toHaveLength(2);
      expect(await readUpdateCheck(database)).toMatchObject({
        latestVersion: "1.3.0",
        lastFailure: failure,
      });
      expect(await status("1.2.0")).toMatchObject({
        update: { version: "1.3.0" },
        lastFailure: failure,
      });
    },
  );

  it("stores no release for a repository with none yet", async () => {
    github.answers.push(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    start();

    await runCheck();

    expect(await status("1.2.0")).toMatchObject({
      checkedAt: new Date("2026-11-04T10:00:00.000Z"),
      update: null,
      lastFailure: null,
    });
  });
});
