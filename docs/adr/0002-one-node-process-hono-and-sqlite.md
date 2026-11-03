# One Node process with Hono, a React SPA, SQLite, and Sidequest

The app is self-hosted by people who are not experts, often on a home server, a NAS, or a Raspberry Pi. It serves one Household, ships as one Docker Compose file, and is TypeScript from end to end. It needs password plus TOTP and passkey login, encryption of stored secrets, web push, an installable web app, and scheduled bank sync.

The app is one Node.js process, version 22.6 or later. A Hono server serves the API and a React single-page app built with Vite. SQLite holds all data, through Drizzle on `@libsql/client`, the only driver, at `file:/data/app.db`. Sidequest 1.17 runs background jobs inside the same process (`runner: "inline"`), one at a time, in its own file, `/data/jobs.db`. Better Auth handles login, and Vercel AI SDK 7 handles every AI provider. The details are in [Stack and architecture](../spec/10-stack-and-architecture.md).

One process and one data volume keep the Compose file small, and a backup is one SQLite file. SQLite needs no second container and fits one Household's load. `@libsql/client` gives one async code path, so adding Turso later stays a small job. Sidequest brings retries, delays, unique jobs, and job history on SQLite. We chose Hono over Fastify: both are fast, but Hono is small and carries first-class TypeScript types from each route to the browser client. Fastify's plugin system adds structure that one small app does not need.

## Considered options

- **Fastify.** Equally fast. Its plugin system is more structure than this app needs, and its route types do not reach the client as directly.
- **An in-house jobs table.** The job-runner research proposed it while Cloudflare D1 was still in scope. Once D1 left scope, its main reason was gone, and Sidequest saves the work.
- **BullMQ.** Its only backends are Redis and PostgreSQL. It cannot use SQLite.
- **Cloudflare Workers with D1.** D1 has no driver for a Node.js server, so the whole app would move to Workers. There, the Free plan's CPU cap makes the paid plan the realistic floor.
- **PostgreSQL.** It adds a second container to run and back up. Its at-rest encryption options are too heavy for non-experts.

Sources: [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12), [Assemble the v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/24), [Encrypting a self-hosted database at rest](https://github.com/therecluse26/family-finance-tracker-private/issues/8), [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22). Research: [SQLite-backed job queues for Node.js](https://github.com/therecluse26/family-finance-tracker-private/blob/research/sqlite-job-queues/docs/research/sqlite-job-queues.md), [One SQLite code path for a local file, Turso and Cloudflare D1](https://github.com/therecluse26/family-finance-tracker-private/blob/research/hosted-sqlite-drivers/docs/research/hosted-sqlite-drivers.md).
