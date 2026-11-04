import packageJson from "../package.json" with { type: "json" };

// The app's version and its "Source code" link (spec 10, Version and source link). The build
// writes both into the app from package.json: the version, and the `repository` field plus the
// release's Git tag, "v" and the version. A fork that changes `repository` links to its own code,
// which meets the AGPL's network rule.

export const APP_VERSION: string = packageJson.version;

// The User-Agent of the app's own outside requests, such as the CPI fetch. It holds the app's name
// and version only: nothing about the Household, its Members, or the owner.
export const USER_AGENT = `${packageJson.name}/${packageJson.version}`;

// package.json's `repository` field: a URL, a shorthand such as "owner/repo" or "github:owner/repo",
// or an object with a `url`.
export type Repository = string | { type?: string; url: string };

const SHORTHAND_HOSTS: Record<string, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

// An owner has no dots, so "github.com/owner" is not read as a shorthand.
const SHORTHAND = /^(?:(github|gitlab|bitbucket):)?([\w-]+\/[\w.-]+)$/;

// The repository's web address, such as https://github.com/owner/repo, or undefined when the field
// names no repository the app can link to.
export function repositoryUrl(repository: Repository): string | undefined {
  const text = (typeof repository === "string" ? repository : repository.url).trim();
  const shorthand = SHORTHAND.exec(text);
  if (shorthand !== null) {
    const host = SHORTHAND_HOSTS[shorthand[1] ?? "github"];
    return `https://${host}/${(shorthand[2] ?? "").replace(/\.git$/, "")}`;
  }
  let url: URL;
  try {
    // git@host:owner/repo is scp-like syntax, not a URL.
    url = new URL(text.replace(/^git@([^:/]+):/, "ssh://git@$1/").replace(/^git\+/, ""));
  } catch {
    return undefined;
  }
  if (!["https:", "http:", "git:", "ssh:"].includes(url.protocol)) return undefined;
  const path = url.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!/^\/[\w.-]+\/[\w.-]+/.test(path)) return undefined;
  return `https://${url.hostname}${path}`;
}

// The Git tag of a release: "v" and its version, such as v1.2.0.
export const releaseTag = (version: string) => `v${version}`;

// The "Source code" link to this exact version: the repository at the release's tag.
export function sourceCodeLink(repository: Repository, version: string): string {
  const url = repositoryUrl(repository);
  if (url === undefined) {
    throw new Error(
      "package.json's repository field names no repository to link to, so the app has no " +
        "Source code link. Set it to the repository's https:// address.",
    );
  }
  return `${url}/tree/${releaseTag(version)}`;
}

export const REPOSITORY: Repository = packageJson.repository;

export const SOURCE_CODE_LINK = sourceCodeLink(REPOSITORY, APP_VERSION);

// The GitHub repository the Update check asks, or undefined for a repository elsewhere.
export function githubRepository(
  repository: Repository,
): { owner: string; name: string } | undefined {
  const url = repositoryUrl(repository);
  const match =
    url === undefined ? null : /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (match === null) return undefined;
  return { owner: match[1] ?? "", name: match[2] ?? "" };
}
