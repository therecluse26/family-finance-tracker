import * as z from "zod";
import {
  type Database,
  readUpdateCheck,
  storeUpdateCheckEnabled,
  storeUpdateChecked,
  storeUpdateFailure,
} from "../db/index.ts";
import { Job } from "../jobs/index.ts";
import { log } from "../log.ts";
import {
  APP_VERSION,
  githubRepository,
  REPOSITORY,
  type Repository,
  repositoryUrl,
  USER_AGENT,
} from "../version.ts";

// The daily Update check (spec 12, Updates). Once a day the app asks the GitHub releases API of
// package.json's `repository` for the latest release. Settings then show "Update available", with
// the new version; for a new major version they also say that the image version in compose.yaml
// must change, and link to the release notes. The check is on by default, and any Member may turn
// it off; off means no request. The request holds nothing about the Household (spec 01, 11.
// Privacy): a fixed URL, GitHub's Accept and API version headers, and the app's name and version.
// A failed check waits for the next day; it has no retry of its own.

export const GITHUB_API = "https://api.github.com";

const TIMEOUT_MS = 20_000;

// Why a check made no request, or why GitHub's answer gave no latest release.
export type UpdateCheckFailure =
  | "timed out"
  | "unreachable"
  | "rate limited"
  | "refused"
  | "bad answer";

export type UpdateCheckResult =
  | "off"
  | "not on GitHub"
  | "checked"
  | "no release"
  | UpdateCheckFailure;

// A release version, such as 1.2.0, from its tag, such as v1.2.0. Pre-release tags are not read.
const RELEASE_TAG = /^v?(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

type Version = [major: number, minor: number, patch: number];

function versionOf(text: string): Version | undefined {
  const match = RELEASE_TAG.exec(text);
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Below 0 when a is older than b, 0 when the same, above 0 when newer.
function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const latestReleaseSchema = z.object({ tag_name: z.string() });

function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// The latest release of the repository on GitHub, or why there is none.
async function latestRelease(
  fetcher: typeof fetch,
  repo: { owner: string; name: string },
): Promise<{ version: string; tag: string } | "no release" | UpdateCheckFailure> {
  try {
    const res = await fetcher(`${GITHUB_API}/repos/${repo.owner}/${repo.name}/releases/latest`, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // GitHub answers 404 for a repository with no release yet.
    if (res.status === 404) return "no release";
    // GitHub answers its rate limit with 429, or 403 and no requests left.
    if (
      res.status === 429 ||
      (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    ) {
      return "rate limited";
    }
    if (!res.ok) return res.status >= 500 ? "unreachable" : "refused";
    const answer = latestReleaseSchema.safeParse(await res.json().catch(() => undefined));
    if (!answer.success) return "bad answer";
    const tag = answer.data.tag_name;
    const version = versionOf(tag);
    if (version === undefined) return "bad answer";
    return { version: version.join("."), tag };
  } catch (error) {
    return timedOut(error) ? "timed out" : "unreachable";
  }
}

type UpdateServices = {
  database: Database;
  fetch: typeof fetch;
  now: () => Date;
  repository: Repository;
};

// One check. Off, or for a repository outside GitHub, it makes no request. It never throws for a
// failed request.
async function checkForUpdate(services: UpdateServices): Promise<UpdateCheckResult> {
  const { database } = services;
  if (!(await readUpdateCheck(database)).enabled) return "off";
  const repo = githubRepository(services.repository);
  if (repo === undefined) return "not on GitHub";
  const latest = await latestRelease(services.fetch, repo);
  if (typeof latest === "string" && latest !== "no release") {
    await storeUpdateFailure(database, latest);
    log.warn("The Update check failed; it runs again tomorrow", { failure: latest });
    return latest;
  }
  await storeUpdateChecked(database, latest === "no release" ? null : latest, services.now());
  log.info("Checked for an update", {
    latest: latest === "no release" ? null : latest.version,
  });
  return latest === "no release" ? latest : "checked";
}

let running: UpdateServices | undefined;

// The daily task's job. It is safe to run twice: a second run asks again and stores the same.
export class UpdateCheckJob extends Job {
  override async run(): Promise<void> {
    if (running === undefined) throw new Error("The Update check is not running.");
    await checkForUpdate(running);
  }
}

export type UpdateCheckOptions = {
  database: Database;
  // The HTTP client: the global fetch, or a stub in tests.
  fetch?: typeof fetch;
  now?: () => Date;
  // package.json's `repository` unless given, as a test gives a fork's.
  repository?: Repository;
};

// Gives the Update check app.db and its HTTP client. The start calls it before jobs run.
export function startUpdateCheck(options: UpdateCheckOptions): { stop(): void } {
  if (running !== undefined) throw new Error("The Update check is already running.");
  const started: UpdateServices = {
    database: options.database,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now: options.now ?? (() => new Date()),
    repository: options.repository ?? REPOSITORY,
  };
  running = started;
  return {
    stop() {
      if (running === started) running = undefined;
    },
  };
}

// A newer release than the running version.
export type AvailableUpdate = {
  version: string;
  // True for a new major version: the image version in compose.yaml must change.
  newMajor: boolean;
  // The major versions of the image tag in compose.yaml, now and for the update, such as 1 and 2.
  imageMajor: { now: number; update: number };
  // The release notes on GitHub.
  releaseNotes: string;
};

export type UpdateStatus = {
  on: boolean;
  // When GitHub last answered a check, or null.
  checkedAt: Date | null;
  // The newer release, or null when none is known or the check is off.
  update: AvailableUpdate | null;
  // Why the last check failed, or null.
  lastFailure: string | null;
};

// The newer release than `version` that the last check found, or null.
function availableUpdate(
  state: { latestVersion: string | null; latestTag: string | null },
  app: { version: string; repository: Repository },
): AvailableUpdate | null {
  const now = versionOf(app.version);
  const latest = state.latestVersion === null ? undefined : versionOf(state.latestVersion);
  const repoUrl = repositoryUrl(app.repository);
  if (now === undefined || latest === undefined || state.latestTag === null) return null;
  if (repoUrl === undefined || compareVersions(latest, now) <= 0) return null;
  return {
    version: latest.join("."),
    newMajor: latest[0] > now[0],
    imageMajor: { now: now[0], update: latest[0] },
    releaseNotes: `${repoUrl}/releases/tag/${encodeURIComponent(state.latestTag)}`,
  };
}

// What Settings, About shows. The comparison runs on each read, so once the image is updated the
// stored latest release no longer shows as an update. With the check off, nothing shows.
export async function updateStatus(
  database: Database,
  app: { version: string; repository: Repository } = {
    version: APP_VERSION,
    repository: REPOSITORY,
  },
): Promise<UpdateStatus> {
  const state = await readUpdateCheck(database);
  return {
    on: state.enabled,
    checkedAt: state.checkedAt,
    update: state.enabled ? availableUpdate(state, app) : null,
    lastFailure: state.enabled ? state.lastFailure : null,
  };
}

// Turns the check on or off for the whole Household.
export async function switchUpdateCheck(database: Database, on: boolean): Promise<UpdateStatus> {
  await storeUpdateCheckEnabled(database, on);
  log.info("Switched the Update check", { on });
  return updateStatus(database);
}
