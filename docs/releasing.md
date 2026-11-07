# Releasing

The steps for each release, such as `v1.2.0`. A release is a Git tag `v<version>` on `main`. CI then checks the tagged commit, pushes the image, and makes the GitHub release.

## Before the tag

1. **The Benchmark snapshot.** Download the source files and run the release script, as [Building the snapshot](data-sources.md#building-the-snapshot) says. `pnpm check:benchmarks` must pass. It fails while the snapshot holds sample numbers, and the release runs it before it pushes the image.
2. **The version.** Set `version` in `package.json`, such as `1.2.0`. Settings, About, shows it, and its "Source code" link opens the tag. The test in `src/server/about-api.test.ts` names the version: change it too.
3. **The quick start.** The `curl` lines in the README quick start and in the setup guide's [Make the folder](self-hosting.md#1-make-the-folder) fetch `compose.yaml` and `.env.example` from the release's tag, such as `.../family-finance-tracker/v1.2.0/compose.yaml`. Change both to the new tag. The tests check that they name the tag of the version in `package.json`.
4. **The release notes.** Write `docs/release-notes/v<version>.md`. Link the setup guide at the tag, with a full `https://github.com/.../blob/v<version>/docs/self-hosting.md` address, since a link relative to the file does not work on the release page. For a new major version, say that `compose.yaml` needs the new image version, such as `:1` to `:2`.
5. Merge all of it to `main`, and wait for CI to pass there.

## The tag

Push the tag `v<version>` on that commit of `main`. CI runs every check again on the tagged commit. Then:

- The benchmarks job runs `pnpm check:benchmarks`, with a read-only token.
- After it and every other check pass, the publish job checks that the tag, `package.json`'s version, and the release notes match, and pushes the image for amd64 and arm64 under the exact version, the major version, and `latest`.
- After the push succeeds, the release job makes the GitHub release `v<version>` from `docs/release-notes/v<version>.md`, with the workflow's own token.

A pre-release tag, such as `v1.2.0-rc1`, runs every check but skips the benchmarks, publish, and release jobs. The run is green, and no image or release is made.
