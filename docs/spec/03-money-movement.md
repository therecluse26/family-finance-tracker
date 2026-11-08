# Money movement

The app decides by itself what each Transaction is: Spending, Income, a Transfer, Saving, a Refund, or a Reimbursement. Only Spending counts against Budgets, and a Transfer never counts as Spending or Income. A link between Transactions applies at once only when it has a strong signal. Anything less goes to the AI or to the Review list, and nothing waits for a Member.

## Transaction types

| Type | What it is | What it counts in |
|---|---|---|
| Spending | Money that leaves the Household for goods or services | Spending, in one Category |
| Income | Money that enters the Household from outside | Income |
| Transfer | Money between two of the Household's own Accounts, Unconnected accounts, or loans | Nothing |
| Saving | Money into an investment or retirement account | Saving |
| Refund | Money a Merchant gives back for a purchase | Reduces Spending in the purchase's Category |
| Reimbursement | Money a person outside the Household pays back for shared Spending | Reduces that Spending |

- Each Transaction has one type. In some cases the app divides a Transaction into parts instead. Each part has one type and, for Spending, one Category. The parts add up to the Transaction's amount.
- Parts come from three places: a loan payment ([Loans](#loans)), a Refund or Reimbursement larger than its Spending ([Link shapes](#link-shapes)), and a Member's split ([Splits](04-categorization.md#splits)).
- Saving for a month is the money moved in, minus the money taken back out. It may be negative.
- Transfers, Income, and Saving have no Category. A Refund or Reimbursement takes the Category of the Spending it reduces.
- A Member may set the type by hand: Spending, Transfer, Income, or Saving. A hand-set type wins over every rule in this file and survives every re-run. The control is on the Transactions page ([Dashboard and pages](07-dashboard-and-pages.md)).
- An Account that a Member excludes counts as an Unconnected account in this file. Money to or from it is a Transfer ([Accounts and bank sync](02-accounts-and-bank-sync.md)).

## Treatment table

| Money movement | Type | Category | Rule |
|---|---|---|---|
| Paycheck, interest earned, or a government tax refund | Income | — | [Income](#income) |
| Card rewards paid to a card | Income | — | [Card rewards](#card-rewards) |
| Checking to savings, both connected | Transfer | — | [Transfers](#transfers) |
| Card payment to a card the app tracks, even with a broken Connection. The card's purchases are the Spending. | Transfer | — | [Transfers](#transfers), [One side missing](#one-side-missing) |
| Card payment to a card the app does not track | Spending | Miscellaneous | [One side missing](#one-side-missing) |
| A payment on a tracked card that no connected Account sent | Transfer from an Unconnected account | — | [One side missing](#one-side-missing) |
| Money to an HSA, savings, or "other" Unconnected account, such as Pinecrest | Transfer | — | [Unconnected accounts](#unconnected-accounts) |
| Money to a brokerage or retirement account | Saving | — | [Saving](#saving) |
| Money from a brokerage or retirement account into checking | Saving, reduced | — | [Saving](#saving) |
| A one-sided Transfer that names no Unconnected account | Transfer, on the Review list | — | [Unconnected accounts](#unconnected-accounts) |
| Zelle to or from a Member's own name | Transfer | — | [Payment apps](#payment-apps) |
| Zelle, Venmo (`VENMO PAYMENT`), Cash App, or PayPal payment to a person | Spending | Payments to people | [Payment apps](#payment-apps) |
| Money added to Venmo (`VENMO ADDFUNDS`) or PayPal | Spending | Payments to people | [Payment apps](#payment-apps) |
| Money from a person or a payment app (`VENMO CASHOUT`, Zelle from someone outside the Household) | Reimbursement when linked, else Income | The linked Spending's Category | [Reimbursements](#reimbursements) |
| Cash withdrawal at an ATM or a teller | Spending | Cash | [Cash](#cash) |
| Cash back at a checkout, on its own line | Spending | Cash | [Cash](#cash) |
| Refund from a Merchant | Refund | The purchase's Category; unlinked, the Merchant's Category | [Refunds](#refunds) |
| Loan payout into a Household Account | Transfer from the loan | — | [Loan payouts](#loan-payouts) |
| Interest in any loan payment | Spending | Interest and fees | [Loans](#loans) |
| Principal on a Cash loan | Transfer | — | [Loans](#loans) |
| Principal on a Purchase loan | Spending | The loan's Category | [Loans](#loans) |
| Escrow in a Manual loan mortgage payment | Spending | Housing | [Loans](#loans) |
| Payment on an untracked loan whose payout the app saw | Transfer, on the Review list | — | [Untracked loans](#untracked-loans) |
| Payment on an untracked loan with no payout seen | Spending | The loan type's Category | [Untracked loans](#untracked-loans) |
| Card interest, card fees, and bank fees | Spending | Interest and fees | [Categorization](04-categorization.md#what-goes-where) |
| Money to or from an excluded Account | Transfer | — | [Transaction types](#transaction-types) |

## Order of decisions

The app decides each Transaction in this order. The first step that fits wins.

1. A type a Member set by hand.
2. A link a Member made by hand.
3. Transfer pairing between two Household Accounts ([Transfers](#transfers)). Card rewards never enter it.
4. A link to a Manual loan ([Loans](#loans)).
5. For money out:
   1. A card payment with no pair ([One side missing](#one-side-missing)).
   2. A loan payment with no pair ([Untracked loans](#untracked-loans)).
   3. A cash withdrawal ([Cash](#cash)).
   4. Zelle to a Member's own name: a one-sided Transfer ([Payment apps](#payment-apps)).
   5. A payment to a person ([Payment apps](#payment-apps)).
   6. Transfer wording or a Plaid transfer category: a one-sided Transfer or Saving ([Unconnected accounts](#unconnected-accounts), [Saving](#saving)).
   7. Anything else is Spending. The [categorization cascade](04-categorization.md#the-categorization-cascade) picks its Category.
6. For money in:
   1. Card rewards ([Card rewards](#card-rewards)).
   2. A loan payout ([Loan payouts](#loan-payouts)).
   3. Zelle from a Member's own name: a one-sided Transfer ([Payment apps](#payment-apps)).
   4. A Refund link ([Refunds](#refunds)).
   5. Money from a person ([Reimbursements](#reimbursements)).
   6. A payment on a card with no pair ([One side missing](#one-side-missing)).
   7. Transfer wording or a Plaid transfer category: a one-sided Transfer, or reduced Saving ([Unconnected accounts](#unconnected-accounts), [Saving](#saving)).
   8. A Merchant with a Spending category: an unlinked Refund ([Refunds](#refunds)).
   9. Anything else is Income ([Income](#income)).

- One-sided results are provisional until the longest window that could apply has passed ([Transfers](#transfers)). A pair found inside the window replaces them.
- When a sync adds or changes Transactions, the app runs this order again. It skips Transactions set by hand.

## Links

A link ties Transactions together. There are four kinds:

- a Transfer pair;
- a Refund and its purchase;
- a Reimbursement and its Spending;
- a loan and its payment or payout.

### Tiers

| Tier | Test | Result |
|---|---|---|
| Strong | Passes every hard filter and has at least one strong signal | Applies at once |
| Unclear | Passes every hard filter but has no strong signal | The AI decides. Without AI, the Review list. |

- A candidate that fails a hard filter is never linked.
- The AI answers yes or no, with high, medium, or low confidence. It runs on the Quick tier ([AI](08-ai.md)).
  - "Yes" with high confidence: the link applies.
  - "No" with high confidence: no link, and no Review list item.
  - Any answer below high: no link. The candidate goes on the Review list.
- The app never asks the AI about the same candidate twice.
- Without the link, each Transaction follows the other steps in [Order of decisions](#order-of-decisions).
- A Refund link has no Unclear tier. It applies when its hard filters pass ([Refunds](#refunds)).
- A Reimbursement link is always the AI's decision or a Member's ([Reimbursements](#reimbursements)).
- There is no tuning inside the app. A Member's correction fixes that one item only. Developers tune the filters and signals between releases.

### Evidence

- For each link, the app stores:
  - the tier;
  - each strong signal that matched;
  - the AI's answer and confidence, when it asked;
  - who made the link: the app, the AI, or a Member.
- The Transactions page shows this evidence, with Undo ([Dashboard and pages](07-dashboard-and-pages.md)).

### Undo and hand links

- A Member can undo any link. After an undo, the app never makes that same link again.
- After an undo, the app matches both Transactions again without that pair. If nothing else matches, the one-sided rules apply.
- A Member can link Transactions by hand, from the Review list or the Transactions page. Re-matching never breaks a hand-made link.
- When Link again or a new link of a removed bank hides a Transaction as `replaced by re-link`, its hand-made links move to its new copy ([Carrying Accounts over](02-accounts-and-bank-sync.md#carrying-accounts-over)).
- When the provider removes a Transaction, every link that used it ends. The other Transactions go through matching again ([Accounts and bank sync](02-accounts-and-bank-sync.md)).
- When the provider changes a linked Transaction, the link stays if it still passes its hard filters. Otherwise the link ends, and matching runs again.

## Transfers

Transfer matching needs no AI provider. It pairs two Transactions on two of the Household's Accounts.

### Hard filters

All four must pass:

- The two Transactions are on two different Accounts of the Household.
- One takes money out, and the other brings money in.
- The amounts are the same to the cent.
- Both posted dates (Plaid `date`) are inside the route's window.

### Strong signals

At least one must be present, because an equal amount and a close date are never enough:

- The other Account's last 4 digits in the description.
- The other institution's name in the description, or in a `counterparties[]` entry of type `financial_institution`.
- Plaid's transfer, credit card payment, or loan payment category on either Transaction.
- An earlier Transfer between the same 2 Accounts.

The app does not rely on `authorized_date`, `transaction_code`, or `counterparties[].account_numbers` for matching. The research found them mostly empty for US data.

### Windows

Windows count business days on the Federal Reserve calendar. Either side may post first.

| Route | Window |
|---|---|
| Within one bank | 1 business day |
| Card payment from another bank | 4 business days |
| Transfer between two banks | 5 business days |
| Payment to a connected loan, such as Larkspur | 5 business days |

### Global pairing

- The app compares all candidate pairs at once, with minimum-cost matching (`munkres`). It never pairs first come, first served.
- Each Transaction joins at most one pair.
- The app picks the set of pairs that has, in this order:
  1. the most Strong pairs;
  2. then the most pairs;
  3. then the most strong signals;
  4. then the smallest total date gap.
- An Unclear pair in the chosen set goes to the AI ([Tiers](#tiers)). When the AI rejects it, pairing runs again without it.
- Two sets may still tie when they use only the Household's own Accounts. Either choice gives the same Spending. The app picks one, marks it uncertain, and puts it on the Review list.

### One side missing

These rules apply to a Transaction with no pair. A pair found later inside the route's window replaces them.

- **A card shows a payment, but no connected Account sent it.** This is a Transfer from an Unconnected account. [Unconnected accounts](#unconnected-accounts) decides which one.
- **A connected Account pays a card the app does not track.** This is Spending in Miscellaneous. The app first waits 4 business days for a pair. Until then, the payment counts as a Transfer.
  - A card payment is an outgoing Transaction with Plaid's `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT` category.
  - The card is tracked when a card Account matches the last 4 digits in the description. With no last 4 digits, a card Account at the named institution makes it tracked.
  - A run of 4 digits counts as a card's last 4 digits only right after a card word: "ending" (or "ending in"), "card", a run of the letter x that is not part of a longer word (such as `x` or `XXXX`), or `*`. Only spaces and punctuation may stand between. Examples: "Chase card ending in 4821", `XXXX4821`, `*4821`. A store number or a year, as in "PURCHASE 1005 BLUEBIRD BOOKS", is not a last 4.
  - A card Closed because its Connection was removed stays tracked for 90 days after the removal. A payment dated later is a payment to a card the app does not track.
  - A card whose Connection is broken still counts as tracked. Its payment is a Transfer to that card.
- **Any other one-sided Transaction with transfer wording or a Plaid transfer category.** This is a Transfer to or from an Unconnected account, or Saving ([Unconnected accounts](#unconnected-accounts)).
  - Transfer wording: the description holds "transfer" or "xfer", in any case.
  - A Plaid transfer category: any `TRANSFER_IN_*` or `TRANSFER_OUT_*` code. Codes that an earlier step claims, such as `TRANSFER_OUT_WITHDRAWAL`, never reach this rule.

### Unconnected accounts

The app ties each one-sided Transfer to one Unconnected account. The first case that fits wins:

| Case | Result | Review list |
|---|---|---|
| The description holds an Unconnected account's institution name or last 4 digits | That account | No |
| No match, and a Member answered a one-sided Transfer card with the same key ([Review list items](#review-list-items)) | The remembered answer: its account, a Transfer with no account, or Spending | No |
| No match, and Plaid files it under `TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS`, `TRANSFER_OUT_CRYPTO`, or `TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS` | Saving, with no account ([Saving](#saving)) | No |
| No match, and the Household has exactly one Unconnected account | That account | Yes, to confirm |
| No match, with no Unconnected account or several | A Transfer with no account | Yes: "Which account is this?" |

- The account's kind decides the type. Kind "investment or retirement" makes it Saving. Kinds "savings", "HSA", and "other" make it a Transfer.
- On the Review list, a Member may pick an account, add one, keep it as a Transfer, or choose "Not a Transfer". The answer covers the whole card and is remembered for its key ([Review list items](#review-list-items)). A remembered "Not a Transfer" makes the Transaction Spending, and the cascade picks its Category.
- Goal progress for an Unconnected account uses these assignments ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).
- A loan is never an Unconnected account. Neither is a payment app.

## Payment apps

Venmo and PayPal stay unconnected by default. Cash App cannot connect through Plaid. The app reads the payment-app lines in the Household's bank and card data.

| Bank line | Treatment |
|---|---|
| `VENMO PAYMENT` | Spending in Payments to people |
| `VENMO ADDFUNDS` | Spending in Payments to people. The app cannot see the Venmo balance, and money added there is usually paid to people. |
| `VENMO CASHOUT` | Money from a person: a Reimbursement candidate. With no link, Income. |
| Money added to a PayPal balance | Spending in Payments to people |
| A Zelle, Cash App, or PayPal payment to a person | Spending in Payments to people |
| Zelle from a person outside the Household | Money from a person ([Reimbursements](#reimbursements)) |
| Zelle to or from a Member's own name | Transfer |

- A payment-app line has one of these: a `counterparties[]` entry of type `payment_app`; Plaid's `TRANSFER_OUT_TRANSFER_OUT_FROM_APPS` or `TRANSFER_IN_TRANSFER_IN_FROM_APPS`; or "Venmo", "PayPal", "Cash App", or "Zelle" in the description.
- A payment-app line that names another Merchant, such as a PayPal purchase at a store, is an ordinary purchase. The cascade picks its Category.
- A Zelle line names a Member when it holds that Member's first and last name, in any case. It is a one-sided Transfer unless it pairs with another Household Account. [Unconnected accounts](#unconnected-accounts) assigns it.
- "Payments to people" applies only after Transfer matching decides that the money left the Household.
- A hand-set Category or a Category rule for the person can replace "Payments to people". An example is a babysitter in Childcare ([Category rules](04-categorization.md#category-rules)).
- A payment app is never an Unconnected account, so money added to it is never a Transfer.
- When a Household connects Venmo or PayPal as an Account, the general rules apply. Money added to it pairs as a Transfer, and its payments to people are Spending.

## Cash

- A cash withdrawal at an ATM or a teller is Spending in Cash, on the day of the withdrawal. Plaid files it under `TRANSFER_OUT_WITHDRAWAL`.
- Cash back at a checkout is Spending in Cash when the bank shows it as its own Transaction. When the bank shows one line for the purchase and the cash, the whole line takes the purchase's Category.
- "Cash back" means only cash taken at a checkout. Card rewards are never called cash back.

## Card rewards

- Card rewards are Income. They never enter Transfer matching.
- An incoming Transaction on a credit card is card rewards when its description holds "reward" or "redemption". Case does not matter. Examples: `CREDIT-CASH BACK REWARD` (Capital One) and `REDEMPTION CREDIT` (Chase).

## Saving

- Money out is Saving in two cases:
  - It goes to an Unconnected account of kind "investment or retirement".
  - It matches no Unconnected account, and Plaid files it under `TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS` or `TRANSFER_OUT_CRYPTO`.
- Money in from such an account reduces Saving for the month it arrives. So does money in under Plaid's `TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS`. It is never Income.
- Money to an HSA is a Transfer, not Saving.

## Income

- Money in that no other rule claims is Income. Examples: a paycheck, interest earned, and a government tax refund.
- A government tax refund is Income, not a Refund.
- These are never Income: a Transfer, a loan payout, a Refund, a Reimbursement, and money from an investment or retirement account.

## Refunds

Plaid has no Refund category. A Refund is incoming money that keeps the purchase's Merchant.

- **Link.** The app links a Refund to the latest earlier purchase that passes these hard filters:
  - on the same Account;
  - from the same Merchant ([Merchants](04-categorization.md#merchants));
  - within 120 days before the Refund;
  - with some amount left to reduce.
- A link applies at once. It needs no AI.
- Partial Refunds count.
- **Unlinked Refund.** Some incoming money is a Refund with no link. It has a Merchant, and its provider category maps to a Spending Category. It reduces Spending in its Merchant's Category, in the month it arrives. The cascade picks that Category as it does for Spending.
- A Refund on a split purchase reduces the parts in proportion ([Splits](04-categorization.md#splits)).

## Reimbursements

- **Money from a person** is incoming money with one of these:
  - a payment-app line, Zelle included, that does not name a Member ([Payment apps](#payment-apps));
  - Plaid's `TRANSFER_IN_DEPOSIT` (cash or a check paid into an Account).
- **Only the AI or a Member links a Reimbursement.** The AI compares the money with the Household's Spending from the 60 days before it arrived. It names one Spending or none, with high, medium, or low confidence.
  - "Yes" with high confidence: the link applies.
  - Anything else: no link.
- **No link:** the money is Income, and it goes on the Review list. The item shows the AI's pick, if it made one. A Member can link it from there.
- With no AI, the app links no Reimbursements itself. The money is Income and goes on the Review list.
- A Reimbursement takes the linked Spending's Category.

## Link shapes

- Refunds and Reimbursements link many-to-one. Several may reduce one Spending, such as three friends who each pay back one dinner.
- Each Refund or Reimbursement links to at most one Spending.
- A link reduces the Spending only down to $0.
- The rest of a Reimbursement counts as Income.
- The rest of a Refund stays unlinked and follows the unlinked Refund rule.
- No Category's month goes below $0. When unlinked Refunds would take it lower, the month shows $0, and the rest counts nowhere.

## Which month a link changes

- A linked Refund or Reimbursement reduces the Spending in that Spending's month. So a past month can change when one arrives.
- Monthly reviews and Alerts that were already sent stay as they were.
- Every other Transaction counts in its own month ([Which month a Transaction counts in](04-categorization.md#which-month-a-transaction-counts-in)).

## Loans

One rule covers every loan: connected, Manual, or not tracked. Interest is Spending in Interest and fees. The rest of the payment depends on where the borrowed money went.

### Payments on a tracked loan

A payment on a connected loan or a Manual loan divides into parts:

| Part | Type | Category |
|---|---|---|
| Interest | Spending | Interest and fees |
| Principal on a Cash loan | Transfer | — |
| Principal on a Purchase loan | Spending | The loan's Category |
| Escrow, on a Manual loan mortgage only | Spending | Housing |

- The app works out the interest for each payment as [Accounts and bank sync](02-accounts-and-bank-sync.md) describes. The principal is the payment minus interest and escrow.
- The parts go on the paying Account's Transaction. The loan's own Transaction is the other side of a Transfer pair and counts nowhere. When the app sees no paying Account, the parts go on the loan's own Transaction.
- Each Category comes from this table, not from the cascade. A Member may still change a part by hand.
- Whether a loan is a Cash loan or a Purchase loan is set in [Accounts and bank sync](02-accounts-and-bank-sync.md). A Cash loan's money landed in a Household Account, such as a Larkspur loan. A Purchase loan's lender paid the seller directly, such as a car loan or a mortgage.
- Payments to a connected loan pair as Transfers, in the 5-business-day window.
- Payments to a Manual loan link as [Accounts and bank sync](02-accounts-and-bank-sync.md) describes. They use the same tiers as every other link ([Tiers](#tiers)).

The loan's Category comes from its loan type:

| Loan type | Category |
|---|---|
| Mortgage | Housing |
| Car | Car |
| Student | Books and education |
| Buy now pay later, such as Affirm or Klarna | General goods |
| Personal, or any other | Miscellaneous |

### Loan payouts

- A loan payout is never Income. It is a Transfer from the loan.
- A payout is incoming money under a Plaid `LOAN_DISBURSEMENTS_*` code. The other side of a pair with a loan Account is also a payout.
- When a Member adds a Cash loan, the app looks for its payout. It links the payout as a Transfer from the loan.

### Untracked loans

An untracked loan payment is an outgoing Transaction with a `LOAN_PAYMENTS_*` code, except `LOAN_PAYMENTS_CREDIT_CARD_PAYMENT`. It pairs with no Account and links to no Manual loan. The app cannot split its interest from its principal, so the whole payment counts one way:

- **The app saw that lender's payout land in a connected Account.** The loan is a Cash loan, and each payment is a Transfer. The Review list offers to add it as a Manual loan, so that its interest can show. The payout and the payment match when they have the same Merchant.
- **Otherwise,** the app treats it as a Purchase loan. The whole payment is Spending in the loan type's Category:

| Plaid code | Category |
|---|---|
| `LOAN_PAYMENTS_MORTGAGE_PAYMENT` | Housing |
| `LOAN_PAYMENTS_CAR_PAYMENT` | Car |
| `LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT` | Books and education |
| `LOAN_PAYMENTS_BNPL` | General goods |
| Any other `LOAN_PAYMENTS_*` code | Miscellaneous |

A hand-set Category or a Category rule for the lender may replace that Category.

## Pending Transactions

- The app links pending Transactions at once.
- When Plaid posts a pending Transaction, it removes the pending record. It adds a new posted record that points back through `pending_transaction_id`.
- Links and Categories carry over to the posted record.
- A posted record with no `pending_transaction_id` goes through matching again.
- A carried-over link that no longer passes its hard filters ends, and matching runs again. A tip that changes a restaurant amount is an example.
- Totals count posted Transactions only ([Categorization](04-categorization.md#which-month-a-transaction-counts-in)).

## AI decisions and the no-AI path

The AI decides two things in this file:

- An Unclear link: a Transfer pair, or a payment to a Manual loan.
- A Reimbursement link.

The app uses only answers with high confidence, as [Tiers](#tiers) and [Reimbursements](#reimbursements) say. Prompts, batches, and cost are in [AI](08-ai.md).

The app takes a no-AI path in four cases: no AI provider is set up; the AI cost cap is reached; the AI fails after its retries; or AI waits for a Connection's history to load ([Accounts and bank sync](02-accounts-and-bank-sync.md)).

- **Redo no-AI work.** The app marks every item that a no-AI path decided.
- When AI is back, each marked item goes through the AI once, unless a Member set it by hand.
- That run counts against the AI cost cap.
- When the AI's later answer applies, the item leaves the Review list.
- The same rule covers Categories and Merchant cleanup ([Categorization](04-categorization.md#ai-decisions)).

## Review list items

The Review list is optional. Each item below already has a result that counts, so nothing waits for it. The page is in [Dashboard and pages](07-dashboard-and-pages.md).

| Item | Why it is there | What a Member's answer does |
|---|---|---|
| An Unclear Transfer pair, with no AI or an AI answer below high | Nothing is linked, so both sides follow the one-sided rules | Accepting makes a hand-made link. "Not this" acts as an undo. |
| A pair picked from two equally good choices | The choice is a guess | Same as above |
| A one-sided Transfer not tied to an Unconnected account by its name or last 4 digits | It may be Spending, such as rent paid by transfer | Picks or adds an Unconnected account, keeps it as a Transfer, or makes it Spending. The answer is remembered for its key. |
| Money from a person with no link | It counts as Income | Links it to Spending as a Reimbursement, or keeps it as Income |
| An untracked loan whose payout the app saw | Its interest cannot show | Opens the Manual loan form ([Accounts and bank sync](02-accounts-and-bank-sync.md)) |

- **One-sided Transfer cards.** One open item per key holds every one-sided Transfer that asks, as Category cards do ([Categorization](04-categorization.md#review-list-items)).
  - The key is the line's name by the cleanup rules alone, compared by [Identity](04-categorization.md#identity), with the last 4 digits of each account number the line holds. The app finds an account number as Merchant cleanup does: after a lead-in such as "ACCT" or "ENDING IN", or after a mask such as `XXXX`. It reads the line in plain forms first: every digit script counts as 0 to 9, format characters go, and a short run of other characters is a gap. So `ONLINE TRANSFER TO SAV XXXX5678` and `ONLINE TRANSFER TO SAV XXXX9012` are two cards.
  - The key never uses the stored clean name, which AI cleanup rewrites after Matching has decided. It reads only what the provider sent, so it is the same when Matching decides, when a Member answers, and when a later Transaction looks the answer up. A word that holds a digit, such as a reference code or a date, leaves the name, so `ONLINE TRANSFER REF #IB0QQ7XWZ4 TO PINECREST SAVINGS XXXXXX4821` lines with different codes share a card.
  - A line with no name by the rules keeps an item of its own, and its answer is not remembered.
  - The card reads like "Online Transfer To Sav · 14 Transactions". Its best answer is the newest Transaction's.
  - The answer covers every Transaction still on the card: still shown, still one-sided, with no type or account set by hand. A Transaction on the card whose key changed since, such as after a provider change, goes back through the follow-up job and asks on its own key's card. Each row has "Change", which sets that Transaction's type by hand alone, and it leaves the card.
  - **Remembered answers.** The answer is kept for the key: the account picked, "Keep it as a Transfer", or "Not a Transfer". Each later one-sided Transfer with that key takes it, with no Review list item. It never beats a hand-set type, an account a Member picked for that Transaction, or an account the line names, and it never ends a link.
  - Settings → Categories lists the remembered answers, with Delete ([Dashboard and pages](07-dashboard-and-pages.md#settings-overview)). Deleting one sends the Transactions it decided back through the follow-up job, so they ask again. When its account is deleted, the answer goes too.
  - The digits stay in the app. The key and the remembered answers never go to the AI.
- **Money from a person cards.** One open item per person on one payment app holds that person's money with no link. The key is the app with the person's name as a letter-only, case-folded skeleton, so "JOHN SMITH" and "John  Smith" are one card. A line that names no person, such as `VENMO CASHOUT` or a check deposit, keeps an item of its own.
  - The card reads like "Taylor Brooks · Zelle · 3 Transactions": the person's name as the line gives it, with the app. It never shows a line itself, which can hold a reference code such as `Conf# 7f3k2`.
  - A card of one Transaction works as before: its best answer is the AI's pick, and "Not this" offers Keep as Income and each Spending it may pay back.
  - A card of more has "Keep all as Income", which sets each one still on the card to Income by hand. A row opens its Transaction, where a Member links it as a Reimbursement.
  - The answer is not remembered: later money from the same person may pay back Spending, so the AI still gets to pick for it.
- **Transfer pair guesses** group on the page by their two Accounts, for display only. Each pair keeps its own answer, since it is about two given Transactions, and nothing is remembered.
- **Items from before cards.** The first Matching run after the update groups the open items: the earlier items of one key close as "grouped", and one card holds their Transactions. Running it again changes nothing.

Manual loan items, such as "Link to this loan?" and a missed payment, are in [Accounts and bank sync](02-accounts-and-bank-sync.md).

## Sources

- [Scope and product principles](https://github.com/therecluse26/family-finance-tracker-private/issues/2)
- [Hands-off Transfer, Refund, and Reimbursement detection](https://github.com/therecluse26/family-finance-tracker-private/issues/13)
- [Manually tracked debts](https://github.com/therecluse26/family-finance-tracker-private/issues/18)
- [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14)
- [Prior art: Transfer matching and categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/7)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [Assemble the v1 spec](https://github.com/therecluse26/family-finance-tracker-private/issues/24)
- Research: [Transfer detection](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transfer-detection/docs/research/transfer-detection.md) (branch `research/transfer-detection`)
- Research: [Transfer matching prior art](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transfer-matching-prior-art/docs/research/transfer-matching-prior-art.md)
