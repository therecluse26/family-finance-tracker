# Family Finance Tracker: v1 spec

Family Finance Tracker is a free, open-source, self-hosted finance tracker for one US Household. It pulls Transactions from the Household's banks, cards, and loans. It separates real Spending from money that only moves between the Household's own Accounts. Then it tracks Budgets and Goals, warns about Overspending and Anomalies, and gives AI advice through the Household's own AI provider key.

Three rules shape everything else:

- **Hands-off first.** Analysis is correct with zero manual upkeep. No Member is ever required to review, label, or fix data. Review controls are optional and only improve accuracy.
- **Read-only.** The app never moves money or pays bills.
- **One Household, self-hosted.** One instance serves exactly one Household. It runs from one Docker Compose file.

## How to read this spec

- Each file covers one area and states the **current rules** only. The "Sources" list at the end of each file links to the planning tickets behind it.
- Words with a capital letter, such as Transaction, Merchant, and Review list, are defined in [`GLOSSARY.md`](../../GLOSSARY.md). The spec uses no other words for those things.
- Architecture decisions that are hard to undo have an ADR in [`docs/adr/`](../adr/).
- Every number in the spec is a rule. A builder who needs a number that is not here should ask, not guess.

## Contents

| File | What it covers |
|---|---|
| [01 Scope and principles](01-scope-and-principles.md) | What the product is, who uses it, and the principles every feature follows |
| [02 Accounts and bank sync](02-accounts-and-bank-sync.md) | Accounts, Connections, the bank-data adapter, Plaid, sync, Unconnected accounts, Manual loans |
| [03 Money movement](03-money-movement.md) | Spending, Income, Transfers, Saving, Refunds, Reimbursements, and how the app links them |
| [04 Categorization](04-categorization.md) | The Category list, the categorization cascade, Category rules, Merchants, splits |
| [05 Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md) | Benchmarks, Steady Income, Budget formulas, yearly Budgets, Goals and their progress |
| [06 Anomalies and Alerts](06-anomalies-and-alerts.md) | Recurring charges, the four Anomalies, Overspending Alerts, caps, quiet hours, channels |
| [07 Dashboard and pages](07-dashboard-and-pages.md) | The dashboard and every other page |
| [08 AI](08-ai.md) | Every AI use, the Monthly review, Insight cards, Chat, Proposals, privacy, cost, and the AI cost cap |
| [09 Members, login, and security](09-members-login-security.md) | Members, invites, login, the security mode, encryption, the Master key |
| [10 Stack and architecture](10-stack-and-architecture.md) | Runtime, frameworks, database, jobs, libraries, and the build |
| [11 Backup, restore, and export](11-backup-restore-export.md) | Automatic backups, restore, and data export |
| [12 Install and first-run setup](12-install-and-first-run.md) | The image, the Compose folder, `fft` commands, HTTPS, hosting, the first-run wizard, updates |
| [13 Out of scope](13-out-of-scope.md) | What v1 does not do, and why |
| [14 Line items and Amazon orders](14-line-items.md) | Amazon's order file, Line items, linking them to Transactions, Item rules, and splits from Line items |
| [15 Deal finder](15-deal-finder.md) | After v1: the Shopping list, Price sources, Stores and Home stores, Deals, and the Shopping plan |

## Architecture decisions

| ADR | Decision |
|---|---|
| [0001](../adr/0001-build-our-own.md) | Build our own; do not fork an existing tracker |
| [0002](../adr/0002-one-node-process-hono-and-sqlite.md) | One Node process with Hono, and SQLite |
| [0003](../adr/0003-bank-data-adapter-with-plaid-trial-first.md) | One bank-data adapter interface, with Plaid's Trial plan first |
| [0004](../adr/0004-poll-plaid-without-webhooks.md) | Poll Plaid; no webhooks |
| [0005](../adr/0005-app-level-envelope-encryption.md) | App-level envelope encryption; no full-database encryption |
| [0006](../adr/0006-agpl-3-license.md) | AGPL-3.0-or-later |
| [0007](../adr/0007-fixed-category-list.md) | A fixed Category list |
| [0008](../adr/0008-app-url-sets-security-mode.md) | `APP_URL` sets the security mode; every Member has a password plus TOTP |

## Reference material

These branches are never merged. The spec links to them where they help.

**Prototypes**
- Dashboard: [`prototype/dashboard-and-graphs`](https://github.com/therecluse26/family-finance-tracker-private/tree/prototype/dashboard-and-graphs/prototype/dashboard)
- Monthly review, Insight cards, and Chat: [`prototype/monthly-review-and-chat`](https://github.com/therecluse26/family-finance-tracker-private/tree/prototype/monthly-review-and-chat/prototype/ai)
- Plaid and SimpleFIN probe on real Accounts: [`task/provider-comparison`](https://github.com/therecluse26/family-finance-tracker-private/tree/task/provider-comparison/prototype/bank-probe)

**Research**
- [AI library and AI provider data-use policies](https://github.com/therecluse26/family-finance-tracker-private/blob/research/ai-library-and-provider-policies/docs/research/ai-library-and-provider-policies.md)
- [Database encryption at rest](https://github.com/therecluse26/family-finance-tracker-private/blob/research/database-encryption/docs/research/database-encryption.md)
- [Hosted SQLite drivers](https://github.com/therecluse26/family-finance-tracker-private/blob/research/hosted-sqlite-drivers/docs/research/hosted-sqlite-drivers.md)
- [Plaid alternatives](https://github.com/therecluse26/family-finance-tracker-private/blob/research/plaid-alternatives/docs/research/plaid-alternatives.md)
- [Plaid free tier](https://github.com/therecluse26/family-finance-tracker-private/blob/research/plaid-free-tier/docs/research/plaid-free-tier.md)
- [Spending benchmarks](https://github.com/therecluse26/family-finance-tracker-private/blob/research/spending-benchmarks/docs/research/spending-benchmarks.md)
- [SQLite job queues](https://github.com/therecluse26/family-finance-tracker-private/blob/research/sqlite-job-queues/docs/research/sqlite-job-queues.md)
- [Transaction categorization](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transaction-categorization/docs/research/transaction-categorization.md)
- [Transfer detection](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transfer-detection/docs/research/transfer-detection.md)
- [Transfer matching prior art](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transfer-matching-prior-art/docs/research/transfer-matching-prior-art.md)

**Planning**
- The map: [Wayfinder: family finance tracker v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/1). Each planning ticket is linked from the spec files that use it.
