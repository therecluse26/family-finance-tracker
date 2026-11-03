# One bank-data adapter interface, with Plaid's Trial plan first

The app must bring in Transactions from many US banks, and no paid third party may be required. Bank-data providers differ a lot. Plaid's free Trial plan reaches all six of the example institutions, Larkspur included, with OAuth. It sends categories with confidence levels, Transfer types, other parties, and card APRs. But it allows only 10 Production Items for life, and removing one does not free its slot. SimpleFIN Bridge has no lifetime cap, but it costs money and sends no categories or APRs. One provider may also serve a bank badly: Plaid's Pinecrest Connection failed twice in silence.

We put one `BankDataAdapter` interface at the seam between providers and the core. Each adapter translates its provider's data into the app's own records. Transfer matching, categorization, and analysis never see provider types. The interface has one cursor-shaped sync (added, changed, removed) and three error kinds (Temporary, Needs a Member, Gone). Optional data is an empty field. Only actions (repair in the app, import, refresh) differ per adapter. The provider is chosen per bank, with at most one Connection per bank. v1 ships the Plaid adapter on the Trial plan, plus an in-memory fake adapter for tests. SimpleFIN, Teller, and file import come after v1. The interface itself is in [Accounts and bank sync](../spec/02-accounts-and-bank-sync.md#the-bank-data-adapter).

Plaid won on real Accounts: Categories on every Transaction, hundreds of Transfers typed, and about 18 months of history. It is free for one person, with no business review. Its one real cost, the 10-Item cap, has four guards in the app. The app imports existing access tokens. It blocks a duplicate bank before the token exchange. It repairs only in update mode. It shows "at least N of 10 used". The fake adapter makes the seam real and keeps tests offline. A provider with only date windows fakes the cursor inside its own adapter, so the core never changes for it.

## Considered options

- **Teller first.** Its free development tier allows 100 enrollments. It misses Synchrony and Larkspur, because it has no loan accounts, and it stores bank passwords.
- **SimpleFIN Bridge first.** It covers all six institutions with no lifetime cap. It costs $1.50 a month and allows about 24 requests a day. It sends no categories or APRs. Its first real data request returned `402`, so it is untested on real data.
- **File import in v1.** Regular file downloads break hands-off use. It is the first adapter after v1.
- **Per-adapter data flags.** The core copes with empty fields instead, so the flags add nothing.

## Sources

- [Choose the bank-data provider](https://github.com/therecluse26/family-finance-tracker-private/issues/11)
- [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [Plaid free tier for a self-hosted personal app](https://github.com/therecluse26/family-finance-tracker-private/issues/3)
- [Free alternatives to Plaid for US bank data](https://github.com/therecluse26/family-finance-tracker-private/issues/4)
