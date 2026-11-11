# Family Finance Tracker

A free, self-hosted, read-only finance tracker for one US Household. It pulls Transactions from the Household's banks, cards, and loans, separates real Spending from money that moves between the Household's own Accounts, and gives analysis and AI advice with no manual upkeep.

v1 adds Reports and an Amazon order file import to bank sync, Categories, Budgets, Alerts and AI advice. The rules are in the [v1 spec](docs/spec/README.md), the decisions in [docs/adr](docs/adr/), and the terms in [GLOSSARY.md](GLOSSARY.md).

## Quick start

On a computer with Docker and Compose v2, this runs the app at `http://localhost:3000`, for that computer only:

```sh
mkdir family-finance-tracker && cd family-finance-tracker
curl -fsSL -O https://raw.githubusercontent.com/therecluse26/family-finance-tracker/v1.0.0/compose.yaml \
  -O https://raw.githubusercontent.com/therecluse26/family-finance-tracker/v1.0.0/.env.example
sed 's|^APP_URL=$|APP_URL=http://localhost:3000|' .env.example > .env
docker compose run --rm app fft setup
docker compose up -d
```

Then open the setup link that `fft setup` printed, such as `http://localhost:3000/setup#code=XXXX-XXXX-XXXX`. The setup wizard shows the Master key once: save it in a password manager.

The [self-hosting guide](docs/self-hosting.md) covers the rest: HTTPS for phones and other devices, a rented server or a platform service, Plaid sign-up, backups and restore, updates, the Master key, and what to do when something goes wrong.

## Development

The build tools need Node.js 26 or later and pnpm 12. The image runs Node.js 26.

| Command | What it does |
|---|---|
| `pnpm install` | Installs the packages |
| `pnpm dev` | Runs the web app and the API at http://localhost:5173, which is also its `APP_URL` unless you set one. It runs the same services as `pnpm start`: the bank module, the background jobs, the follow-up work, and email. It leaves out the two scheduled tasks that call outside services, the update check (GitHub) and the CPI fetch (BLS), so it makes no scheduled outside call. It keeps its own `app.db` and `jobs.db` in `.dev/`. When you save a server file, it stops these services and starts them again on the new code, once for a burst of saves; Ctrl-C stops them, then exits. With no Master key set, it makes `.dev/master.key` on its first start and prints the setup link until the first Member exists, so it needs no other step |
| `pnpm lint` | Checks lint and formatting with Biome; `pnpm format` fixes them |
| `pnpm typecheck` | Type-checks the server, the web app, and the tests |
| `pnpm test` | Runs the tests with Vitest |
| `pnpm build` | Builds the web app into `dist/web`, the server into `dist/server.js`, and the `fft` command into `dist/fft.js`, and writes the third-party notices: `dist/THIRD-PARTY-NOTICES.txt` for the image and `dist/web/third-party-notices.txt` for the browser bundle |
| `pnpm start` | Runs the built server on `PORT` (default `3000`). It needs `APP_URL` and the Master key. It loads the Master key, then opens `/data/app.db` and applies migrations |
| `pnpm db:generate` | Writes a migration into `drizzle/` after a change to `src/db/schema.ts`. Commit it with the change |
| `pnpm check:licenses` | Checks every package's license against the allowlist; a package whose license field is missing, `UNLICENSED`, or `SEE LICENSE IN …` needs a record in `licenses/reviewed.json` |
| `pnpm check:audit` | Runs `pnpm audit --prod --audit-level high` against the public registry, in a temporary folder that holds only `package.json` and `pnpm-lock.yaml`; an advisory with no fix passes only with a record in `security/audit-exceptions.json`, and any pnpm setting that ignores advisories fails the check |

### Linking a bank under `pnpm dev`

Settings → Banks shows a **Link a fake bank (dev only)** button under `pnpm dev`. Each press links the next bank of the made-up demo Household through the fake adapter, by the same steps as a Plaid link: the first sync, the history load, and the follow-up jobs all run. It reaches no bank and needs no Plaid keys. The built app has neither the fake adapter nor the button.

To try the real Plaid Link screen locally, the owner may start `pnpm dev` with `FFT_DEV_PLAID_ENV=sandbox` and enter their own Plaid sandbox keys in Settings → Banks. Only unbuilt code reads that setting. Agents never do this: they use the fake adapter and the local fake Plaid server only.

CI also scans every commit, with its file names, author, and message, and the files as they stand, for secrets with [gitleaks](https://github.com/gitleaks/gitleaks): `scripts/secret-scan.sh <gitleaks binary>` runs the scan with `.gitleaks.toml`. It refuses a `.gitleaksignore` file, and any `node_modules/`, `.pdf`, `.doc(x)`, or `.xls(x)` file in git, since gitleaks skips those.

A package in the production tree or the browser bundle that ships no license file (a `NOTICE` file alone does not count) needs a record in `licenses/reviewed.json` whose `licenseText` names a `.txt` file in `licenses/texts/` with its license text, or the build fails.

`APP_URL` is the address Members open, and it sets the security mode. An `http://` address must be local, and the app then answers only requests sent to that address. An `https://` address makes the app answer only requests that a proxy in `TRUSTED_PROXIES` marks as HTTPS. The rules are in [Members, login, and security](docs/spec/09-members-login-security.md#security-mode).

The Master key is 32 random bytes written as 64 hexadecimal characters. The app reads the file named by `FFT_MASTER_KEY_FILE` (default `/run/secrets/master.key`), or `FFT_MASTER_KEY` when that file is missing, and does not start without one. `fft setup` makes it, with mode `0600`, and prints a one-use setup link that makes the first Member. Keep the Master key file readable only by the app's user, and keep a copy off the server, such as in a password manager: without it, every Connection must be made again. The rules are in [Members, login, and security](docs/spec/09-members-login-security.md#the-master-key) and [Install and first-run setup](docs/spec/12-install-and-first-run.md#the-fft-command).

## Docker

To build and run the image from this source, instead of the published image:

```sh
docker build --tag family-finance-tracker .
mkdir -p secrets && chmod 700 secrets
# Makes secrets/master.key and prints the setup link. The image's user (UID 1000) must be able to
# write to secrets/.
docker run --rm --env APP_URL=http://localhost:3000 --volume fft-data:/data \
  --volume ./secrets:/run/secrets family-finance-tracker fft setup
docker run --rm --env APP_URL=http://localhost:3000 --publish 3000:3000 --volume fft-data:/data \
  --volume ./secrets:/run/secrets:ro family-finance-tracker
```

Then open the setup link that `fft setup` printed. Keep `secrets/master.key` readable only by the app's user (mode `0600`), and keep a copy of it off the server, such as in a password manager.

## License

Copyright (C) 2026 therecluse26 and contributors,

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
