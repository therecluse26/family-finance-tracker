# Poll Plaid; no webhooks

Plaid can push changes to an app by webhook, but a webhook needs a public URL. A self-hosted app often has none: it runs on a home network, behind Tailscale, or on `localhost`. Plaid's webhooks are optional; an app can poll `/transactions/sync` and `/item/get` instead. The Trial plan does not cap API calls on connected Items, so polling costs nothing.

The app registers no webhook and polls. Each healthy Connection syncs every 6 hours at a random minute. Sync now calls Plaid's Transactions Refresh at most once per Connection per hour. Temporary errors back off from 1 hour up to 24 hours. A Connection that needs a Member stops polling and gets one check a day. Plaid Link also runs with no redirect URI: OAuth banks open in a pop-up, so linking needs no public URL either. [Accounts and bank sync](../spec/02-accounts-and-bank-sync.md#sync-schedule) holds the exact rules.

Polling works the same on every install, with no inbound port and nothing exposed to the internet. It has three costs. New Transactions arrive up to 6 hours late; Alerts already wait for posted Transactions, 1 to 3 days after a purchase. The app learns about a broken Connection only at its next poll. And Plaid's webhook-only signals never arrive: `NEW_ACCOUNTS_AVAILABLE`, `PENDING_EXPIRATION`, and `PENDING_DISCONNECT`. So new accounts come in through "Add accounts" in update mode. An expired bank consent shows up as `ITEM_LOGIN_REQUIRED` at the next poll.

## Sources

- [Plaid free tier for a self-hosted personal app](https://github.com/therecluse26/family-finance-tracker-private/issues/3)
- [Choose the bank-data provider](https://github.com/therecluse26/family-finance-tracker-private/issues/11)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10)
- [Plaid Link update mode](https://plaid.com/docs/link/update-mode/), checked 2026-11-02
