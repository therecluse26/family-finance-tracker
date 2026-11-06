# Accounts and bank sync

The app reads the Household's Accounts from Bank-data providers through one adapter interface. v1 ships one real adapter: Plaid, on its free Trial plan, polled and never driven by webhooks. Plaid's Trial plan allows only 10 lifetime Items, so the app never spends one without need. It imports existing access tokens, blocks a second Connection to a bank, and repairs only in update mode. Accounts that no provider syncs are Unconnected accounts or Manual loans.

## Accounts

An Account is a bank account, credit card, or loan that belongs to the Household. Each Account comes from one of three sources.

| Source | Kinds | How its data updates |
|---|---|---|
| A Connection | checking, savings, credit card, loan | Its adapter syncs it ([Sync schedule](#sync-schedule)) |
| [Unconnected account](#unconnected-accounts) | savings, HSA, investment or retirement, other | A balance a Member types, plus the Transfers the app sees |
| [Manual loan](#manual-loans) | personal, car, student, mortgage, buy now pay later | The payments the app finds |

- A synced Account of Plaid type `investment` counts like an Unconnected account of kind "investment or retirement". Money moved into it is Saving ([Money movement](03-money-movement.md)). Its own Transactions count nowhere, and the app keeps them.

### Account fields

| Field | Notes |
|---|---|
| Name | From the provider or the form. A Member may rename it. |
| Kind and subtype | For example checking, or a loan with subtype `personal`, `auto`, `mortgage`, or `student`. |
| Institution | ID and name. An Unconnected account has an optional name only. |
| Last 4 digits | Plaid's `mask`. Optional for an Unconnected account. |
| Current and available balance | Synced. An Unconnected account or a Manual loan has an estimate instead. |
| Credit limit | Credit cards. |
| Card details (optional) | APRs, statement balance, minimum payment, due date. |
| Loan details (optional) | APR, principal, interest paid this year, minimum payment, due date. |
| Loan type | Loans only: Cash loan or Purchase loan ([Connected loans](#connected-loans), [Manual loans](#manual-loans)). |
| APR typed by a Member | Optional, loans only. |
| Exclude | A switch, off by default. |
| Closed | A flag, with the date. |
| Provider account ID | The adapter's stable ID for the Account. |

### Exclude

- Each Account has an Exclude switch. It is off by default.
- An excluded Account is treated like an Unconnected account:
  - Its own Transactions count nowhere: not in Spending, Income, Budgets, Alerts, or the AI's data. The app keeps them.
  - Money between it and an included Account counts as a Transfer.
  - Its balance drops out of every balance and total.
- An excluded Account still syncs.
- When a Member turns the switch on or off, the app runs matching and totals again over all history.
- Typical use: a business card or a relative's joint account that a Connection brings in.

### Closed Accounts

- An Account becomes Closed in these cases:
  - Its provider stops returning it ([Changes to synced data](#changes-to-synced-data)).
  - Its Connection is removed ([Removing a Connection](#removing-a-connection)).
  - It is a Manual loan whose balance reaches $0.
  - A Member closes it by hand. Any Account may be closed this way.
- A Member may reopen any Closed Account.
- When a Member closes an Account that is already Closed because its provider stopped returning it, it becomes closed by the Member. It then opens again only when a Member reopens it.
- A Closed Account drops out of balances and balance totals. Its past Transactions still count in Spending, Income, Budgets, and graphs.
- Closing an Account sends no System notice. Its history stays.

## Connections

A Connection joins one bank to the app through one Bank-data provider. It brings in one or more Accounts.

- A bank has at most one Connection. The provider is chosen per bank. In v1, every Connection uses Plaid.
- A Connection stores these fields:
  - the provider, and the bank's ID and name;
  - its health and its history-loaded status;
  - the sync cursor and its sync minute;
  - the provider credential, encrypted with the Master key ([Members, login, and security](09-members-login-security.md));
  - whether it was linked or imported;
  - its last successful sync time.

| Health | Meaning | Polling |
|---|---|---|
| Healthy | The last sync worked. | Every 6 hours |
| Retrying | The last sync hit a Temporary error. | [Back-off](#back-off) |
| Needs a Member | The provider needs a person, such as after a bank password change. | Stops. One check a day until repaired. |
| Broken | The provider says access is gone. | Stops. |

### Banks the app cannot connect

- v1 has no file import. File import is the first adapter after v1 ([After v1](#after-v1)).
- Some banks stay unconnected: Plaid cannot reach them, or the Household chooses not to connect them. Until file import ships, such a bank joins the app by what it holds:
  - An account that holds money: an Unconnected account.
  - An installment loan: a Manual loan.
  - A credit card: not tracked. Payments to it count as Spending in Miscellaneous ([Money movement](03-money-movement.md)).
- This is a normal setup, not a failure. Example: a Household keeps its Pinecrest savings as an Unconnected account. Pinecrest offers no OAuth, so any provider would have to store the bank password.

## The bank-data adapter

One adapter interface sits at the seam between Bank-data providers and the core. Each adapter translates its provider's data into the app's own records. Transfer matching, categorization, and analysis never see provider types.

- **v1 adapters:** the Plaid adapter, and an in-memory fake adapter for tests. The fake makes the seam real and keeps tests offline.
- **After v1:** SimpleFIN, Teller, and file import ([After v1](#after-v1)).
- **Beside the interface, not behind it:** Manual loans and Unconnected accounts. No provider is involved.

```ts
interface BankDataAdapter {
  provider: "plaid" | "fake";          // later: "simplefin", "teller", "file"
  minSyncGapHours: number;              // Plaid 0; SimpleFIN would set about 1
  actions: { repairInApp: boolean; importExisting: boolean; refresh: boolean };

  startLink(): Promise<LinkSession>;                 // e.g. a Plaid link token
  finishLink(result: LinkResult): Promise<NewConnection>;  // checks for a duplicate bank before the token exchange
  importExisting?(credential: string): Promise<NewConnection>;
  startRepair?(c: Connection): Promise<LinkSession>; // Plaid update mode
  sync(c: Connection, cursor: string | null): Promise<SyncResult>;
  refresh?(c: Connection): Promise<void>;
  remove(c: Connection): Promise<void>;
}

type SyncResult = {
  accounts: AccountSnapshot[];          // balances and optional card or loan details
  added: TxnRecord[]; changed: TxnRecord[]; removed: { id: string; reason: string }[];
  nextCursor: string; historyLoaded: boolean;
};
```

- **One sync shape:** cursor-based added, changed, and removed. An adapter with only date windows (SimpleFIN, Teller) fakes the cursor inside. It requests overlapping windows and compares them by ID.
- **Optional data is an empty field.** There are no per-adapter data flags. The core copes: for example, the categorization cascade skips the provider-category step when that field is empty.
- **Actions are the only per-adapter declarations.** When an adapter lacks an action, the app hides its button.
- **`minSyncGapHours`** is the shortest time between two syncs of one Connection.
- **`historyLoaded`** is true once the provider has sent all the history it will send.

### Records the adapter returns

| Record | Fields |
|---|---|
| Connection | Bank ID and name, health, history-loaded status. |
| Account (`AccountSnapshot`) | Provider account ID, name, type and subtype (such as a `personal` or `auto` loan), last 4 digits, current and available balance, credit limit. |
| Card and loan details (optional) | APRs, statement balance, minimum payment, due date, principal, interest paid this year. |
| Transaction (`TxnRecord`) | Stable ID, Account, amount, posted date, authorized date, pending status, the pending Transaction's ID, original bank description, Merchant name, Merchant ID, and the other parties named on it with their types (such as `financial_institution`, `payment_app`, or marketplace). |
| Category data (optional) | The provider's category, its confidence, its version, and the merchant category code (MCC). |
| Raw | The provider's original data for each record. |

- **Amounts** are integer cents in US dollars. A positive amount is money into the Account; a negative amount is money out. The Plaid adapter flips Plaid's sign.
- **Raw data** is stored with each record, so a later version can reprocess history without fetching it again.
- Raw data holds no account number and no personal detail. The Plaid adapter drops these fields by name, at every depth: `account_number`, `account_numbers`, `payment_reference_number`, `reference_number`, `ppd_id`, `payer`, `payee`, `by_order_of` and `reason` (in `payment_meta`), `account_owner`, `property_address` (in a mortgage's details), and `verification_insights` (on an Account). An Account's `verification_name` stays.
- **Provider categories** carry the transfer, credit card payment, loan payment, and loan payout (`LOAN_DISBURSEMENTS_*`) signals that [Money movement](03-money-movement.md) uses.
- **MCC:** the Plaid adapter leaves it empty. When a later adapter sends one, it is a hint to the AI only ([Categorization](04-categorization.md)).

### Error kinds

Each adapter sorts every provider error into one of three kinds. The core acts only on the kind.

| Kind | Example | What the core does |
|---|---|---|
| Temporary | A bank outage | Sets the Connection to Retrying, backs off, and retries ([Back-off](#back-off)). |
| Needs a Member | A changed bank password | Sets Needs a Member. Sends a System notice and offers Repair ([Broken Connections](#broken-connections)). |
| Gone | Access revoked | Sets Broken. Sends a System notice and offers Repair. |

## The Plaid adapter

The Plaid adapter declares `minSyncGapHours: 0` and all three actions: `repairInApp`, `importExisting`, and `refresh`.

### Plaid keys

- A Member enters the Plaid client ID and Production secret. Settings and setup's Banks step both ask for them ([Install and first-run setup](12-install-and-first-run.md)).
- The app tests them at once with `/institutions/get`, which spends no Item.
- The app uses Plaid's Production environment only. It never asks for the sandbox secret. Tests use the fake adapter.
- The app stores the secret encrypted with the Master key, like the access tokens.

### The 10 lifetime Items

- Plaid's free Trial plan allows 10 Production Items for the life of the Plaid team. Every access token created in Production spends one. Removing an Item does not free its slot.
- API calls on connected Items are not capped.
- The app guards the Items:
  - [Import Plaid Connection](#import-plaid-connection) adopts an existing access token and spends no Item.
  - A second Connection to a bank is blocked before the token exchange ([Linking a new bank](#linking-a-new-bank)).
  - Repairs use update mode, which keeps the same Connection and spends no Item ([Repair](#repair)).
  - Setup offers no sandbox dry run, because sandbox data would mix with real data.
- Plaid reports no count of Items used. Settings show "at least N of 10 used".
  - N counts every Plaid Connection the app created or imported, removed ones included.
  - A Member may raise N in settings, for Items spent outside the app. N never falls below the app's own count.
- "Link a new bank" shows "at least N of 10 used" before Link opens.
  - When N is 8 or more, the Member confirms a second time.
  - When N is 10, the app blocks linking a new bank.

### Linking a new bank

1. Before Link opens, the app lists the banks and Accounts already connected. It tells the Member to link each bank once and to pick every Account the first time.
   - The reason: at Chase, PNC, Navy Federal, and Schwab, a second sign-in to the same bank can break the first Connection. It breaks at the end of the bank's OAuth flow. At Chase this happens when the two account sets differ.
2. The app creates a link token with these settings:
   - `products: ["transactions"]`
   - `required_if_supported_products: ["liabilities"]`, so card APRs and loan details come where the bank supports them.
   - `transactions: { days_requested: 730 }`
   - `country_codes: ["US"]` and `language: "en"`
   - No `webhook` ([ADR 0004](../adr/0004-poll-plaid-without-webhooks.md)) and no redirect URI. OAuth banks open in a pop-up.
3. Plaid fixes `days_requested` when the bank is linked. The app never tries to raise it later.
4. Link runs over HTTPS and from a local plain-HTTP address ([Install and first-run setup](12-install-and-first-run.md)).
5. On Link's `onSuccess`, the app reads the institution and each Account's last 4 digits from the metadata. It checks for a duplicate bank before it exchanges the public token:
   - It blocks when the institution ID matches an existing Connection. "Link again" on a Broken Connection is the one exception ([Repair](#repair)).
   - It also blocks when an incoming Account matches an Account of another Connection by type and last 4 digits.
   - When it blocks, it never exchanges the public token. It names the Connection that already covers the bank.
   - The block covers different Accounts at the same bank too. A second set of bank credentials at that bank cannot be connected.
6. Otherwise the app calls `/item/public_token/exchange`, stores the access token encrypted, and starts the first sync.

### Import Plaid Connection

- Settings and setup's Banks step offer "Import Plaid Connection" next to "Link a new bank". Any Member may use it.
- The Member pastes one access token at a time.
- The app calls `/item/get` and `/accounts/get`. It shows the bank and its Accounts before it saves.
- It blocks a duplicate bank, as in [Linking a new bank](#linking-a-new-bank).
- When Plaid rejects the token, the app says so and saves nothing.
- On save, the app stores the token encrypted with the Master key. It then syncs from an empty cursor, which fetches all the history Plaid holds for that bank.
- The app never shows the token again.
- An imported Connection keeps the `days_requested` it was linked with.
- Imported Connections count in "at least N of 10 used".

### What a Plaid sync calls

- `/transactions/sync` with `count: 500` and `options: { include_original_description: true }`, page by page until `has_more` is false.
  - The adapter saves `next_cursor` only after it stores every page of the run.
  - When a page fails, such as with `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, the adapter restarts the run from the run's first cursor.
  - The app stores Transactions by `transaction_id`. A sync that restarts from its first cursor creates no duplicates.
  - The adapter asks for Plaid's v2 categories ([Categorization](04-categorization.md)).
- `/accounts/get` for the Accounts and their balances.
- `/liabilities/get` for card and loan details. When Plaid has no Liabilities data for a Connection, the details stay empty. That is not an error.
- `historyLoaded` is true when `transactions_update_status` is `HISTORICAL_UPDATE_COMPLETE` and `has_more` is false. Plaid may report this with less history than requested: Capital One sent about 90 days.

| App field | Plaid field |
|---|---|
| Last 4 digits | `mask` |
| Original bank description | `original_description` |
| Merchant name and Merchant ID | `merchant_name`, `merchant_entity_id` |
| Provider category and confidence | `personal_finance_category` and its `confidence_level` |
| Posted date and authorized date | `date`, `authorized_date` |
| Pending status and the pending Transaction's ID | `pending`, `pending_transaction_id` |
| Other parties and their types | `counterparties` |
| Card APRs | `aprs` |
| Statement balance | `last_statement_balance` |
| Minimum payment | `minimum_payment_amount` |
| Due date | `next_payment_due_date` |
| Interest paid this year | `ytd_interest_paid` |
| Principal | The loan Account's current balance |

- Plaid's Liabilities data covers credit cards, student loans, and mortgages. It does not cover personal loans such as Larkspur. In Plaid's sandbox, an auto loan also came back with no details.

### Plaid errors

| Kind | Plaid errors |
|---|---|
| Temporary | Error types `INSTITUTION_ERROR`, `API_ERROR`, and `RATE_LIMIT_EXCEEDED`; HTTP 5xx; network failures; any error not listed in this table. |
| Needs a Member | `ITEM_LOGIN_REQUIRED`, `ITEM_LOCKED`, `USER_SETUP_REQUIRED` |
| Gone | `ITEM_NOT_FOUND`, `INVALID_ACCESS_TOKEN`, `INSTITUTION_NO_LONGER_SUPPORTED` |

- An error code listed in the table wins over its error type.

### Repair

- **Needs a Member:** Repair opens Link in update mode. The link token carries the Connection's `access_token` and no products. The Connection and its access token stay the same, and no Item is spent.
- The app never repairs a Needs-a-Member Connection by linking the bank as new.
- When a Repair finishes, the app syncs that Connection at once. A successful sync makes it Healthy.
- **Broken:** update mode cannot work, because the access token no longer works. Repair offers "Link again" instead.
  - Link again follows [Linking a new bank](#linking-a-new-bank), with the Item count and its confirmation. It spends a new Item.
  - Link again does not call `/item/remove` for the Broken Connection's Item, even after `INSTITUTION_NO_LONGER_SUPPORTED`.
  - The duplicate-bank block lets it through, because the new Connection replaces the Broken one.
  - The new Connection's Accounts carry on the old ones ([Carrying Accounts over](#carrying-accounts-over)).

### New accounts at a bank

- Plaid reports new accounts at a bank only by webhook, so the app cannot see them by polling.
- Each Connection in settings has "Add accounts". It opens update mode with `update.account_selection_enabled: true`. It spends no Item.
- When a sync returns an Account the app has not seen, the app tracks it at once. A gentler System notice names the new Account and points to its Exclude switch. This notice has no banner and no Repair button.

### Removing a Connection

- Any Member may remove a Connection in settings.
- First the app says that the Plaid Trial slot stays spent. The Member confirms.
- The app calls `/item/remove` and deletes the access token. The Connection's Accounts become Closed. Their history stays.
- "Delete history" is a separate action with its own confirmation. It deletes the Connection's Accounts and their Transactions. Links that used those Transactions are undone, and matching runs again.

### Carrying Accounts over

- A new Account can match an old one at the same bank by type, subtype, and last 4 digits. It then carries on the old one when the old one is either:
  - a Closed Account, or
  - an Account that vanished from the same Connection in the same sync.
- The carried Account keeps its ID, hand-set fields, and history. It takes the new provider account ID.
- Old Transactions from a different Connection have different IDs from the new ones. This happens after Link again, or after a bank is removed and linked again. The app then splits the history at day D, the day of the old Connection's last successful sync:
  - It keeps the old Transactions dated before D.
  - It keeps the new Transactions dated on or after D.
  - It hides the rest with the reason `replaced by re-link`.
- If the old Connection never finished a sync, it has no day D. The app hides all of its Transactions on that Account with the reason `replaced by re-link`, and keeps all the new ones, so none of its partial history stays. A day D the Account already has from an earlier carry-over still holds.
- The new Connection records the old Connection whose Accounts it carries on.
- **Link carry-over:** a hand-made link on an old Transaction hidden as `replaced by re-link` does not end at once. It moves to that Transaction's new copy: a new Transaction on the same Account, with the same amount and the same posted date. When several fit, the app pairs them one to one, the same description first. The moved link stays a hand-made link.
  - If no copy has arrived when the new Connection's first history load ends, the link ends, and matching runs again.
  - The wait also ends, the same way, when the new Connection is removed before that load ends, or 7 days after the carry-over if the load still has not ended, for example while the Connection stays Broken.
  - An app-made link on a replaced Transaction ends, and matching runs again on the new Transactions.

### A lost Master key

- Without the Master key, the app cannot read any access token. Plaid's update mode needs the old token. Every Connection becomes Broken, and Members use Link again for each bank ([Backup, restore, and export](11-backup-restore-export.md)).
- Each Link again spends a new Item. Example: a Household with the example institutions spends 6 Items once Synchrony and Larkspur are linked. They go to Ally, Capital One, Chase, Synchrony, Larkspur, and Pinecrest, whose Item was removed. Linking the 5 connected banks again needs 5 more Items, 11 in all: 1 bank over the limit.
- That bank stays unconnected until file import ships ([Banks the app cannot connect](#banks-the-app-cannot-connect)).

## Sync schedule

- Each Healthy Connection syncs every 6 hours, at 00:mm, 06:mm, 12:mm, and 18:mm in the Household's time zone.
  - mm is a random minute from 0 to 59, picked once when the Connection is made.
- An adapter may set a longer minimum gap with `minSyncGapHours`. Plaid sets 0.
- At startup, a Connection whose last sync attempt is more than 6 hours old syncs at once.
- Each Connection syncs as its own Sidequest job ([Stack and architecture](10-stack-and-architecture.md)). One Connection runs one sync at a time.

### Sync now

- Any Member may press Sync now. It syncs every Connection that is Healthy or Retrying.
- Sync now first calls Refresh where the adapter supports it (Plaid's `/transactions/refresh`).
  - Refresh runs at most once per Connection per hour. A second press within the hour just syncs.
  - Refresh makes the bank fetch fresh data, which arrives later. After a Refresh, the app syncs at once and again 5 minutes later.
- When a Connection synced less than `minSyncGapHours` ago, Sync now skips it and shows when it can sync next.
- A successful sync ends any back-off.

### Back-off

- **Temporary error:** the Connection becomes Retrying. Retries come after 1, 2, 4, 8, and 16 hours, then every 24 hours. A successful sync returns it to the 6-hour schedule.
- After 3 days in Retrying, every Member gets one System notice: "<bank> has not synced since <date>". It has no Repair button. Retries go on.
- **Needs a Member:** polling stops. Once a day the app checks the Connection (Plaid: `/item/get`). When the check shows no error, the Connection becomes Healthy and syncs.
- **Broken:** polling stops.

### After a sync

- A sync with new, changed, or removed Transactions starts one follow-up job. It runs these steps in order:
  1. Matching ([Money movement](03-money-movement.md)).
  2. Categorization ([Categorization](04-categorization.md)).
  3. Recurring charge and Anomaly checks ([Anomalies and Alerts](06-anomalies-and-alerts.md)).
  4. Alerts ([Anomalies and Alerts](06-anomalies-and-alerts.md)).
  5. The once-a-day Insight card check ([AI](08-ai.md)).
- A sync with no changes starts nothing, so it never triggers an AI call.
- Balances update on every sync ([Balances](#balances)).

## Broken Connections

- When a Connection becomes Needs a Member or Broken, every Member gets one System notice through their chosen channels. [Anomalies and Alerts](06-anomalies-and-alerts.md) gives the delivery rules for System notices.
- A banner stays in the app until the Connection is Healthy again. It has a Repair button ([Repair](#repair)).
- The dashboard marks that bank's Accounts "last synced <date>".
- Analysis keeps running on the data the app has. A card with a broken Connection still counts as tracked ([Money movement](03-money-movement.md)).

## First history load

- Each bank linked through Plaid asks for 730 days of history. Plaid returns about 18 months where it has them, which is enough.
- An imported Connection brings the history its access token was linked with.
- Non-AI work runs as data arrives: matching, rule-based Categories, Recurring charges, Anomalies.
- While a Connection's history loads:
  - The dashboard shows "loading history for <bank>", with progress per Connection.
  - The app syncs that Connection every 15 minutes, or every `minSyncGapHours` if that is longer.
- Background AI waits until every Connection's history has loaded. This covers Insight cards, AI categorization, the Monthly review, and every other background AI call.
- A Connection stops holding back AI in these cases:
  - 24 hours pass after it was made, and its history has not loaded.
  - It becomes Needs a Member or Broken.
- When the wait ends, these happen once:
  - The AI's first run on all history starts ([AI](08-ai.md)).
  - The formula drafts the Budgets ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).
  - Every Member gets one System notice: "Your history is ready".
- Anomalies found in loaded history are stored but never pushed ([Anomalies and Alerts](06-anomalies-and-alerts.md)).
- A Connection whose history loads after the wait ends goes through the normal pipeline.

### A bank added later

- A Connection added after the first wait ends never holds back AI. Its history goes through the normal pipeline. Its AI work counts against the AI cost cap.
- The app does not redraft Budgets. When the new history has loaded, the app recomputes each Category's 12-month average. If any average moves more than 10%, a Proposal follows ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).

## Changes to synced data

- **Changed Transaction:** it runs through categorization and matching again. Anything a Member set by hand stays.
- **Pending to posted:** Plaid removes the pending record and adds a posted one whose `pending_transaction_id` points back. Links, the Category, and hand-set fields carry over ([Money movement](03-money-movement.md)). The pending record is hidden with the reason `posted`.
- **Removed Transaction:** hidden but kept, with the reason. Transfer, Refund, and Reimbursement links that used it are undone, and matching runs again.
- **Removal reasons:** `posted`, `removed by provider`, and `replaced by re-link`.
- **Disappeared Account:** when the provider stops returning an Account, it becomes Closed. Its history stays. No System notice goes out. A Member can reopen it. An Account that reappears under a new provider ID carries over ([Carrying Accounts over](#carrying-accounts-over)).

## Balances

- Each sync saves each Account's current and available balance.
- The app keeps one balance per Account per day, from the first sync on. The day's last sync wins.
- Card and loan details are saved with that daily balance.
- Dates before the first sync are worked backward from the first saved balance, by undoing each day's posted Transactions. The app shows these balances as "estimated".
- Unconnected accounts and Manual loans have their own estimates ([Unconnected accounts](#unconnected-accounts), [Manual loans](#manual-loans)).

## Unconnected accounts

An Unconnected account holds the Household's money but does not sync, such as an HSA. Any Member may add one in setup's Banks step or in settings, and edit it at any time.

| Field | Required | Notes |
|---|---|---|
| Name | Yes | |
| Kind | Yes | Savings, HSA, investment or retirement, or other. |
| Current balance | No | Saved with today's date. |
| Institution name | No | Used to match Transfers. |
| Last 4 digits | No | Used to match Transfers. |

- The "other" kind's help text says: a payment app, such as Venmo or PayPal, is never an Unconnected account.
- The form says that a loan is added as a Manual loan, never as an Unconnected account.
- [Money movement](03-money-movement.md) decides what money sent to an Unconnected account counts as. It also decides which Unconnected account a one-sided Transfer goes to.

### Balance estimate

- A Member may type the true balance at any time. It is saved with that day's date and overrides the estimate.
- The estimate is the last typed balance, plus money moved in, minus money moved out. It counts only the Transfers and Saving the app assigned to the account after that date.
- With no typed balance, the estimate starts at $0 on the first day of loaded history.
- The estimate misses interest and market growth.
- Right after a Member types the balance, it shows as typed, with its date. It shows "estimated" once an assigned Transfer moves it. With no typed balance, it always shows "estimated".
- Goal progress for money in an Unconnected account uses this estimate ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).

## Manual loans

A Manual loan is a loan a Member enters by hand, because no Bank-data provider syncs it. It is an Account. It uses no Item. The app finds its payments and lowers its balance by itself.

- **What qualifies:** installment loans: personal, car, and student loans, mortgages, and buy now pay later plans.
- **What does not:** credit cards and lines of credit. Their balances move with purchases the app cannot see.

| Field | Required | Notes |
|---|---|---|
| Lender | Yes | Compared with Merchant names to find payments. |
| Loan type | Yes | Personal, car, student, mortgage, or buy now pay later. |
| Current balance and its date | Yes | |
| Interest rate (APR) | Yes | |
| Regular payment amount | No | Makes payment matching more reliable. |
| Escrow per payment | No, mortgages only | That part counts as Spending in Housing ([Money movement](03-money-movement.md)). |
| Cash loan or Purchase loan | Set by the app | A personal loan starts as a Cash loan. Every other type starts as a Purchase loan. A Member may switch it. |

- Any Member may add a Manual loan in setup's Banks step or in settings, and edit it at any time.
- A Member can add a Manual loan at once, with no payment linked. Linking a payment is optional and can happen at any time.
- For a Cash loan, the app looks for the payout. It links the payout as a Transfer from the loan ([Money movement](03-money-movement.md)).
- When the app sees the loan's payout land in a connected Account, the loan becomes a Cash loan. A Member's own choice of type wins over this.

### Interest

- The app works out interest by itself from the balance and the APR. [Money movement](03-money-movement.md) gives how interest and principal count.
- Car, personal, student, and buy now pay later loans accrue interest daily.
  - Interest = balance × APR ÷ 365 × days.
  - The days run from the previous payment, or from the balance date for the first payment.
- Mortgages accrue interest monthly: balance × APR ÷ 12 for each payment.
- Principal is the payment minus the interest, minus any escrow. It never goes below $0.
- Amounts round to the cent.

### Finding payments

- **The first payment:**
  - The app compares the lender's name with the Merchants in the Household's Accounts. It also checks the regular payment amount, when a Member gave one, and a roughly monthly rhythm.
  - A match is confident when the Merchant matches the lender's name and the amount or the monthly rhythm also agrees. A confident match links at once.
  - Any other match is unsure. It goes on the Review list.
  - Until the first link, the balance stays as entered. Payments to that lender follow the normal rules ([Money movement](03-money-movement.md)).
- **Later payments** use the link tiers in [Money movement](03-money-movement.md). The strong signals are the same Merchant and the same paying Account as the linked payment. The amount may change, for example for an extra payment or the final payment.
- **A payment that does not match** goes through the normal rules. It also goes on the Review list, with "Link to this loan?".
- **A missing payment:** no payment links for 2 months after the last linked one. The loan then goes on the Review list.
- **Payments dated on or before the balance date** link too. The app works their interest backward from the entered balance and the APR. They do not change the current balance.

### Balance and payoff

- Each linked payment dated after the balance date lowers the balance by its principal.
- A Member may correct the balance at any time, with a new date. This is optional; small drift is accepted. Later payments count from the newest corrected balance.
- Between payments the balance does not change. Graphs mark a Manual loan's balance "estimated".
- Manual loan balances count in total debt over time, next to connected loans ([Dashboard and pages](07-dashboard-and-pages.md)).
- When the balance reaches $0, the loan closes by itself. Payments to it after that go on the Review list.

## Connected loans

- **Cash loan or Purchase loan:** the app sets it from the loan's subtype.
  - `personal`: a Cash loan.
  - `auto`, `mortgage`, `student`, and every other subtype: a Purchase loan.
- A loan becomes a Cash loan, whatever its subtype, when the app sees its payout land in a connected Account. Some lenders pay a car loan into checking.
- A Member may switch the type on the Account's page. A Member's choice wins over the subtype and the payout.
- **Interest for each payment** comes from the first source that applies:
  1. **Provider interest data:** the rise in `ytd_interest_paid` across the payment. When the value falls, as it does when a new year starts, the interest is the new value itself.
  2. **An APR a Member typed** on the Account's page: computed as for a [Manual loan](#interest).
  3. **No interest data:** the payment minus the drop in the loan's current balance across that payment. It compares the balance at the last sync before the payment appears with the balance at the first sync after.
- Interest never goes below $0 or above the payment.
- **A lagging balance:** while the data to measure a payment's interest has not come, such as a balance that has not moved yet, the interest is provisional. The wait ends when the next payment lands, or 45 days after the payment (after the first saved balance, for a payment before it). The app then decides the interest once, from the best data it has, and does not decide it again.
- **Payments before the loan's first saved balance** have no saved data to measure. Without an APR, they use the interest share (interest ÷ payment) of the first payment the app measured. Until the app has measured one, their interest is $0.
- [Money movement](03-money-movement.md) gives how the interest and the principal count.

## After v1

These adapters come after v1. Each plugs in behind the same interface, with no change to the core.

- **File import** (CSV, OFX, QFX) is the first adapter after v1.
  - Imported rows for dates that the Account already has from sync are skipped. An import can fill older history but never duplicates a synced Transaction.
  - A category column from a card issuer's file is only a hint ([Categorization](04-categorization.md)).
- **SimpleFIN Bridge** costs $1.50 a month, or $15 a year, and runs on MX. A Household may choose it; no paid provider is required.
  - Bridge warns above 45 days per request, though the protocol page says 90. The adapter requests at most 45 days at a time.
  - About 24 requests a day are allowed. Overuse disables the token. The adapter sets `minSyncGapHours` to about 1.
  - A 2-year backfill in 45-day windows takes up to 17 requests.
  - History depth varies by institution.
  - It gives no provider categories, no APRs, and thinner Transfer signals. Transactions carry `payee`, `memo`, and `mcc`.
  - It has date windows only, so its adapter fakes the cursor.
- **Teller** has a free development tier with 100 enrollments, counting every one ever created.
  - It covers Chase, Capital One, Ally, and Pinecrest Business. It covers neither Synchrony nor Larkspur, because it has no loan accounts.
  - It stores bank passwords.
  - It has date windows only, so its adapter fakes the cursor.

## Sources

- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10)
- [Plaid free tier for a self-hosted personal app](https://github.com/therecluse26/family-finance-tracker-private/issues/3)
- [Free alternatives to Plaid for US bank data](https://github.com/therecluse26/family-finance-tracker-private/issues/4)
- [Choose the bank-data provider](https://github.com/therecluse26/family-finance-tracker-private/issues/11)
- [Manually tracked debts](https://github.com/therecluse26/family-finance-tracker-private/issues/18)
- [Hands-off Transfer, Refund, and Reimbursement detection](https://github.com/therecluse26/family-finance-tracker-private/issues/13)
- [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14)
- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21)
- [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22)
- [Encrypting a self-hosted database at rest](https://github.com/therecluse26/family-finance-tracker-private/issues/8)
- [Dashboard and graphs](https://github.com/therecluse26/family-finance-tracker-private/issues/9)
- [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12)
- Research: [Plaid free tier](https://github.com/therecluse26/family-finance-tracker-private/blob/research/plaid-free-tier/docs/research/plaid-free-tier.md), [Plaid alternatives](https://github.com/therecluse26/family-finance-tracker-private/blob/research/plaid-alternatives/docs/research/plaid-alternatives.md), [Transfer detection](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transfer-detection/docs/research/transfer-detection.md), [Transaction categorization](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transaction-categorization/docs/research/transaction-categorization.md)
- Prototype: [Plaid and SimpleFIN probe on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/tree/task/provider-comparison/prototype/bank-probe)
- Plaid docs, checked 2026-11-02: [Link update mode](https://plaid.com/docs/link/update-mode/) and the [Transactions API](https://plaid.com/docs/api/products/transactions/)
