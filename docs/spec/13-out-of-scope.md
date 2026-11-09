# Out of scope

v1 does not do the things below. Each line has a one-line reason and the ticket that decided it. Lines marked **After v1** are expected to follow. The rest stay out until a new decision brings them in.

## Product

| Not in v1 | Why | Decided in |
|---|---|---|
| Moving money and bill pay | The app is read-only. | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2) |
| Tax preparation and business finances | The app is for personal household use only. | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2) |
| Investment holdings and a net-worth figure | Investments are not tracked, so a net-worth number would mislead. Account balances and total debt over time still show. | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2) |
| Member roles and private Accounts | Every Member is equal and sees all data. | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2), [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12) |
| Custom Categories: adding, renaming, or removing one | The Category list is fixed in v1. | [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14) |
| Receipt import and Amazon order import | Both need manual exports, which breaks hands-off use. | [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14) |
| Merchant merge | A Merchant is identified by the provider's Merchant ID, else by its clean name. | [Assemble the v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/24) |
| In-app tuning of the link rules for Transfers, Refunds, and Reimbursements | A Member's correction fixes that one item only. Developers tune the rules between releases. | [Assemble the v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/24) |
| Budget rollover | Money left in a Budget does not carry into the next month. | [Budget drafting and Goals](https://github.com/therecluse26/family-finance-tracker-private/issues/15) |
| Fraud detection | It stays the bank's job. | [Anomalies and Alerts](https://github.com/therecluse26/family-finance-tracker-private/issues/16) |
| Native phone apps | The installable web app covers phones. | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2) |

## Data sources

| Not in v1 | Why | Decided in |
|---|---|---|
| File import (CSV, OFX, QFX) | **After v1,** as the first new adapter. Until then, a bank Plaid cannot reach is an Unconnected account. | [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19), [Assemble the v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/24) |
| A SimpleFIN Bridge adapter | **After v1.** It is paid and untested on real data. | [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10) |
| A Teller adapter | **After v1.** Plaid covers the example institutions; Teller misses Synchrony and Larkspur. | [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19) |
| Paid or contract-only Bank-data providers, such as MX, Finicity, and Akoya | Production access needs a contract or business review, at prices they do not publish. | [Free alternatives to Plaid for US bank data](https://github.com/therecluse26/family-finance-tracker-private/issues/4) |
| Signing in to Amazon to read orders, with `amazon-orders` or a browser | Amazon's sign-in sends a JavaScript challenge, so it needs a hidden browser. The owner judged that worse than uploading Amazon's file. | [Line items](14-line-items.md), owner decision, 2026-11-09 |
| Screen scraping and OFX Direct Connect | Scrapers store bank passwords and need a person for MFA. OFX Direct Connect is dead at Chase and Capital One. | [Free alternatives to Plaid for US bank data](https://github.com/therecluse26/family-finance-tracker-private/issues/4) |
| Non-US banks, and amounts in other currencies | v1 is US only. The Bank-data provider interface leaves room for later. | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2) |
| Plaid webhooks | The app polls. Webhooks need a public URL. | [Plaid free tier for a self-hosted personal app](https://github.com/therecluse26/family-finance-tracker-private/issues/3) |
| A second Connection to the same bank, such as one for a second Member's own bank sign-in | One Connection per bank protects Plaid's 10 lifetime Items. A second sign-in at Chase can break the first Connection. | [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19) |
| Manual tracking of credit cards and lines of credit | Their balances move with purchases the app cannot see. | [Manually tracked debts](https://github.com/therecluse26/family-finance-tracker-private/issues/18) |
| A Plaid sandbox dry run in setup | Sandbox data would mix with real data. | [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21) |
| Benchmark sources with license terms, such as the MIT Living Wage Calculator and the EPI Family Budget Calculator | MIT needs a license beyond 10 locations. EPI's terms are unconfirmed. | [Free public US spending benchmarks](https://github.com/therecluse26/family-finance-tracker-private/issues/6) |

## Hosting

| Not in v1 | Why | Decided in |
|---|---|---|
| A hosted service, or many Households per instance | One self-hosted instance serves one Household. | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2) |
| More than one app instance on one database | SQLite does not share. | [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21) |
| Running on Cloudflare Workers or D1 | D1 needs the whole app on Workers. There, the Free plan's CPU cap makes the paid plan the realistic floor. | [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12) |
| Serverless containers: Cloud Run, AWS App Runner, Azure Container Apps, and Lambda | They scale to zero and give no lasting local disk, which breaks SQLite and the job runner. | [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21) |
| Turso | v1 supports only the local database file. The driver stays `@libsql/client`, so Turso stays a small job later. | [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22) |

## AI

| Not in v1 | Why | Decided in |
|---|---|---|
| More than one AI provider at a time | v1 uses one AI provider at a time. | [AI context and cost](https://github.com/therecluse26/family-finance-tracker-private/issues/20) |
| AI providers' batch APIs | Quick-tier work goes in normal calls of up to 100 Transactions. | [AI context and cost](https://github.com/therecluse26/family-finance-tracker-private/issues/20) |
| Summing up older Chat turns | Older turns are dropped, and the Chat shows a line when that happens. | [AI context and cost](https://github.com/therecluse26/family-finance-tracker-private/issues/20) |
| A tone or length setting | In testing, no one could see a difference between Plain, Warm, and Blunt. | [Monthly review, Insight cards, and Chat](https://github.com/therecluse26/family-finance-tracker-private/issues/17) |
| A separate email or phone notice for the Monthly review | On the 1st, a note in the AI box links to it. | [Monthly review, Insight cards, and Chat](https://github.com/therecluse26/family-finance-tracker-private/issues/17) |
| Naming financial products by company, and affiliate links | The app is open source and has no affiliates. | [Monthly review, Insight cards, and Chat](https://github.com/therecluse26/family-finance-tracker-private/issues/17) |

## Other

| Not in v1 | Why | Decided in |
|---|---|---|
| Forking an existing tracker | We build our own ([ADR 0001](../adr/0001-build-our-own.md)). | [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2) |
| Password-only login | Every Member has a password plus TOTP. | [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21) |
| Full-database encryption | App-level encryption covers the secrets. The setup guide advises disk encryption on the host. | [Encrypting a self-hosted database at rest](https://github.com/therecluse26/family-finance-tracker-private/issues/8), [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12) |
| Encrypted backup and export files | Secrets inside a backup stay encrypted with the Master key, and an export holds none. The guide suggests an encrypted disk. | [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22) |
| Master key rotation | v1 has no rotation command. The key IDs in each encrypted value leave room for one later. | [Assemble the v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/24) |
| Restore from a web page | Every Member has equal powers, so a web restore would let any Member overwrite all data. | [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22) |
| A reset command | Deleting `data/` loses every Plaid token, and connecting again spends new Items. A restore is the way back. | [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21) |
| Built-in upload of backups to cloud storage, such as S3 | Backups go to a mounted folder that the self-hoster may point anywhere. | [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22) |
| Export in other apps' formats (YNAB, Actual, QIF, OFX), and importing an export back | Export is CSV and JSON. A restore uses backups. | [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22) |
| A CLA or DCO | Code comes in under the project license, as GitHub's terms already say. | [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23) |
| License headers in source files | The `LICENSE` file, the README, and `package.json` state the license. | [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23) |
