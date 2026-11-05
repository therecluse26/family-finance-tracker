# Anomalies and Alerts

The app finds Recurring charges and four Anomalies, and it watches each Budget for Overspending. Checks run after each sync, on posted Transactions only, so Alerts arrive 1 to 3 days after a purchase. A template states every fact in an Alert; the AI may add advice. A weekly cap of 3 keeps Alerts rare, except for money the Household can get back.

## Recurring charges

A Recurring charge is Spending with one Merchant that repeats at a steady interval and a similar amount.

### Finding a series

- A Recurring charge is 3 or more Spending Transactions from one Merchant on one schedule. Their amounts are within 7.5% of each other.
- "Within 7.5% of each other" means the largest amount is at most the smallest amount × 1.075.
- Each Transaction must land within the schedule's margin, measured from the previous Transaction in the series:

| Schedule | Interval | Margin |
|---|---|---|
| Weekly | 7 days | ±2 days |
| Every 2 weeks | 14 days | ±2 days |
| Monthly | The same day of the next month. A day the month lacks means its last day. | ±2 days |
| Yearly | 12 months | 11 to 13 months after the previous one |

- **Yearly** needs only 2 Transactions, 11 to 13 months apart, with amounts within 15% of each other.
- Transfers never count. Only Spending counts. Income series use a variant of this rule ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md#steady-income)).
- A Merchant is identified as [Categorization](04-categorization.md) says: the provider's Merchant ID, else the clean name.
- One Merchant may have more than one Recurring charge, at different amounts.
- A weekly, 2-week, or monthly series with only 2 Transactions is not a Recurring charge. It fires only the New Recurring charge Anomaly. That catches a forgotten free trial a month earlier.
- Only Recurring charges count in "Coming up", the [projection](#the-projection), the Recurring charges page, and the Budget formulas.

Source: this follows Sure and Actual, plus the weekly, 2-week, and yearly schedules, from [Prior art: Transfer matching and categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/7).

### Continuing a series

- The next expected date is the last Transaction's date plus one interval.
- Once a Recurring charge exists, a Transaction from that Merchant continues it at any amount. It must land within the margin of the next expected date. The 7.5% band applies only to finding a new series. So a Price increase above 7.5% still continues the series.
- If two Transactions fit, the one nearest the latest amount continues the series.
- The latest amount is the amount of the last Transaction in the series.

### Inactive and ended

- A Recurring charge goes inactive after one missed Transaction. It is missed when the next expected date plus 2 days passes with none. A yearly one is missed 13 months after its last Transaction.
- An inactive Recurring charge leaves "Coming up", the projection, and the Budget formulas' known amounts.
- A later Transaction can make it active again. It must come from the same Merchant, within 7.5% of the latest amount. Its date must be within the margin of the last date plus a whole number of intervals. This fires no New Recurring charge Alert.
- A Member may mark a Recurring charge ended. An ended one never comes back by itself. Later Transactions from that Merchant start a new series.

### What the app stores

Each Recurring charge holds:

- the Merchant and the Category;
- the schedule and the next expected date;
- the latest amount, and the price history: each Transaction's date and amount;
- the Account it last landed on;
- its status: active, inactive, or ended.

The page that lists them is in [Dashboard and pages](07-dashboard-and-pages.md#recurring-charges-page).

## When checks run

- Checks run in the follow-up job after each sync, after matching and categorization ([Accounts and bank sync](02-accounts-and-bank-sync.md#after-a-sync)).
- Checks use posted Transactions only. Pending amounts change: a $175 gas hold can post as $43. Capital One sends no pending data.
- **Found in history:** an Anomaly found in a Connection's history load is stored and marked "found in history". It is never sent and never counts against the cap. This holds for a bank added later too.
- Recurring charges found in a history load are Recurring charges at once.
- Overspending checks start after the first Budget draft.
- A Transaction fires each Anomaly at most once, even when the provider changes it later.
- Fraud detection stays the bank's job.

## Anomalies

An Anomaly is a Transaction, or a series of Transactions, that is unusual against the Household's own history.

| Anomaly | Fires when | Never fires for | The Alert says | Sent |
|---|---|---|---|---|
| **Duplicate charge** | Two posted Spending Transactions have the same Account, the same Merchant, and the same amount to the cent. Their purchase dates are 0 to 2 days apart. | A frequent purchase at that amount. | "Possible duplicate charge: {amount} at {Merchant} on {Account}, on {date 1} and {date 2}." Example: "Possible duplicate charge: $42.50 at Shell on Chase Sapphire, on Oct 3 and Oct 4." | Always, outside the weekly cap |
| **Price increase** | A Transaction continues a Recurring charge. It is more than 5% and more than $1 above the base price. | A drop. A rise of 5% or less, or of $1 or less. | "{Merchant} went up from {base} to {amount} (+{difference}, +{percent}%) on {date}." Example: "Netflix went up from $15.49 to $17.99 (+$2.50, +16%) on Oct 3." | Within the cap, priority 2 |
| **New Recurring charge** | A posted Transaction and exactly one earlier Transaction from the same Merchant fit a weekly, 2-week, or monthly schedule. Their amounts are within 7.5% of each other. | The yearly schedule. A Transaction that continues or revives a Recurring charge. A Merchant and amount marked known. A frequent purchase. | "New Recurring charge? {Merchant}, {amount} on {date 1} and {date 2}. Next expected {next date}." Example: "New Recurring charge? Hulu, $9.99 on Sep 3 and Oct 3. Next expected Nov 3." | Within the cap, priority 3 |
| **Large purchase** | One posted Spending Transaction of at least $250. It is larger than 98% of the Household's purchases in the 12 months before it. | Recurring charges. Spending in the Bills group. Loan payments. Transfers. | "Large purchase: {amount} at {Merchant} on {date}. It is larger than 98% of your purchases in the last 12 months." With a Budget, it adds: "{Category}: {spent} of its {Budget} Budget for {month}." | Within the cap, priority 5 |

**Rules behind the table:**

- **A frequent purchase:** 3 or more other Transactions at that Merchant in the 60 days before the earlier Transaction. For a Duplicate charge, they have the same amount. For a New Recurring charge, they are within 7.5% of it. A daily coffee is an example.
- **The base price:** the median of the previous 3 Transactions in the Recurring charge. It counts only Transactions from the last Price increase onward. Example: $15.49, $15.49, $15.49, then $17.99 fires. The next $17.99 compares against $17.99 and fires nothing.
- **Large purchase's 98%:** the purchases are the Spending Transactions in the 365 days before, with the same exclusions. At least 98% of them must be smaller.
- **Loan payments** are payments on tracked loans and untracked loans, as [Money movement](03-money-movement.md#loans) defines them.

## Overspending

Overspending is Spending in a Category above its Budget, or on pace to pass it. The Budget is the only baseline; history is not, because the Household may overspend from day 1.

- **Over Budget:** the Category's Spending this month has passed its Budget.
- **On pace:** the Category is not Over Budget, and its projected month-end Spending passes its Budget.
- A Category with no Budget has no Overspending.
- Yearly Budgets (Travel, and Gifts and donations) are only ever Over Budget, never On pace ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md#yearly-budgets)).

### The projection

The projection gives a Category's month-end Spending. The dashboard's pace line and the Goal progress math use it too.

**Rule:** on day d of a month with D days, P = R_posted + R_due + O + F × D ÷ d

| Term | Meaning |
|---|---|
| R_posted | Posted Spending this month that belongs to a Recurring charge or a tracked loan payment |
| R_due | Expected Recurring charges and tracked loan payments in the Category still due this month, at their latest amounts |
| O | One-off purchases this month: each Transaction that is a Large purchase, or is 50% or more of the Category's Budget. They are not extrapolated. |
| F | The rest of this month's posted Spending, net of Refunds and Reimbursements, never below $0 |
| d | Today's day of the month, Household time |

- **Bills group:** no extrapolation. P = R_posted + R_due + O + F.
- **Interest and fees:** no projection. Its Alerts come from card interest and fees.
- **A Merchant** (for a Goal): the same rule on that Merchant's Spending. Its one-offs are Large purchases only.
- The dashboard shows the projection from day 1 ([Dashboard and pages](07-dashboard-and-pages.md#2-left-to-spend)). The On pace Alert waits until the 8th.

**Examples:**

- Restaurants, Budget $500, on October 12: F = $240. P = $240 × 31 ÷ 12 = $620. $620 is 24% over, so the On pace Alert fires.
- Home and garden, Budget $150, on day 10 of 30: one $100 Home Depot purchase and $20 of other Spending. The $100 is a one-off, at 50% or more of $150. P = $100 + $20 × 3 = $160. That is On pace, but under 20% over, so no Alert. A straight line gives $360.
- Fitness, Budget $50, on day 10 of 30: the $50 gym Recurring charge posted on the 2nd. P = $50: on track. A straight line gives $150.

### Overspending Alerts

| Alert | Fires when | At most | The Alert says | Sent |
|---|---|---|---|---|
| **Over Budget** | A monthly Category's Spending passes its Budget | Once per Category per month | "{Category} is over Budget for {month}: {spent} of {Budget}. Latest: {amount} at {Merchant} on {date}." | Within the cap, priority 1 |
| **Over Budget** (yearly) | The year's Spending in Travel, or Gifts and donations, passes its yearly Budget | Once per Category per year | "{Category} is over its {year} Budget: {spent} of {Budget}. Latest: {amount} at {Merchant} on {date}." | Within the cap, priority 1 |
| **On pace** | From the 8th of the month, P is 20% or more over the Budget, and the Category is not Over Budget | Once per Category per month | "{Category} is on pace for {P} in {month}, {percent}% over its {Budget} Budget. Spent so far: {spent}." | Within the cap, priority 4 |
| **Card interest or fee** | Any card interest or any fee posts: a Transaction in Interest and fees that is not loan interest | Once per Transaction | "Card interest: {amount} on {Account} on {date}." or "Fee: {amount} at {Merchant} on {Account} on {date}." | Always, outside the weekly cap |

- **Current period only:** Overspending Alerts fire only for the current month. A yearly Budget's Alert fires only for the current year. A late post that pushes a past month over sends nothing.
- **Bills price rise:** a Bills Category sends no Over Budget or On pace Alert when Price increases explain the overage. The test: take this month's Spending. Subtract each increased Transaction's rise over its base price. If the result is within the Budget, only the Price increase Alert goes out. Price increases explain an Alert only when the same Alert would not fire without the rise: for On pace, P less the rise is under 20% over the Budget.
- **Interest and fees** sends no Over Budget or On pace Alert. The Card interest or fee Alert covers it. Loan interest never fires an Alert.
- **Card interest or fee** says "Card interest" for interest on a credit card. It says "Fee" for anything else.
- **Yearly Budgets** never send On pace. A pace guess misfires on one big trip.
- A yearly Recurring charge gets its Budget in its due month. So a due one never fires Overspending ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md#bills-group-housing-utilities-phone-and-internet-insurance-taxes-and-government)).
- A Bills Category is Over Budget only when a Recurring charge rises, or Spending outside its Recurring charges runs high.

## Alert kinds and priority

| Kind | Weekly cap | Priority within the cap |
|---|---|---|
| Duplicate charge | Outside: always sent | — |
| Card interest or fee | Outside: always sent | — |
| Over Budget | Counts | 1 |
| Price increase | Counts | 2 |
| New Recurring charge | Counts | 3 |
| On pace | Counts | 4 |
| Large purchase | Counts | 5 |

A Duplicate charge and card interest or a fee are outside the cap because that money can be recovered.

## Sending Alerts

### Recipients and channels

- Every Member gets every Alert.
- Each Member picks their own channels: push, email, both, or none.
- A new Member starts with both. The app skips a channel that is not set up: email without SMTP, or push with no device turned on.
- On plain HTTP, email is the only channel ([Members, login, and security](09-members-login-security.md)).
- [Stack and architecture](10-stack-and-architecture.md) covers web push and SMTP delivery.
- A push shows the kind as its title and the template text as its body.
- An email holds the template text, the AI's advice when there is any, and a link to the Alert list.
- Every Alert also shows in the Alert list and as an Alert note in the AI box ([Dashboard and pages](07-dashboard-and-pages.md#1-ai-box-this-week)).

### The weekly cap

- The cap is 3 Alerts per week for the Household. Any Member may change it in settings, to any whole number from 0.
- A week runs Monday to Sunday, Household time.
- The cap counts Alerts, not Members. One Alert sent to 3 Members counts once.
- An Alert over the cap is not sent by any channel. It waits in the Alert list, marked "held back (weekly cap)". It also goes into the next Monthly review ([AI](08-ai.md)).
- A held Alert is never sent later.
- **Priority:** within one sync's batch, the app sends the most urgent first, by the table above. Across batches, earlier Alerts take the slots.
- Duplicate charge and Card interest or fee Alerts never use a slot.

**Example.** Monday: an Over Budget Alert is sent (1 of 3). Tuesday's batch holds a Large purchase, a Price increase, and an On pace. The Price increase and the On pace are sent (3 of 3). The Large purchase is held. Thursday: a Duplicate charge is sent, outside the cap. Friday: a New Recurring charge is held.

### Merging

- Alerts of one kind created on the same day, Household time, become one Alert. It counts once against the cap.
- A merged Alert lists each part's line under one heading, such as "2 Categories are over Budget".
- An Alert created after that day's Alert of its kind was sent or held joins it in the Alert list. It sends no second push or email.

### Quiet hours

- Push waits from 9 PM to 8 AM, Household time. At 8 AM, the held pushes go out.
- Email sends at once, even in quiet hours.
- The cap decision happens when the Alert is created, not when its push goes out.

### System notices

System notices use each Member's chosen channels. They skip the weekly cap. Their push waits out quiet hours; their email does not.

### Sent stays sent

An Alert that went out never changes, even when a later Refund or Reimbursement changes that month ([Money movement](03-money-movement.md#which-month-a-link-changes)).

## What an Alert says

- A template always states the facts: the Merchant, the amount, the Budget, and the date, as each kind has them. The tables above give every template.
- The numbers never come from the AI.
- Amounts use the app's number formats ([Dashboard and pages](07-dashboard-and-pages.md#number-formats)).

### The AI's advice

- With an AI provider, the AI adds one or two sentences. They tie the Alert to an active Goal and give one practical step. With no active Goal, they give the step only.
- One advice call covers every Alert a sync creates. The app sends those Alerts when the call ends.
- The Alert has the template only in three cases: no AI provider, the AI cost cap, or a call that still fails after its retries ([AI](08-ai.md#failures)). It never gets advice later.
- The Alert note in the AI box shows at once. Its Next step appears when the advice arrives.
- **The AI receives:** each Alert's kind and template facts, that Category's Budget and Spending this month, every active Goal, and the "Not a problem" marks. [AI](08-ai.md) gives the tier and the privacy filter.

## "Not a problem"

Each Alert has an optional "Not a problem" button. Any Member may press it, for the whole Household. After it, the same Alert does not come back.

| Kind | Effect |
|---|---|
| Duplicate charge | Clears that one Transaction. It never fires a Duplicate charge again. |
| Large purchase | Clears that one Transaction. It never fires a Large purchase again. |
| Price increase | Accepts the new price. |
| New Recurring charge | Marks that Merchant and amount as known. That Merchant never fires a New Recurring charge again at an amount within 7.5% of it. |
| Over Budget, On pace, Card interest or fee | Only informs the AI. Nothing else changes. |

- The app records who pressed it and when.
- Pressing it makes no AI call. The next scheduled AI call carries it. It tells the AI which Alerts this Household does not care about.

## The Alert list

- The Alert list holds every Alert, including Alerts held back by the weekly cap and Alerts found in history. Each has its "Not a problem" button.
- Each Alert record holds:
  - the kind and the time it was created;
  - the template facts, and the Transactions or Category it is about;
  - the AI's advice, if any;
  - each "Not a problem" press, with who and when;
  - one state: "sent", "held back (weekly cap)", or "found in history".
- The page layout is in [Dashboard and pages](07-dashboard-and-pages.md#alert-list).

## Sources

- [Anomalies and Alerts](https://github.com/therecluse26/family-finance-tracker-private/issues/16)
- [Prior art: Transfer matching and categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/7)
- [Dashboard and graphs](https://github.com/therecluse26/family-finance-tracker-private/issues/9): the On pace projection. Prototype: branch [`prototype/dashboard-and-graphs`](https://github.com/therecluse26/family-finance-tracker-private/tree/prototype/dashboard-and-graphs)
- [Budget drafting and Goals](https://github.com/therecluse26/family-finance-tracker-private/issues/15)
- [Monthly review, Insight cards, and Chat](https://github.com/therecluse26/family-finance-tracker-private/issues/17)
- [Hands-off Transfer, Refund, and Reimbursement detection](https://github.com/therecluse26/family-finance-tracker-private/issues/13)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [AI context and cost](https://github.com/therecluse26/family-finance-tracker-private/issues/20)
- [Backup, restore, and data export](https://github.com/therecluse26/family-finance-tracker-private/issues/22): System notices and the cap
- [Stack and storage](https://github.com/therecluse26/family-finance-tracker-private/issues/12): email only on plain HTTP
