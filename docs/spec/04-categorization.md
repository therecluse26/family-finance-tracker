# Categorization

The app gives every Spending Transaction one Category from a fixed list of 30, with no help from a Member. Each Transaction takes the first answer from a cascade: hand-set, Category rule, a confident provider category, the Merchant's own history, then the AI. A Member's correction becomes a Category rule for that Merchant, but corrections are always optional.

## Categories and Category groups

- Only Spending has a Category. A Refund or Reimbursement takes the Category of the Spending it reduces. Transfers, Income, and Saving have no Category ([Money movement](03-money-movement.md#transaction-types)).
- When the app cannot see what Spending paid for, the Category says where the money went. Examples are Superstores and Cash.
- The app owns one Category list. Each Bank-data provider adapter maps its provider's categories onto it.
- The list is fixed in v1. Members cannot add, rename, or remove Categories ([ADR 0007](../adr/0007-fixed-category-list.md)).
- Each Category belongs to exactly one Category group. A Category group's total is the sum of its Categories.
- Budgets, Category rules, and Overspending stay per Category. Graphs show Category groups first, then their Categories.

| Category group | Categories |
|---|---|
| Bills | Housing, Utilities, Phone and internet, Insurance, Taxes and government, Interest and fees |
| Shopping | Groceries, Superstores, Clothing, Home and garden, Alcohol and tobacco, General goods |
| Transportation | Gas, Car, Transit and rideshare |
| Health and care | Health, Personal care, Childcare, Pets, Fitness |
| Leisure | Restaurants, Entertainment, Hobbies, Travel, Books and education |
| Other | Gifts and donations, Payments to people, Cash, Services, Miscellaneous |

## What goes where

| Category | What it holds |
|---|---|
| Superstores | Every Merchant that sells groceries and general goods together: Walmart, Target, Costco, Sam's Club, BJ's, Amazon, and dollar stores. A purchase these Merchants already show apart keeps its own Category. Examples: Costco gas, Whole Foods, and an Amazon Prime membership. |
| General goods | Mixed goods from other stores, including Etsy and eBay |
| Hobbies | Sporting goods, toys, crafts, and hobby supplies |
| Home and garden | Home repairs and upkeep |
| Car | Car repairs and upkeep, and vehicle registration |
| Taxes and government | Income tax payments |
| Housing | Rent and property tax. Mortgage principal and escrow follow [Money movement](03-money-movement.md#loans). |
| Interest and fees | Card interest, card fees, and bank fees, such as ATM, overdraft, late, and annual fees. The interest in every loan payment ([Money movement](03-money-movement.md#loans)). |
| Payments to people | Payments to a person by Zelle, Venmo, Cash App, or PayPal, and money added to Venmo or PayPal ([Money movement](03-money-movement.md#payment-apps)) |
| Cash | Cash withdrawals, and cash back at a checkout ([Money movement](03-money-movement.md#cash)) |
| Miscellaneous | The fallback when nothing else fits, and payments to a card the app does not track ([Money movement](03-money-movement.md#one-side-missing)) |

Upkeep stays with what it maintains: home repairs in Home and garden, and car repairs in Car.

## Merchants

### Names

- The app uses the provider's Merchant name when it has one. Plaid fills `merchant_name` for about 97% of purchases.
- Otherwise, fixed cleanup rules clean the bank's original description. They remove:
  - store numbers;
  - payment-processor prefixes, such as `SQ *` and `TST*`;
  - cities;
  - dates;
  - card and Account numbers, with the words that introduce them. A lead-in is "ending in", "ends with", "last 4" or "last four"; an account word such as "acct", "account" or "a/c"; or "card" or "crd" with a word such as "ending", "#", "no." or "number". A mask such as `XXXX`, `****` or `XXXX-XXXX-` goes with its digits too. The words go with the number wherever it stands, so `NORTHWIND UTILITIES ACCT ENDING 4821` is "Northwind Utilities" and `NORTHWIND CARD XXXX XXXX XXXX 4821` is "Northwind". A word inside a longer word, as in "Neverending", stays. An order code after `*`, such as `*2K4JD8`, goes as one piece.
- Before the rules read a line, they make its plain form:
  - every digit, in any script and in any superscript or circled form, becomes 0 to 9; any other number sign with no plain form counts as a digit;
  - every dash becomes "-", and a full-width character becomes its plain form;
  - format characters, such as a zero-width space, go;
  - a combining mark stays on a letter, as in "Café", and goes from anything else, so `ENDING IN 4́8́2́1` reads as `ENDING IN 4821`.
- A short run of spaces or symbols between the words and digits of a lead-in counts as one gap, so `ACCT ENDING 4.8.2.1` loses the whole number.
- "Card" alone before digits, as in `GIFT CARD 2500` or `STARBUCKS CARD 1234`, may be part of the name. Its words stay, and the name is marked for AI cleanup. On a card payment line, or when the digits carry a mask, the word and the digits go.
- A lead-in that ends the line with no number after it, as when the bank cut the line short (`CHASE CARD ENDING IN`), goes too. A lead-in or mask the rules leave in the name, as in `ENDS WITH 99 BOUTIQUE`, marks the name for AI cleanup.
- A name counts as fixed when the result has 1 to 4 words. No word may be only digits or symbols.
- **A card payment line,** which Plaid files under its credit card payment code, gets the name "<bank> card payment", such as "Chase card payment", and no Merchant ID, whatever Merchant the provider names.
  - The bank is Plaid's financial institution counterparty, when the line has one.
  - Otherwise, when the provider's Merchant name starts with a card issuer the rules know, that issuer is the bank.
  - Otherwise it is the card issuer the line names first, from a list the rules know, such as Chase, Citi, Capital One or Discover, after the rules remove payment words, such as "card ending in", "mobile pymt", "autopay", "online" and "thank you", and every run of digits. On an ACH line, the bank is the originator (`ORIG CO NAME:`), and the text from the first field name (`IND NAME:`, `INDN:`, `NAME:`, `RECEIVER:`, `ID:` and the like) or the first run of 6 or more digits on goes, because the payer's name follows it.
  - When the line names no bank, as in `THANK YOU-MOBILE` on the card's own Account, the name is "Card payment".
  - The words after the issuer's name go, because they may be the payer, as in `CHASE CREDIT CRD EPAY 260105 8273645101 JAMIE RIVERA` ("Chase card payment").
  - When the words left do not start with a known issuer, as in `PAYMENT FROM JAMIE RIVERA` or a small bank's line, the rules cannot be sure they name a bank. The name is "Card payment" and is marked for AI cleanup.
  - No part of a card or Account number stays in any name.
- When an AI provider is set up, the AI cleans only the names the rules cannot fix. The app keeps each answer and reuses it for the same description text. So the AI sees each text once.
- The cleanup rules run when a Transaction arrives, before matching, because Refund links need the Merchant. AI cleanup runs in the categorization step. A stored Transaction gets the rules again only when the provider sends it again as changed; a change to the rules does not rename stored Transactions.

### Identity

- A Merchant is identified by the provider's Merchant ID (Plaid `merchant_entity_id`), else by its clean name.
- Clean names compare without case, spaces, or punctuation.
- Every "same Merchant" in the spec uses this identity: Category rules, Merchant history, Refund links, Recurring charges, Anomalies, and Top Merchants.
- In a payment-app or Zelle line that names a person, that person is the Merchant. When the line names no person, such as `VENMO PAYMENT`, the payment app is the Merchant.
- v1 has no Merchant merge and no Merchant rename.

## The categorization cascade

Each Spending Transaction takes the first answer it gets, in this order:

| Step | Source | It answers when |
|---|---|---|
| 1 | Hand-set | A Member set the Category by hand. |
| 2 | Category rule | A Category rule matches its Merchant. |
| 3 | Provider category | The provider's category maps cleanly to one Category, and Plaid's `confidence_level` is `VERY_HIGH` or `HIGH`. |
| 4 | Merchant history | The Merchant's last 3 Transactions all have the same Category. |
| 5 | Web lookup, then AI | A Web lookup kept for the Merchant answers at once. Otherwise an AI provider is set up and available, and its answer always applies. When the AI is unsure of a Merchant it does not know, a Web lookup may answer in its place. |
| 6 | Best guess | No AI is available. The Transaction takes the best guess so far, or Miscellaneous. |

- **Step 3.** A provider code maps cleanly when the mapping does not flag it lossy ([Provider categories](#provider-categories)).
  - A lossy code always goes on down the cascade, even at `VERY_HIGH`.
  - `UNKNOWN` counts as `LOW`.
  - A provider category with no confidence level is only a hint to the AI.
- **Step 4.** The last 3 Transactions are the 3 most recent Spending Transactions with that Merchant, before this one. A Category from step 6 does not count. With fewer than 3, the step gives no answer.
- **Step 5.** The AI gets the provider's category as a hint. It answers with one of the 30 Categories and a confidence: high, medium, or low.
  - The answer always applies.
  - Below "high", the AI counts as unsure. The Transaction also goes on the Review list.
  - Step 5 starts with the Web lookup's cache ([Web lookup](#web-lookup)). A Category kept for the Merchant decides at once, with no AI call and no search.
- **Step 6.** The best guess is the Category the provider's code maps to, even when lossy or at low confidence. With no provider category, it is the Merchant's most recent Category. With neither, it is Miscellaneous. The Transaction also goes on the Review list.
- The cascade runs after matching ([Money movement](03-money-movement.md#order-of-decisions)). It works through Transactions oldest first, so Merchant history builds in date order.
- An unlinked Refund goes through the cascade as if it were Spending. It takes the Category its Merchant would get.

### Categories that Money movement names

- Some rules in [Money movement](03-money-movement.md) name a Category, such as Cash or Payments to people. That Category takes the place of steps 3 to 6. Steps 1 and 2 still win.
- The parts of a payment on a tracked loan are the exception. They always take the Categories that Money movement gives. Only a hand edit changes them.

### Provenance

- The app stores which step chose each Category, and how confident that step was. A Category from a Web lookup has its own source, "Web lookup", with "Web lookup, unsure" below "high".
- Members' corrections then show how accurate each step is. Developers use this to tune the steps between releases. Nothing tunes itself inside the app.
- The Transactions page shows how each Category was chosen ([Dashboard and pages](07-dashboard-and-pages.md)).

### Re-runs

- When the provider changes a Transaction, the cascade runs again, unless a Member set its Category by hand.
- When a Category rule is made, changed, or deleted, the cascade runs again on that Merchant's Transactions. Hand-set Transactions keep their Category.
- When a pending Transaction posts, its Category carries over ([Money movement](03-money-movement.md#pending-transactions)).

### Web lookup

A Member often looks up an unknown Merchant on the web to learn what it sells. The app does the same when the AI is unsure.

- **When.** The Category fix's answer for each Transaction says whether the Merchant needs a lookup. The AI says yes only when its confidence is below "high" and the line names a business it does not know. A well-known Merchant, such as Whole Foods or Verizon, never needs one.
- **Never looked up:**
  - a payment-app or Zelle line to or from a person, or one that names no one ([Identity](#identity));
  - a Transfer, a loan payment, or a card payment, by the provider's category;
  - a line with no clean Merchant name;
  - a Merchant name in which the privacy filter finds a Member's name or a protected number.
- **The lookup** asks the AI provider's own web search, with the clean Merchant name alone ([AI](08-ai.md#merchant-web-lookup)). It answers with one Category, a confidence, and a one-line description of the business.
- **Outcome.** The lookup's answer takes the place of the AI's, with the source "Web lookup". At "high", it decides. Below "high", it still applies, and the Transaction goes on the Review list, as an unsure AI answer does.
- **Cache.** The app keeps one answer for each Merchant, by the same identity as everywhere else: its Category, confidence, description, the time of the lookup, and whether the lookup found the business. A kept answer decides each later Transaction of that Merchant at step 5. A lookup that found nothing is kept too, and the app looks that Merchant up again only after 90 days. The cache holds facts about Merchants, not about a Connection, so removing a Connection keeps it.
- **Corrections.** A Member's correction of a Web lookup's Category wins and makes a Category rule, as with every other source.
- **The Transaction's page** shows "Category chosen by: Web lookup" and the description of the business.
- **Switch.** Settings, AI has a switch for the Web lookup. It is on whenever AI is on. Off, the app makes no lookup and reads no kept answer.

## Provider categories

- The Plaid adapter requests Plaid's v2 categories by name: `options.personal_finance_category_version` set to `v2`.
- The app maps each Plaid detailed code with the mapping in the [Transaction categorization research](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transaction-categorization/docs/research/transaction-categorization.md), Appendix A. These changes apply to it:

| Plaid code, or the research's label | Category in v1 |
|---|---|
| The research's "Shopping" | General goods |
| The research's "Other" | Miscellaneous. Still lossy. |
| `GENERAL_MERCHANDISE_SUPERSTORES` | Superstores. Clean. |
| `GENERAL_MERCHANDISE_SPORTING_GOODS` | Hobbies |
| `GENERAL_MERCHANDISE_ONLINE_MARKETPLACES` | General goods. Clean. |
| Any `GENERAL_MERCHANDISE_*` code, or `FOOD_AND_DRINK_GROCERIES`, at a Merchant on the Superstores list | Superstores. Clean. |
| `INCOME_*`, `TRANSFER_IN_*`, `TRANSFER_OUT_*`, `LOAN_DISBURSEMENTS_*`, and `LOAN_PAYMENTS_*` | [Money movement](03-money-movement.md) decides. The research's treatment for these codes does not apply. |

- **The Superstores list** ships with the app: Walmart, Target, Costco, Sam's Club, BJ's, Amazon, Dollar General, Dollar Tree, and Family Dollar. Developers change it between releases.
- **Confidence on real data.** On the owner's Accounts, Plaid sent a category on 100% of Transactions. It sent a high-confidence one on 75% to 94%, depending on the Account. The rest go on down the cascade.
- **MCC.** The Plaid adapter gives no MCC. When a later adapter gives one, the MCC is a hint to the AI only. It is never a cascade step.

## Category rules

- When a Member changes a Transaction's Category, the app makes a Category rule for that Merchant. The changed Transaction itself counts as hand-set.
- The rule covers the Merchant's past and future Transactions, except those a Member set by hand.
- The Member may pick "only this Transaction" instead. Then the app makes no rule.
- Accepting a guess on the Review list also makes a Category rule.
- A rule stores the Merchant ID and the clean name. It matches a Transaction with the same Merchant ID. When the rule or the Transaction has no Merchant ID, it matches by clean name.
- Each Merchant has at most one rule. A newer correction replaces the older rule.
- A rule sets only the Category. It never changes a Transaction's type.
- A person can have a rule when the bank shows the person's name, as Zelle lines do. A correction on a line with no name, such as `VENMO PAYMENT`, changes only that Transaction.
- A correction on a Transaction with no Merchant, such as a paper check, changes only that Transaction.
- A split part makes no Category rule.
- Giving a Category to a Transfer, Income, or Saving also sets its type to Spending by hand.
- Settings lists every Category rule, with Delete. Deleting a rule runs the cascade again on that Merchant's Transactions not set by hand.

## Splits

- Each Transaction gets one Category. A Member may split one Spending Transaction by amount across Categories. This is optional.
- The parts add up to the Transaction's amount.
- Each part counts in its own Category, and all parts count in the Transaction's month.
- A split part makes no Category rule.
- A Refund reduces the parts in proportion to their amounts. A Reimbursement does the same.
  - Example: a $120 Target purchase is split into $80 Groceries and $40 Clothing. A $30 Refund reduces Groceries by $20 and Clothing by $10.
- The cascade never changes a split. When a Member removes the split, the Transaction goes back to the cascade.
- When the provider changes a split Transaction's amount, the app scales each part in proportion.

## Which month a Transaction counts in

- A Transaction's month comes from its purchase date (Plaid `authorized_date`) when present. Otherwise it comes from its posted date (Plaid `date`).
  - Example: a dinner on Oct 31 that posts Nov 2 counts in October.
- This rule applies everywhere: Budgets, Overspending, the dashboard, Goals, and the Monthly review.
- Dates are the calendar dates the bank gives. The app does not shift them by time zone.
- A linked Refund or Reimbursement counts in the month of the Spending it reduces ([Money movement](03-money-movement.md#which-month-a-link-changes)).
- Transfer windows use posted dates ([Money movement](03-money-movement.md#windows)).
- Totals use posted Transactions only, as Alerts do. A pending Transaction shows in lists, marked "pending". It counts once it posts.

## AI decisions

- The AI decides three things in this file:
  - a Category, at step 5 of the cascade;
  - a Merchant name that the cleanup rules cannot fix;
  - a Category from a Web lookup, when it was unsure of a Merchant it does not know ([Web lookup](#web-lookup)).
- The app always applies the AI's Category. Below "high" confidence, the Transaction also goes on the Review list.
- The app uses the AI's Merchant name as the clean name.
- Without AI, the cascade stops at step 6, and the rule-cleaned name stays. The app marks these items. When AI is available again, the app sends each marked item to the AI once ([Money movement](03-money-movement.md#ai-decisions-and-the-no-ai-path)).
- Prompts, batches, models, and cost are in [AI](08-ai.md).

## Review list items

The Review list is optional. Each Category below already counts, so nothing waits for a Member. The page is in [Dashboard and pages](07-dashboard-and-pages.md).

| Item | Why it is there | What a Member's answer does |
|---|---|---|
| A Category the AI or a Web lookup chose with confidence below "high" | The AI was unsure | Accepting makes a Category rule. Picking another Category is a correction, and makes a rule unless the Member picks "only this Transaction". |
| A best guess made without AI | No AI was available | Same as above |

- When a later AI answer has high confidence, its item leaves the Review list.

## Sources

- [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14)
- [Hands-off Transfer, Refund, and Reimbursement detection](https://github.com/therecluse26/family-finance-tracker-private/issues/13)
- [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2)
- [Prior art: Transfer matching and categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/7)
- [Compare Plaid's Trial plan and SimpleFIN Bridge on real Accounts](https://github.com/therecluse26/family-finance-tracker-private/issues/10)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [Assemble the v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/24)
- Research: [Transaction categorization](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transaction-categorization/docs/research/transaction-categorization.md) (branch `research/transaction-categorization`)
