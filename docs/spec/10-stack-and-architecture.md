# Stack and architecture

v1 is one Node.js process, written in TypeScript. A Hono server serves the API and a React single-page app built with Vite. SQLite holds all data, through Drizzle on `@libsql/client`, and Sidequest runs background jobs inside the same process. Every package must pass the CI license check. The reasons are in [ADR 0002](../adr/0002-one-node-process-hono-and-sqlite.md).

## Runtime and tooling

- **Node.js 26 or later.** CI and the image run Node.js 26 only, so older lines are not tested. The image uses the newest Node.js LTS line at build start.
- **TypeScript** in strict mode, for the server, the web app, the jobs, the `fft` command, and the tests.
- **One package,** with no workspaces. **pnpm** installs it.
- **Vitest** runs the tests. **Biome** lints and formats.
- **CI** runs Biome, the type check, Vitest, the license check, and the build. Any failure fails the build.
- **Tests run offline.** The in-memory fake adapter stands in for Plaid ([Accounts and bank sync](02-accounts-and-bank-sync.md)). AI SDK test models stand in for the AI provider.

## Packages

| Area | Package | Version | Used for |
|---|---|---|---|
| Server | `hono`, `@hono/node-server` | Latest stable | API routes, the SPA's files, `GET /healthz` |
| Web app | `react`, `react-dom` | Latest stable | The single-page app |
| Web app | `vite` | Latest stable | Builds the web app and the server file |
| Web app | `vite-plugin-pwa` | Latest stable | The installable app and the service worker for web push |
| Web app | `react-router` | Latest stable | Page routes in the browser |
| Web app | `tailwindcss`, `@tailwindcss/vite` | Latest stable | Styles |
| Web app | `recharts` | Latest stable | Every chart |
| Data | `drizzle-orm`, `drizzle-kit` | The latest stable Drizzle line at build start, the same line for both | Schema, queries, migrations |
| Data | `@libsql/client` | Backups were tested on 0.18.0 | The only driver for `app.db` |
| Jobs | `sidequest` | 1.17 | Background jobs, in process |
| Login | `better-auth`, `@better-auth/passkey` | Latest stable | Password, TOTP and backup codes (two-factor plugin), passkeys, sessions, through Better Auth's Drizzle adapter ([Members, login, and security](09-members-login-security.md)) |
| AI | `ai` | Vercel AI SDK 7 (`ai@7.0.158` was checked) | `generateText` and `streamText` for every AI provider |
| AI | `@ai-sdk/openai`, `@ai-sdk/anthropic` | The line that matches `ai` 7 | OpenAI and Anthropic, and Cloudflare AI Gateway through a base URL and headers |
| AI | `@openrouter/ai-sdk-provider` | The line that matches `ai` 7 | OpenRouter |
| AI | `@ai-sdk/openai-compatible` | The line that matches `ai` 7 | Ollama and any other OpenAI-compatible endpoint |
| AI | `@ai-sdk/react` | The line that matches `ai` 7 | The Chat page's answer stream |
| Schemas | `zod` | Latest stable | AI output schemas and API input checks |
| Bank data | `plaid` | Latest stable | The Plaid adapter's API calls |
| Matching | `munkres` | Research checked 2.1.1 | Global Transfer pairing by minimum cost ([Money movement](03-money-movement.md)) |
| Alerts | `web-push` | Latest stable | Web push, with VAPID keys. It stays unmodified. |
| Alerts | `nodemailer` | Latest stable | Email over SMTP |
| Secrets | `node:crypto` | Built in | AES-256-GCM envelope encryption ([Members, login, and security](09-members-login-security.md)) |

- "Latest stable" means the newest stable release on the day the build starts.
- `pnpm-lock.yaml` pins every exact version. CI installs with `--frozen-lockfile`.
- An upgrade passes the same CI checks as any other change.

## Process model

One Node.js process runs the Hono server, Sidequest, and every job. The `fft` command runs as its own short-lived process from the same image ([Install and first-run setup](12-install-and-first-run.md)).

### Startup

At every start, the app runs these steps in order:

1. Load the Master key ([Members, login, and security](09-members-login-security.md)).
2. Open `file:/data/app.db`. The driver creates the file if it is missing.
3. Set WAL mode and the busy `timeout` of 5000 ms in the driver setup.
4. If migrations are pending, take a safety copy ([Backup, restore, and export](11-backup-restore-export.md)). If the safety copy fails, stop before migrating and log why.
5. Apply the pending migrations.
6. Start Sidequest on `/data/jobs.db`.
7. Run the scheduler tick once. It starts any scheduled work that was missed while the app was down.
8. Listen on `PORT`. From now on, `GET /healthz` returns 200.

### Shutdown

- On `SIGTERM`, the app stops taking requests and starting jobs.
- It waits up to 10 seconds for the running job, then exits.
- Work cut off by a stop runs again after the next start. Jobs are safe to run twice.
- A `SIGTERM` during the start waits for the start to end, for up to 10 seconds, then stops the same way, so it releases the running lock.

### HTTP routes

| Path | Serves |
|---|---|
| `/api/*` | The JSON API, as Hono routes |
| `/api/auth/*` | Better Auth |
| `/healthz` | 200 once migrations are done |
| Any other `GET` path | The web app's files from the Vite build; an unknown path gets `index.html` |

- The web app calls the API through Hono's typed client (`hc` from `hono/client`), so route types reach the browser.
- The security mode, trusted proxies, and `Host` checks run before every route ([Members, login, and security](09-members-login-security.md)).
- A Chat answer streams from its route with `streamText`. It is not a job.
- The live AI status streams from `GET /api/ai/activity/stream` as server-sent events, with Hono's `streamSSE` ([AI](08-ai.md#live-ai-status)). The server ends each open stream when it stops, before it waits for open requests, so a stream never holds up the shutdown.

### Module seams

Each outside dependency sits behind one module. No other module imports that dependency.

| Module | Owns | Sole importer of |
|---|---|---|
| `db` | The Drizzle schema, the client, the migrator | `drizzle-orm`, `@libsql/client` |
| `jobs` | Job registration, the scheduler tick | `sidequest` and the `@sidequest/*` packages |
| `bank` | The `BankDataAdapter` interface and its adapters ([Accounts and bank sync](02-accounts-and-bank-sync.md)) | `plaid` |
| `ai` | Every AI call: models, cost counting, the AI cost cap ([AI](08-ai.md)) | `ai` and the AI provider packages |
| `secrets` | The Master key, encrypting and decrypting secrets | `node:crypto` for secrets |
| `notify` | Alerts and System notices by push and email ([Anomalies and Alerts](06-anomalies-and-alerts.md)) | `web-push`, `nodemailer` |
| `auth` | Better Auth and its plugins | `better-auth`, `@better-auth/passkey` |

The `ai` module also follows these library rules:

- It builds every model from a provider instance, such as `createOpenAI` or `createAnthropic`.
- It never passes a plain model-ID string. The AI SDK sends plain strings to Vercel's AI Gateway.
- It registers no AI SDK telemetry integration.
- The AI providers' privacy settings are in [AI](08-ai.md).

### Logs

- The app logs to stdout. Docker keeps the log.
- Logs never hold secrets, the setup code, prompt text, or Transaction details.
- The AI request log is not a log. It is a table in app.db, off by default, that keeps each AI call's request and reply for a few days ([AI](08-ai.md#ai-request-log)). No log line holds its text.

## Jobs

- **Sidequest 1.17** runs every background job.
- It keeps its own file, `/data/jobs.db`, in the same data volume.
- It runs inside the app process (`runner: "inline"`), one job at a time (`maxConcurrentJobs: 1`), as its docs advise for SQLite.
- It also runs with `fork: false`. Otherwise Sidequest starts its engine in a child process.
- App code registers jobs through the `jobs` module and never imports Sidequest directly.
- Every job is safe to run twice.
- No job waits in place. A step that must wait, such as a retry or push held for quiet hours, becomes a new job with a start time.
- The Sidequest dashboard is off. It runs on its own port, outside the app's login.

### The scheduler tick

Sidequest keeps schedules in memory and skips runs missed while the app is down. So the app keeps schedule state itself:

- `app.db` stores each scheduled task's last run and next run time.
- A tick job runs every minute. It starts each task whose next run time has passed.
- The tick also runs once at startup. A task that missed several runs runs once.
- Times follow the Household time zone, which comes from the ZIP code ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).

### Job list

| Job | Starts | Rules in |
|---|---|---|
| Sync, one per Connection | Every 6 hours at a random minute, on Sync now, after a back-off, or once a day while the Connection needs a Member | [Accounts and bank sync](02-accounts-and-bank-sync.md) |
| Follow-up | After a sync that adds, changes, or removes Transactions | [The follow-up pipeline](#the-follow-up-pipeline) |
| First run | When every Connection's history has loaded: the AI's first run and the Budget draft | [Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md), [AI](08-ai.md) |
| Month start | On the 1st: the month's Bills Budgets | [Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md) |
| Monthly review | On the 1st | [AI](08-ai.md) |
| Insight card check | Daily at 6 AM Household time. It starts a run only when a new posted Transaction has arrived since the last run | [AI](08-ai.md#when-ai-does-not-run) |
| Household summary | Once a day | [AI](08-ai.md) |
| AI retry | After an AI call fails | [AI](08-ai.md) |
| Redo no-AI work | When AI works again after the AI cost cap or an outage, and when a Member presses "Finish AI work now" or "Run AI on all history" | [AI](08-ai.md#ai-work-on-your-transactions) |
| Delivery | When an Alert or System notice goes out; push waits out quiet hours | [Anomalies and Alerts](06-anomalies-and-alerts.md) |
| Backup | Daily at 3:00 AM Household time, on Back up now, and on its retry | [Backup, restore, and export](11-backup-restore-export.md) |
| CPI fetch | Monthly | [Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md) |
| Update check | Once a day, unless a Member turns it off | [Install and first-run setup](12-install-and-first-run.md) |

### The follow-up pipeline

A sync that adds, changes, or removes Transactions starts one follow-up job. A sync with no changes starts nothing, so it never triggers an AI call. The job runs these steps in this order:

1. **Matching:** Transfers, Refunds, Reimbursements, and Manual loan payments ([Money movement](03-money-movement.md), [Accounts and bank sync](02-accounts-and-bank-sync.md)). Rule-based Merchant cleanup has already run when each Transaction arrived, because Refund links need the Merchant ([Categorization](04-categorization.md#merchants)).
2. **Categorization,** with AI Merchant cleanup for names the rules could not fix ([Categorization](04-categorization.md)).
3. **Recurring charge checks** ([Anomalies and Alerts](06-anomalies-and-alerts.md#recurring-charges)).
4. **Anomaly checks,** which read the Recurring charges step 3 found ([Anomalies and Alerts](06-anomalies-and-alerts.md#anomalies)).
5. **Bills Budgets:** this month's Bills Budgets again, as early bills and loan interest post ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md#bills-group-housing-utilities-phone-and-internet-insurance-taxes-and-government)).
6. **Overspending checks,** which read the Bills Budgets step 5 set ([Anomalies and Alerts](06-anomalies-and-alerts.md#overspending-alerts)).
7. **Alerts** ([Anomalies and Alerts](06-anomalies-and-alerts.md)).
8. **The once-a-day Insight card check** ([AI](08-ai.md)).

Rules:

- Matching comes first. A payment to a person gets its Category only after matching decides that the money left the Household.
- The follow-up job covers the whole Household, not one Connection. Matching compares all candidate pairs at once.
- At most one follow-up job waits at a time. A sync that ends while one waits adds no second job.
- Each step handles every Transaction it has not handled yet. A later follow-up job picks up anything an earlier one left.
- AI steps wait for loaded history as [AI](08-ai.md) says.
- When an AI call fails, the step leaves those Transactions unhandled and the job stops. A follow-up job starts at the next retry time from [AI](08-ai.md).
- After the last retry fails, the step takes its no-AI path, and the job goes on.

## Database files

| File | Holds | Opened by | In backups |
|---|---|---|---|
| `/data/app.db` (with `app.db-wal` and `app.db-shm`) | All app data: Transactions, settings, Better Auth tables, encrypted secrets, schedule state | Drizzle on `@libsql/client`, URL `file:/data/app.db` | Yes ([Backup, restore, and export](11-backup-restore-export.md)) |
| `/data/jobs.db` | Waiting and finished jobs only | Sidequest's own SQLite backend | No. A restore empties it. |
| `/backups/` | Backup files and safety copies | The backup job | — |
| The Master key file | The Master key | The `secrets` module | Never. It lives outside `/data` ([Members, login, and security](09-members-login-security.md)). |

- v1 supports only the local database file. The driver stays `@libsql/client`, so adding Turso later stays a small job.
- In app code, `PRAGMA` appears only in the driver setup: WAL mode and the busy `timeout`. App code never sets a `PRAGMA`. The one other use is test-only and read-only: the tests' settings reader in `src/db/testing.ts` reads `mmap_size`, `temp_store_directory` and `wal_autocheckpoint`, which have no table-valued function, each by its name with no value.
- Generated migrations may hold the `PRAGMA foreign_keys=OFF;` and `PRAGMA foreign_keys=ON;` pair that drizzle-kit writes around a table rebuild. The pair changes nothing, because the driver already turns foreign keys off while it applies migrations. No other `PRAGMA` may appear in a migration.
- Every query is awaited. Code never calls a synchronous driver API.
- Sidequest's SQLite backend uses `better-sqlite3`, a native module. The image includes its build for amd64 and arm64 ([Install and first-run setup](12-install-and-first-run.md)).

### Data conventions

- Money is stored as whole cents in integer columns. The Plaid adapter converts each amount once, on the way in.
- A calendar date, such as a posted date, is stored as `YYYY-MM-DD` text.
- A moment in time is stored in UTC. Screens show it in the Household time zone.

## Migrations

- The Drizzle schema in TypeScript is the only source of the database shape. Better Auth's tables are part of it.
- `drizzle-kit generate` writes each migration as plain SQLite SQL (`dialect: "sqlite"`) into `drizzle/`. The files are committed.
- The migration files ship inside the Docker image.
- At every start, Drizzle's libSQL migrator applies pending migrations before the app accepts requests ([Startup](#startup)).
- Drizzle's migrations table in `app.db` records each applied migration. A database with a migration the image does not ship comes from a newer version.
- Migrations only go forward. There are no down migrations. To go back a version, a self-hoster restores the safety copy with the older image.
- `drizzle-kit push` is never used on a real database.
- Sidequest creates and changes the tables in `jobs.db` itself.

## License compliance in the build

The project license is AGPL-3.0-or-later ([ADR 0006](../adr/0006-agpl-3-license.md)).

### Project files

- `LICENSE` holds the FSF text, unchanged.
- `package.json` carries `"license": "AGPL-3.0-or-later"`.
- The README's license section has this line: "Copyright (C) 2026 therecluse26 and contributors,"
- Source files carry no license headers.

### The license check

CI checks every dependency's license. A license outside the allowlist fails the build.

- **Shipped code** may use: MIT, MIT-0, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, MPL-2.0, LGPL-2.1, LGPL-3.0, GPL-3.0, AGPL-3.0.
- Each listed license also matches its `-only` and `-or-later` forms, such as `LGPL-3.0-or-later`.
- A dual license passes when one of its options is on the list.
- **Build-time tools** may also use CC-BY-4.0.
- **Blocked examples:** GPL-2.0-only (it cannot combine with AGPL-3.0), SSPL, BUSL, non-commercial licenses, and paid licenses.
- **No license field, `UNLICENSED`, or `SEE LICENSE IN …`:** the package passes only after a person reads its files and records the result in `licenses/reviewed.json`. Each record has the package, version, license found, reviewer, and date.
  - A record for a package whose license field names a license must give that same license.
  - The first record: `express-ejs-layouts`, from Sidequest's dashboard, ships an MIT LICENSE file.
- A script in `scripts/` reads `pnpm licenses list --json` and applies these rules.
- Shipped code is the `dependencies` tree. Build-time tools are the `devDependencies` tree.
- Every package whose code ends up in the image or the browser bundle goes in `dependencies`.
- Exception: Vite and Rolldown add small helpers to the browser bundle. They stay in `devDependencies`, but the license check treats them as shipped code, and the browser notices list them.

### Third-party notices

- The build generates a notices file for the Docker image and another for the browser bundle.
- Each lists every shipped package with its name, version, license, and license text.
- A package in the production tree or the browser bundle that ships no license file needs a record in `licenses/reviewed.json` whose `licenseText` names a `.txt` file in `licenses/texts/` with its license text. Otherwise the build fails. A `NOTICE` file alone is not a license file.
- The image's file covers the production tree. The browser file covers the packages in the Vite bundle, and the app serves it at `/third-party-notices.txt`.

### LGPL and MPL packages

- Vite builds the server into one file. Every package stays external, in the image's `node_modules`.
- **Sidequest stays a separate package,** not bundled into the server file. A self-hoster can then swap it, as the LGPL requires.
- The image notices include the GPL-3.0 text with the LGPL-3.0 text for the Sidequest packages, as LGPL-3.0 section 4(b) requires.
- The `jobs` module hands every job class to Sidequest directly, through Sidequest's manual mode for bundled builds. The bundled server has no script file per job.
- **`web-push` stays unmodified.** If it is ever patched, the patched files stay MPL-2.0.

### Version and source link

- The build writes the app's version from `package.json` into the app.
- It also writes a "Source code" link to that exact version. The link comes from the `repository` field in `package.json` plus the release's Git tag.
- A fork that changes `repository` links to its own code. This meets the AGPL's network rule.
- Settings show the version and the link ([Dashboard and pages](07-dashboard-and-pages.md)).

### Benchmark data

- Every Benchmark source is a US federal work: BLS (Consumer Expenditure Survey, CPI), USDA (Food Plans), IRS (Collection Financial Standards), HUD (Fair Market Rents), Census (ACS), and DOL (childcare prices). They have no copyright.
- The "Data sources" page in settings and the repo's matching file are one Markdown file, `docs/data-sources.md`. The build bundles it into the app.
- The file names each agency, table, and data date.
- It says that no agency endorses the app.
- It marks the copied government numbers as public domain, outside the AGPL.
- It keeps our own work, such as matching survey groups to Categories, under the AGPL.
- The page also shows this sentence and the date the app last fetched the CPI: "BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov."

## Encryption at rest

- The `secrets` module uses `node:crypto` AES-256-GCM envelope encryption, with AAD and key IDs.
- What it encrypts, where the Master key lives, and what a lost key costs are in [Members, login, and security](09-members-login-security.md).
- There is no full-database encryption in v1 ([Out of scope](13-out-of-scope.md)).
- Research: [Encrypting a self-hosted database at rest](https://github.com/therecluse26/family-finance-tracker-private/issues/8), [findings](https://github.com/therecluse26/family-finance-tracker-private/blob/research/database-encryption/docs/research/database-encryption.md).

## Sources

- [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12)
- [One AI library for all AI providers, and their data-use policies](https://github.com/therecluse26/family-finance-tracker-private/issues/5)
- [Encrypting a self-hosted database at rest](https://github.com/therecluse26/family-finance-tracker-private/issues/8)
- [Hands-off Transfer, Refund, and Reimbursement detection](https://github.com/therecluse26/family-finance-tracker-private/issues/13)
- [Dashboard and graphs](https://github.com/therecluse26/family-finance-tracker-private/issues/9)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [AI context and cost](https://github.com/therecluse26/family-finance-tracker-private/issues/20)
- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21)
- [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22)
- [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23)
- Research: [SQLite-backed job queues for Node.js](https://github.com/therecluse26/family-finance-tracker-private/blob/research/sqlite-job-queues/docs/research/sqlite-job-queues.md), [One SQLite code path for a local file, Turso and Cloudflare D1](https://github.com/therecluse26/family-finance-tracker-private/blob/research/hosted-sqlite-drivers/docs/research/hosted-sqlite-drivers.md), [AI library and provider policies](https://github.com/therecluse26/family-finance-tracker-private/blob/research/ai-library-and-provider-policies/docs/research/ai-library-and-provider-policies.md), [Transfer detection](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transfer-detection/docs/research/transfer-detection.md)
