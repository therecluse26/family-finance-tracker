# Scope and principles

Family Finance Tracker is a free, open-source, self-hosted, read-only finance tracker for one US Household. It pulls Transactions from US banks, cards, and loans. It separates real Spending from money that moves between the Household's own Accounts, then gives analysis and AI advice. Its first principle is hands-off: the analysis is correct with zero manual upkeep, and hands-off wins over every other rule.

## What the product is

- A web app that runs on a server the Household controls, such as a home server, a NAS, or a rented server.
- One instance serves exactly one Household.
- It is reached over a private network, such as Tailscale, or over the public internet. It must be safe in both places.
- Members can install it on their phones as a web app.
- It ships as one Docker image with one Docker Compose file ([Install and first-run setup](12-install-and-first-run.md)).
- The license is AGPL-3.0-or-later ([ADR 0006](../adr/0006-agpl-3-license.md)).

## Who it serves

- **Members:** the people in the Household who have a login. Every Member sees all data and has the same powers. There are no roles and no private Accounts.
- **The self-hoster:** the person who installs and runs the server. Usually this person is also a Member.
- **People without a login,** such as children, count in the Household facts but never sign in.
- **The first Household** is the owner's. Strangers must also be able to self-host the app easily, with one Compose file and a short guide.

These example institutions shape the examples in this spec:

| Institution | Kind | How the app sees it |
|---|---|---|
| Ally | Banking | Connection |
| Pinecrest | Banking | Unconnected account, by the Household's choice |
| Capital One | Credit card | Connection |
| Chase | Credit card | Connection |
| Synchrony | Credit card | Connection |
| Larkspur | Loan | Connection |

## Principles

### 1. Hands-off first

- The analysis is correct even if no Member ever reviews anything.
- No Member is ever required to review, annotate, or fix data.
- Review controls are optional. They only improve accuracy.
- The app gives every Transaction a type and, for Spending, a Category, by itself.
- Nothing waits for a Member. The Review list is optional ([Categorization](04-categorization.md), [Money movement](03-money-movement.md)).
- The AI never holds back analysis to wait for a Member.
- A Member is needed only to set the app up, to make Connections, to repair a Connection when the bank asks for a person, and to write Goals.

### 2. Read-only

- The app never moves money. It has no bill pay.
- The app only reads from Bank-data providers. It never writes to a bank.
- The AI cannot move money. A Proposal changes only data inside the app, and only after a Member accepts it ([AI](08-ai.md)).

### 3. One Household, self-hosted

- One instance serves exactly one Household.
- Personal finances only. The app has no business features.
- All Members see all data, including every Chat.
- The Household's data stays on its own server. It leaves only for the services listed under [Privacy](#11-privacy).

### 4. US only

- v1 supports US banks, cards, and loans only.
- Every amount is in US dollars.
- Benchmarks come from US public data, keyed to the Household's ZIP code ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).
- The Bank-data provider interface leaves room for other regions later ([Accounts and bank sync](02-accounts-and-bank-sync.md)).

### 5. Free, with no required paid service

- The software is free. It has no paid tier.
- No paid third party is required.
- v1 gets bank data from a free source: Plaid's Trial plan, which allows 10 lifetime Items.
- A Household may choose a paid Bank-data provider, such as SimpleFIN Bridge ($1.50 a month). v1 ships no adapter for one ([Out of scope](13-out-of-scope.md)).
- The AI provider is the only paid service the app is built to use. It is optional. A local model, such as one on Ollama, can cost $0.

### 6. Works without AI

The AI provider is optional. Core data works without it.

| Works without AI | Needs an AI provider |
|---|---|
| Bank sync | Insight cards |
| Transfer and Refund matching | The Monthly review |
| Categories from the cascade's rule steps | Chat and Proposals |
| Budget drafting by formula, and Budget tracking | Goals |
| Recurring charges and Anomalies | Advice added to Alerts |
| Alerts, stated as facts | Fixing Categories the rule steps cannot settle |
| Graphs and the dashboard's numbers | Reimbursement linking |
| Backups and data export | Judging unclear Transfers |

- v1 supports OpenAI and Anthropic. It also supports OpenRouter, Cloudflare AI Gateway, and any OpenAI-compatible endpoint, such as Ollama.
- The Household uses one AI provider at a time.

### 7. The app states facts; the AI adds words

- Every number and every chart comes from the app's own data.
- The AI writes only words, and choices from fixed lists.
- An Alert's facts come from a template. The AI may add one or two sentences of advice ([Anomalies and Alerts](06-anomalies-and-alerts.md)).

### 8. The Budget is the only Overspending baseline

- Overspending is measured only against the Budget.
- History is never an Overspending baseline, because a Household may overspend from day 1.
- An Anomaly is unusual against the Household's own history ([Anomalies and Alerts](06-anomalies-and-alerts.md)).

### 9. Build our own

- We build the app ourselves.
- Other open-source trackers, such as Actual Budget, Sure, Maybe, and Firefly III, are reference material only. We do not fork them ([ADR 0001](../adr/0001-build-our-own.md)).
- Prototype and research branches are reference material only. They never merge.

### 10. TypeScript from end to end

- The server, the web app, the jobs, the `fft` command, and the tests are all TypeScript ([Stack and architecture](10-stack-and-architecture.md), [ADR 0002](../adr/0002-one-node-process-hono-and-sqlite.md)).

### 11. Privacy

- The app sends Household data only to the services in this table:

  | Service | When | What it gets |
  |---|---|---|
  | Bank-data provider (Plaid) | Each sync | Access tokens. It returns Accounts and Transactions. |
  | AI provider, if set up | AI work | Summaries, Transaction batches, and Chat, as the app builds them ([AI](08-ai.md)) |
  | The Household's SMTP server, if set up | Email Alerts and System notices | The message |
  | Each Member's browser push service | Push Alerts and System notices | The message, encrypted by Web Push |
  | BLS API | CPI fetch | Nothing about the Household |
  | GitHub | Daily update check, which a Member can turn off | Nothing about the Household |

- The AI provider gets the Household's data as the app builds it, with no privacy filter (owner decision, 2026-11-07). The ZIP code and ages are never sent, nor any secret, key, or token ([AI](08-ai.md#what-the-ai-provider-gets)).
- The app uses only AI providers and settings that do not train on API data or use it for ads ([AI](08-ai.md)).
- The AI provider's API key still ties each request to the key owner's provider account.
- The app has no analytics, usage tracking, or crash reporting.
- The app shows no ads and no affiliate links. The AI names financial products by kind only, never by company ([AI](08-ai.md)).
- Household facts (ZIP code, ages, rent or own) stay on the server. No one is asked their sex.
- The Master key encrypts every stored secret. Secrets never leave in an export ([Members, login, and security](09-members-login-security.md), [Backup, restore, and export](11-backup-restore-export.md)).

### 12. Safe on the public internet

- Every Member has a password plus TOTP. A passkey is an optional extra.
- HTTPS is required when the app is reachable from the internet. Plain HTTP works only at a local address.
- The details are in [Members, login, and security](09-members-login-security.md).

### 13. Low, predictable AI cost

- The AI runs rarely and gets summaries, not raw history.
- The AI cost cap stops background AI at a monthly amount. The default is $10 a month.
- The expected cost is about $3.20 a month on Anthropic and about $1.30 on OpenAI ([AI](08-ai.md)).

### 14. One vocabulary

- Screens, code, and docs use the terms in [`GLOSSARY.md`](../../GLOSSARY.md), and never a word from an _Avoid_ list.

## What v1 includes

| Area | File |
|---|---|
| Accounts, Connections, bank sync, Unconnected accounts, Manual loans | [02](02-accounts-and-bank-sync.md) |
| Spending, Income, Transfers, Saving, Refunds, Reimbursements, loans | [03](03-money-movement.md) |
| Categories, the categorization cascade, Category rules, Merchants | [04](04-categorization.md) |
| Benchmarks, Budgets, Goals | [05](05-budgets-benchmarks-goals.md) |
| Recurring charges, Anomalies, Alerts | [06](06-anomalies-and-alerts.md) |
| The dashboard and every other page | [07](07-dashboard-and-pages.md) |
| Every AI use, the AI cost cap | [08](08-ai.md) |
| Members, login, the security mode, the Master key | [09](09-members-login-security.md) |
| Stack, process model, migrations, license checks | [10](10-stack-and-architecture.md) |
| Backups, restore, data export | [11](11-backup-restore-export.md) |
| Install, `fft` commands, first-run setup, updates | [12](12-install-and-first-run.md) |

Everything v1 leaves out is in [Out of scope](13-out-of-scope.md).

## Sources

- [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2)
- [Choose the bank-data provider](https://github.com/therecluse26/family-finance-tracker-private/issues/11)
- [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10)
- [One AI library for all AI providers, and their data-use policies](https://github.com/therecluse26/family-finance-tracker-private/issues/5)
- [Budget drafting and Goals](https://github.com/therecluse26/family-finance-tracker-private/issues/15)
- [Anomalies and Alerts](https://github.com/therecluse26/family-finance-tracker-private/issues/16)
- [Monthly review, Insight cards, and Chat](https://github.com/therecluse26/family-finance-tracker-private/issues/17)
- [AI context and cost](https://github.com/therecluse26/family-finance-tracker-private/issues/20)
- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21)
- [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23)
