# Anomalies and Alerts

The app finds Recurring charges and four Anomalies, and it watches each Budget for Overspending. Checks run after each sync, on posted Transactions only, so Alerts arrive 1 to 3 days after a purchase. A template states every fact in an Alert; the AI may add advice. A weekly cap of 3 keeps Alerts rare, except for money the Household can get back.

## Recurring charges

A Recurring charge is Spending with one Merchant that repeats at a steady interval and a similar amount.

### Finding a series

- A Recurring charge is 3 or more Spending Transactions from one Merchant on one schedule. Their amounts are within 7.5% of each other.
- "Within 7.5% of each other" means the largest amount is at most the smallest amount × 1.075.
- Each Transaction must land within the schedule's margin. A weekly, 2-week, or yearly series measures it from the previous Transaction in the series. A monthly series measures it from a fixed day of the month ([Monthly series](#monthly-series)):

| Schedule | Interval | Margin |
|---|---|---|
| Weekly | 7 days | ±2 days |
| Every 2 weeks | 14 days | ±2 days |
| Monthly | The fixed day of each month, with the business-day shift. A day the month lacks means its last day. | ±2 days |
| Yearly | 12 months | 11 to 13 months after the previous one |

- **Yearly** needs only 2 Transactions, 11 to 13 months apart, with amounts within 15% of each other.
- A yearly series does not form when the Merchant has 3 or more other Transactions between its two Transactions, at any amount. The Transactions of another series do not count: neither those of a series the app found earlier, nor those of a price-unique yearly pair. A price-unique yearly pair is two of the Merchant's Transactions 11 to 13 months apart, within 15% of each other, with no other Transaction at the Merchant in the year between them within 15% of their amount. Whether a pair is price-unique does not depend on which series form, so one Merchant can keep several yearly subscriptions at different prices, such as an app store's plans. A shop the Household visits often is a frequent shop, and a monthly bill whose amount moves, such as a utility bill, repeats its amounts across the year: it is one monthly Recurring charge, not a yearly one.
- Transfers never count. Only Spending counts. Income series use a variant of this rule ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md#steady-income)).
- Spending in Interest and fees never forms a Recurring charge. Card interest and fees send the Card interest or fee Alert ([Overspending Alerts](#overspending-alerts)), and loan interest is a part of a loan payment. So interest never sends a New Recurring charge or Price increase Alert.
- A Merchant is identified as [Categorization](04-categorization.md) says: the provider's Merchant ID, else the clean name.
- One Merchant may have more than one Recurring charge, at different amounts.
- **A frequent shop never forms a Recurring charge.** When finding a new series, the app skips a Merchant with 3 or more other Transactions in the 60 days before or after the series' first Transaction that are not part of the series, at any amount. The window runs from 60 days before that Transaction to 60 days after it, so a shop's series cannot form at the start of a history, where nothing comes before. The series' part includes the later Transactions that would continue it. Another subscription at that Merchant does not count either, so one Merchant can still have two: neither the Transactions of its other Recurring charges, nor those of another series the rule finds on its own that has 2 or more Transactions in or near the window (within 70 days of it), at a steady amount (within 7.5% of each other). A shop's chance series continue at any amount, so their Transactions still count. A weekly grocery shop is an example. Existing Recurring charges in a database are found again by the next run, so a shop's series ends.
- A weekly, 2-week, or monthly series with only 2 Transactions is not a Recurring charge. It fires only the New Recurring charge Anomaly. That catches a forgotten free trial a month earlier.
- Only Recurring charges count in "Coming up", the [projection](#the-projection), the Recurring charges page, and the Budget formulas.

Source: this follows Sure and Actual, plus the weekly, 2-week, and yearly schedules, from [Prior art: Transfer matching and categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/7).

#### Monthly series

A monthly series is measured from a fixed day of the month, not from the previous Transaction. So an early or late Transaction does not move the next expected date.

- The fixed day is the day of the month whose expected dates are the fewest total days from the series' Transactions. A tie takes the earlier day.
- Each month's expected date is the fixed day in that month. A day the month lacks means its last day.
- **Business-day shift:** when an expected date is not a business day, a Transaction may also land within the margin of the business day before it or the business day after it. Business days follow the Federal Reserve calendar, as the Transfer windows do ([Money movement](03-money-movement.md#windows)): weekends and Federal Reserve holidays are closed.
- Income series use the same rule for monthly Income, and for each of the two fixed days of twice-a-month Income ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md#steady-income)).

### Continuing a series

- The next expected date is the last Transaction's date plus one interval. For a monthly series, it is the fixed day in the month after the expected date the last Transaction met.
- Once a Recurring charge exists, a Transaction from that Merchant continues it at any amount. It must land within the margin of the next expected date. The 7.5% band applies only to finding a new series. So a Price increase above 7.5% still continues the series.
- If two Transactions fit, the one nearest the latest amount continues the series.
- The latest amount is the amount of the last Transaction in the series.

### Inactive and ended

- A Recurring charge goes inactive after one missed Transaction. It is missed when the next expected date plus 2 days passes with none. For a monthly one, that is 2 days after the latest date the business-day shift allows. A yearly one is missed 13 months after its last Transaction.
- An inactive Recurring charge leaves "Coming up", the projection, and the Budget formulas' known amounts.
- A later Transaction can make it active again. It must come from the same Merchant, within 7.5% of the latest amount. Its date must be within the margin of the last date plus a whole number of intervals. For a monthly one, it must be within the margin of a later month's expected date. This fires no New Recurring charge Alert.
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
| **Duplicate charge** | Two posted Spending Transactions have the same Account, the same Merchant, and the same amount to the cent. Their purchase dates are 0 to 2 days apart. | A frequent purchase at that amount. A payment-app line whose Merchant is the payment app. | "Possible duplicate charge: {amount} at {Merchant} on {Account}, on {date 1} and {date 2}." Example: "Possible duplicate charge: $42.50 at Shell on Chase Sapphire, on Oct 3 and Oct 4." | Always, outside the weekly cap |
| **Price increase** | A Transaction continues a Recurring charge. It is more than 5% and more than $1 above the base price. | A drop. A rise of 5% or less, or of $1 or less. | "{Merchant} went up from {base} to {amount} (+{difference}, +{percent}%) on {date}." Example: "Netflix went up from $15.49 to $17.99 (+$2.50, +16%) on Oct 3." | Within the cap, priority 2 |
| **New Recurring charge** | A posted Transaction and exactly one earlier Transaction from the same Merchant fit a weekly, 2-week, or monthly schedule. Their amounts are within 7.5% of each other. | The yearly schedule. A Transaction that continues or revives a Recurring charge. A Merchant and amount marked known. A frequent purchase. Spending in Interest and fees. | "New Recurring charge? {Merchant}, {amount} on {date 1} and {date 2}. Next expected {next date}." Example: "New Recurring charge? Hulu, $9.99 on Sep 3 and Oct 3. Next expected Nov 3." | Within the cap, priority 3 |
| **Large purchase** | One posted Spending Transaction of at least $250. It is larger than 98% of the Household's purchases in the 12 months before it. | Recurring charges. Spending in the Bills group. Loan payments. Transfers. | "Large purchase: {amount} at {Merchant} on {date}. It is larger than 98% of your purchases in the last 12 months." With a Budget, it adds: "{Category}: {spent} of its {Budget} Budget for {month}." | Within the cap, priority 5 |

**Rules behind the table:**

- **A frequent purchase:** 3 or more other Transactions at that Merchant near the earlier Transaction. A daily coffee is an example.
  - For a Duplicate charge, they are in the 60 days before the earlier Transaction, at the same amount.
  - For a New Recurring charge, they are in the 60 days before or after the earlier Transaction, at any amount, as for a frequent shop ([Finding a series](#finding-a-series)). The later Transaction of the pair is not one of them. Transactions of the Merchant's Recurring charges do not count. The check counts the Transactions the app has when it runs, so a pair found in a history load sees all of its window.
- **A payment app as the Merchant:** when a payment-app line names no person or shop, the payment app is the Merchant ([Categorization](04-categorization.md)). Two such lines for the same amount are often payments to different people, so they never fire a Duplicate charge. A line that names a person or a shop has that person or shop as its Merchant, and the Duplicate charge check applies as usual.
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
- Push on a device belongs to the one Member who turned it on. When another Member uses that browser, the page tells them that push on this device is on for another Member. Nothing they do there ends the first Member's push.
- A new Member starts with both. The app skips a channel that is not set up: email without SMTP, or push with no device turned on.
- On plain HTTP, email is the only channel ([Members, login, and security](09-members-login-security.md)).
- **Settings, Alerts** holds the email server, push on this device, and the weekly summary email:
  - SMTP takes a host, a port, a sign-in name, a password, and a sender address.
  - "Send a test email" sends to the signed-in Member. The "Finish setup" item for Alerts is done only after a test email goes out ([Install and first-run setup](12-install-and-first-run.md#the-first-run-wizard)).
  - "Turn on Alerts on this device" works over HTTPS only. On plain HTTP, the push part is hidden, with the reason shown.
  - On an iPhone, the page first explains "Add to Home Screen", because only an app on the Home Screen gets pushes.
  - "Weekly summary email" is each Member's own switch, under "My channels" ([Weekly summary email](#weekly-summary-email)).
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
- **The AI receives:** each Alert's kind and template facts, that Category's Budget and Spending this month, every active Goal, and the "Not a problem" marks. [AI](08-ai.md) gives the tier and what the AI provider gets.

## "Not a problem"

Each Alert has an optional "Not a problem" button. Any Member may press it, for the whole Household. After it, the same Alert does not come back.

| Kind | Effect |
|---|---|
| Duplicate charge | Clears both Transactions of the pair. Neither fires a Duplicate charge again or pairs with a later charge. |
| Large purchase | Clears that one Transaction. It never fires a Large purchase again. |
| Price increase | Accepts the new price. |
| New Recurring charge | Marks that Merchant and amount as known. That Merchant never fires a New Recurring charge again at an amount within 7.5% of it. |
| Over Budget, On pace, Card interest or fee | Only informs the AI. Nothing else changes. |

- The app records who pressed it and when.
- Pressing it makes no AI call. The next scheduled AI call carries it. It tells the AI which Alerts this Household does not care about.

## "Ask the AI"

Each Alert in the Alert list has an "Ask the AI" button, beside "Not a problem". It opens a Chat thread about that Alert, so a Member can ask "why?" or "what should we do?" ([AI](08-ai.md#threads)).

- **Who:** any Member. Every Member sees every Alert ([Members, login, and security](09-members-login-security.md)), so any Member can ask about any Alert. A merged Alert has one button for all its parts.
- **What the browser sends:** the Alert's ID only. The app reads the Alert itself from app.db. It never uses Alert facts from the browser.
- **The thread:**
  - Its title is "About: " and the Alert's short title, cut to 60 characters, such as "About: Card interest on Northwind card". A merged Alert's short title is its heading.
  - The Alert is attached. The thread shows each part's template text and the AI's advice, if any.
  - It has no message at first. The Member types the first question. Like every thread, it is shared ([AI](08-ai.md#threads)).
  - The thread keeps a copy of the Alert from when it started. A later change to the Alert does not change the thread.
- **One thread per Member and Alert:** a Member's next press on the same Alert opens that Member's thread for it again. It starts no second thread. Two presses at once start one thread. Another Member's press starts that Member's own thread. After a Member deletes the thread, the next press starts a new one.
- **What the AI receives,** with each question in the thread: the Alert's kind; each part's template facts; what the Alerts step did with it ("sent", "held back (weekly cap)", or "found in history"); whether a Member pressed "Not a problem"; and the AI's advice, if any. Each amount, date, month, and count goes as the app made it ([AI](08-ai.md#what-the-ai-provider-gets)). The note names no Account. The thread's title is never sent.
- **Cost:** pressing the button makes no AI call. Each answer in the thread is a Chat answer: it counts against the AI cost cap, like every Chat answer.
- **When Chat cannot answer:** the button always shows. With no AI provider, before history has loaded, while the AI provider rejects the key, or while the model has no price, pressing it starts no thread. The Alert then shows why, in Chat's words, such as "Set up an AI provider in Settings, AI, to use Chat."
- **At the AI cost cap:** pressing it starts the thread. Chat then asks "Send anyway?" before each message, as it always does at the cap ([AI](08-ai.md#the-ai-cost-cap)).
- **A deleted Alert:** when Delete history deletes the Alert, no press can start a thread about it. A thread already started stays, with its copy of the Alert.

## The Alert list

- The Alert list holds every Alert, including Alerts held back by the weekly cap and Alerts found in history. Each has its "Ask the AI" and "Not a problem" buttons.
- Each Alert record holds:
  - the kind and the time it was created;
  - the template facts, and the Transactions or Category it is about;
  - the AI's advice, if any;
  - each "Not a problem" press, with who and when;
  - one state: "sent", "held back (weekly cap)", or "found in history".
- The page layout is in [Dashboard and pages](07-dashboard-and-pages.md#alert-list).

## Weekly summary email

Each Member can turn on a short email about the Household's last 7 days. It goes out on Sunday morning. The app builds it from numbers it already counts, so it makes no AI call. It is not an Alert: it never counts against the weekly cap and never shows in the Alert list.

### Who gets it

- Each Member turns it on or off for themselves only, with the "Weekly summary email" switch in Settings, Alerts, under "My channels". It is off for a new Member.
- The switch saves at once. It changes only the signed-in Member's own setting. No Member can turn it on or off for another Member.
- It goes to that Member's login email, through the Household's SMTP server, as one email to that Member alone.
- It does not follow the Email channel. A Member may turn off email for Alerts and still get the summary, or the other way round. Reason: the summary is one email a week, and a Member who finds Alert emails too many may still want it.
- With no SMTP server saved, the switch row says "Needs the email server. Save it below." A Member can still turn the switch on. The app sends no summary while no server is saved, and never sends a missed one later.

### Which days it covers

- It covers the 7 days from Sunday to Saturday, Household time, that end the night before it goes out. The email names them, such as "Sunday, Nov 1 to Saturday, Nov 7".
- Reason: the weekly cap's week runs Monday to Sunday ([The weekly cap](#the-weekly-cap)), but on Sunday morning that week still has a day to go. These 7 days are complete, and each day is in exactly one summary. The weekly cap's week does not change.

### When it goes out

- Sunday at 8:00 AM, Household time. Email does not wait for quiet hours, but 8 AM is when they end, so the summary never arrives in the night.
- Only this schedule starts it. A sync, a start of the app, or a change of settings never starts one.
- **The app was off:** if the app was off at 8:00 AM on Sunday, its next start sends that week's summary, with the same dates, until the next Sunday at 8:00 AM. After that, only the newer week's summary goes. A Member never gets a summary for an older week.
- A Member who turns the switch on after the week's summary went out gets the next week's. While a retry of the week's summary waits ([When it fails](#when-it-fails)), a Member who turns the switch on gets that week's summary in the retry.
- **At most one per Member per week.** Before it sends, the app records the Member and the week in app.db, under a unique key. The check and the record are one write, so two runs at once, or a run after a restart, send no second copy. If the app stops during a send, that week's summary is not sent again, because the app cannot know whether it went. The app builds the summary before it records any Member's week, so a stop during the build loses no week. The record checks the switch again, so a Member who turns it off while the summary builds gets none. A run that finds every Member's week recorded builds nothing.

### What it holds

The subject is "Weekly summary: {first date} to {last date}", such as "Weekly summary: Nov 1 to Nov 7". The text has these parts, in this order. Amounts use the app's number formats ([Dashboard and pages](07-dashboard-and-pages.md#number-formats)). Each part ends with a link to its page, which starts with APP_URL.

| Part | What it says | Link |
|---|---|---|
| Spending | The Spending posted in the 7 days, by the rule for every total: net of Refunds and Reimbursements, with no Category below $0 ([Categorization](04-categorization.md#which-month-a-transaction-counts-in)). Each part counts on the day it posted, and a linked Refund or Reimbursement on the day it came, not on its Spending's ([By posted date](#what-it-holds)). Then the direction against usual, such as "▲ $72 above usual". The usual is the median of the 12 Sunday-to-Saturday weeks before, counted the same way. As the dashboard's usual counts the month the history starts in, the usual counts the week the history starts in, and leaves out each week before it. With no such week, the part has no usual. | The Transactions page, for Spending posted on those dates |
| Budgets | Each Budget that is Over Budget or On pace in the month of the last date, with its Spending and its Budget. With none, "Every Budget is on track." Before the first Budget draft, "No Budgets yet." | The Budgets page |
| Alerts | How many Alerts were created in the 7 days: how many were sent, and how many were held back (weekly cap). A merged Alert counts once. An Alert found in history does not count. | The Alert list |
| Review list | How many items are open in the Review list when it is built. | The Review list |
| Coming up | Each active Recurring charge whose next expected date is in the 7 days after the last date, Sunday to Saturday: its date, its Merchant, and its latest amount. At most 10, then "and {count} more". With none, "No Recurring charges are due." | The Recurring charges page |

- A last line says how to turn the summary off: the Settings, Alerts page, with its link.
- **Posted only:** the Spending part counts posted Transactions only, as every total does.
- **By posted date:** the Spending part counts what posted in the 7 days, not what was bought in them. A purchase still pending at the send counts in the next week's summary. Reason: each part counts in exactly one summary, each of the usual's weeks reads as its own summary did, and the link lists the same purchases. A month's total counts by purchase date, so near a week's edge the Budgets part and the dashboard can count a purchase in another week. A Transaction the bank sends after its week's summary went out, posted in that week, counts in no summary.
- **One build a run:** the app builds the summary's text once for each week. Every Member who gets it gets the same text. A Household with 5 years of history builds it in less than 1 s.

**Example:**

> Your weekly summary for Sunday, Nov 1 to Saturday, Nov 7.
>
> Spending: $612, ▲ $72 above usual.
> See it: https://nas.example/transactions?type=Spending&from=2026-11-01&to=2026-11-07

### Privacy

- The summary follows the rules for an Alert email. It goes only through the Household's SMTP server, to the one Member.
- It names Categories and Merchants, as Alerts do. It names no Account and no Member, and holds no account or card number.
- Each Merchant name is made plain first: a space for each control character, so a name cannot start a line of its own.
- The log never holds a Member's email address or the summary's text. It holds counts and error codes only.

### When it fails

- **A send fails:** the app counts a try for that Member and week. It tries again for that week 5 minutes later, then 30 minutes after that: 3 tries in all. Reason: a mail server that restarts, or a router that reboots, at 8:00 AM must not cost the week. After the third failed try, the app gives up on that week's summary for that Member. It raises one System notice: "The app could not send some weekly summary emails, and gave up on them. Check the SMTP settings in Settings, Alerts." The next summary that sends ends it.
- A retry sends only while its week is the current one. After the next Sunday at 8:00 AM, it sends nothing.
- **The build fails:** each Member waiting for that summary counts a try, as for a failed send.
- **The SMTP password cannot be read:** the app sends no summary that week. The Delivery job's own System notice tells Members to enter the password again ([Sending Alerts](#sending-alerts)). If this happens between tries, the retries send nothing.
- **What the Member sees:** the switch row shows that Member's latest week:
  - sent: "✓ Last sent Sunday, Nov 8";
  - a try failed, and a retry waits: "◆ Sending the summary for Nov 1 to Nov 7. The app tries again if a send fails.";
  - the app gave up, or no retry came within 1 hour, as after a stop during a send: "▲ The summary for Nov 1 to Nov 7 did not send. Check the email server below."
- The app never retries a week after it gives up, and never sends a week late after the next Sunday at 8:00 AM.

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
