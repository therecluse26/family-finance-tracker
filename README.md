# Family Finance Tracker

A free, self-hosted, read-only finance tracker for one US Household. It pulls Transactions from the Household's banks, cards, and loans, separates real Spending from money that moves between the Household's own Accounts, and gives analysis and AI advice with no manual upkeep.

v1 is being built. The rules are in the [v1 spec](docs/spec/README.md), the decisions in [docs/adr](docs/adr/), and the terms in [GLOSSARY.md](GLOSSARY.md).

## Development

The build tools need Node.js 22.22 or later and pnpm 12. The image runs Node.js 26.

| Command | What it does |
|---|---|
| `pnpm install` | Installs the packages |
| `pnpm dev` | Runs the web app and the API at http://localhost:5173 |
| `pnpm lint` | Checks lint and formatting with Biome; `pnpm format` fixes them |
| `pnpm typecheck` | Type-checks the server, the web app, and the tests |
| `pnpm test` | Runs the tests with Vitest |
| `pnpm build` | Builds the web app into `dist/web` and the server into `dist/server.js` |
| `pnpm start` | Runs the built server on `PORT` (default `3000`) |

## Docker

```sh
docker build --tag family-finance-tracker .
docker run --rm --env PORT=3000 --publish 3000:3000 family-finance-tracker
```

## License

Copyright (C) 2026 therecluse26 and contributors,

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
