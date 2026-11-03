# Family Finance Tracker

A free, self-hosted, read-only finance tracker for one US Household. It pulls Transactions from the Household's banks, cards, and loans, separates real Spending from money that moves between the Household's own Accounts, and gives analysis and AI advice with no manual upkeep.

v1 is being built. The rules are in the [v1 spec](docs/spec/README.md), the decisions in [docs/adr](docs/adr/), and the terms in [GLOSSARY.md](GLOSSARY.md).

## Development

The build tools need Node.js 22.22 or later and pnpm 12. The image runs Node.js 26.

| Command | What it does |
|---|---|
| `pnpm install` | Installs the packages |
| `pnpm dev` | Runs the web app and the API at http://localhost:5173, which is also its `APP_URL` unless you set one |
| `pnpm lint` | Checks lint and formatting with Biome; `pnpm format` fixes them |
| `pnpm typecheck` | Type-checks the server, the web app, and the tests |
| `pnpm test` | Runs the tests with Vitest |
| `pnpm build` | Builds the web app into `dist/web` and the server into `dist/server.js`, and writes the third-party notices: `dist/THIRD-PARTY-NOTICES.txt` for the image and `dist/web/third-party-notices.txt` for the browser bundle |
| `pnpm start` | Runs the built server on `PORT` (default `3000`). It needs `APP_URL` and the Master key. It loads the Master key, then opens `/data/app.db` and applies migrations |
| `pnpm db:generate` | Writes a migration into `drizzle/` after a change to `src/db/schema.ts`. Commit it with the change |
| `pnpm check:licenses` | Checks every package's license against the allowlist; a package whose license field is missing, `UNLICENSED`, or `SEE LICENSE IN …` needs a record in `licenses/reviewed.json` |
| `pnpm check:audit` | Runs `pnpm audit --prod --audit-level high` against the public registry, in a temporary folder that holds only `package.json` and `pnpm-lock.yaml`; an advisory with no fix passes only with a record in `security/audit-exceptions.json`, and any pnpm setting that ignores advisories fails the check |

CI also scans every commit, with its file names, author, and message, and the files as they stand, for secrets with [gitleaks](https://github.com/gitleaks/gitleaks): `scripts/secret-scan.sh <gitleaks binary>` runs the scan with `.gitleaks.toml`. It refuses a `.gitleaksignore` file, and any `node_modules/`, `.pdf`, `.doc(x)`, or `.xls(x)` file in git, since gitleaks skips those.

A package in the production tree or the browser bundle that ships no license file (a `NOTICE` file alone does not count) needs a record in `licenses/reviewed.json` whose `licenseText` names a `.txt` file in `licenses/texts/` with its license text, or the build fails.

`APP_URL` is the address Members open, and it sets the security mode. An `http://` address must be local, and the app then answers only requests sent to that address. An `https://` address makes the app answer only requests that a proxy in `TRUSTED_PROXIES` marks as HTTPS. The rules are in [Members, login, and security](docs/spec/09-members-login-security.md#security-mode).

The Master key is 32 random bytes written as 64 hexadecimal characters. The app reads the file named by `FFT_MASTER_KEY_FILE` (default `/run/secrets/master.key`), or `FFT_MASTER_KEY` when that file is missing, and does not start without one. `fft setup` will make it; until then, `openssl rand -hex 32` does. The rules are in [Members, login, and security](docs/spec/09-members-login-security.md#the-master-key).

## Docker

```sh
docker build --tag family-finance-tracker .
mkdir -p secrets && openssl rand -hex 32 > secrets/master.key
docker run --rm --env APP_URL=http://localhost:3000 --publish 3000:3000 --volume fft-data:/data \
  --volume ./secrets:/run/secrets:ro family-finance-tracker
```

## License

Copyright (C) 2026 therecluse26 and contributors,

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
