# Dashboard and pages

The dashboard is one screen that puts AI notes first and then shows the month's money at a glance. Every part of it is a box that leads with one number and its direction. The app draws every number and chart from its own data; the AI only writes words ([AI](08-ai.md)). No page is ever required: a Member who never opens anything still gets correct analysis.

Every total on every page counts posted Transactions only. A pending Transaction shows in lists, marked "pending", and counts in no total. A Transaction counts in the month of its purchase date ([Categorization](04-categorization.md)).

## The dashboard

Layout ([prototype, variant H](https://github.com/therecluse26/family-finance-tracker-private/tree/prototype/dashboard-and-graphs/prototype/dashboard)):

- The page has more than one column, with a box around each part.
- On a screen 900 px wide or wider, the AI box is the left column. It stays in view while the right column scrolls.
- On a narrower screen, all boxes stack in one column, and the AI box comes first.
- The right column holds, top to bottom: Left to spend, Goals, the four number tiles, "A usual month", and "Coming up".
- While app.db holds no Connection at all, such as after "Skip for now" in the wizard, no history can load. The dashboard then shows one line, "Link a bank to see your money here", with a link to Settings, Banks, in place of every box. The header and the status lines still show. A removed Connection counts here, because its history stays until a Member deletes it.

### Header and status lines

- The header shows the month's name, such as "October", and "Day N of M · synced <time>". The time is the latest finished sync of a Connection that is not removed.
- On the 1st, the dashboard switches to the new month. The month just ended lives on in its [Monthly review](#reviews-page).
- Above the boxes, the dashboard shows these lines when they apply. Each owner file defines when they appear and go:
  - a banner for each broken Connection, with **Repair** ([Accounts and bank sync](02-accounts-and-bank-sync.md));
  - "loading history for <bank>", with progress per Connection ([Accounts and bank sync](02-accounts-and-bank-sync.md));
  - the "Finish setup" list: Banks while the Household has no Connection, then the optional extras AI, Alerts, and Invite Members, each until it is done ([Install and first-run setup](12-install-and-first-run.md#the-first-run-wizard));
  - any other open System notice. A System notice about a past event, such as "Your history is ready", has a close button. One about a condition, such as a broken Connection, stays until the condition ends.

### 1. AI box ("This week")

The box shows every current note. Nothing hides behind "Show all".

**What the box holds:**

| Note | When it appears | When it leaves |
|---|---|---|
| Alert note | At once, when an Alert is created ([Anomalies and Alerts](06-anomalies-and-alerts.md)) | 7 days after the Alert |
| Proposal | When the AI makes a Proposal ([AI](08-ai.md#proposals)) | When a Member accepts or skips it, or it expires or is replaced |
| Insight card | After each Insight card run ([AI](08-ai.md#insight-cards)) | When the next run replaces the whole set |
| Monthly review link | When the review is written on the 1st | When a Member marks it Done, or after 7 days |

- "4 to 7" counts Insight cards only. Alert notes, Proposals, and the review link come on top.
- An Alert found in loaded history never shows in the box. It shows only in the [Alert list](#alert-list).

**Heading and groups:**

- The box's label is "This week". Its heading counts the notes in "Worth acting on" that are not Done: "N things worth acting on".
- Notes sit in three groups, in this order: "◆ Worth acting on", "● Heads up", and "✓ Good news". Each group header shows its count. An empty group is hidden.
- Group of each note:
  - Insight card: the group the AI picks.
  - Proposal: Worth acting on.
  - Alert note for Over Budget, Duplicate charge, card interest or a fee, or Price increase: Worth acting on.
  - Alert note for On pace, New Recurring charge, or Large purchase: Heads up.
  - Monthly review link: Heads up.
- Inside a group: Proposals first, then Alert notes newest first, then Insight cards in the AI's order.

**Parts of a note:**

1. A left column with the note's number and a short label under it, for example "$36" over "interest on Oct 9".
2. What it is about (a Category or topic), then the title.
3. "Why?" under the title. It opens the reason in place; "Hide why" closes it. An Insight card's picture, if it has one, shows here.
4. "Next step:" and one or two sentences. A Good news note says what the news means instead, with no "Next step:" label.
5. Small buttons: "Done" and "Ask about this".

- **Alert note:** the number, label, title, and reason come from the Alert's template facts. The Next step is the AI's advice. It appears when the advice arrives. Without advice, the note has no Next step line.
- **Proposal:** shows the change, for example "Restaurants Budget: $600 → $480", and the AI's one-sentence reason. Its buttons are "Accept", "Edit", "Skip", and "Ask about this". It has no Done button.
- **Monthly review link:** "Your <Month> review is ready", linking to the review.
- **Done:** marks the note done for every Member. A done note fades and stays in place until it leaves the box. Tapping "Done ✓" again clears the mark. Done makes no AI call.
- **Ask about this:** opens a new Chat thread with the note attached and a question drafted from it ([AI](08-ai.md#chat)). The Member may edit the question. Nothing goes to the AI until the Member presses Send.

**Without AI:**

- With no AI provider, the box shows Alert notes without advice. It also shows one note, "Set up AI for insights", which links to the [AI settings](08-ai.md#ai-settings-page).
- While background AI is paused (AI cost cap, rejected key), the last Insight cards stay. A line under the heading says "AI paused until <date>" or "AI paused: check the AI key".
- With no notes at all, the box says "Nothing new this week."

### 2. Left to spend

- Label: "Left to spend in <Month>".
- **The big number:** the sum of all monthly Budgets minus posted Spending in those Categories, this month. Spending in a Category with no Budget also counts against it. An overage in one Category uses up slack in another.
- Travel and Gifts and donations have yearly Budgets. Their Spending and Budgets stay out of the big number.
- Below $0, the number shows as "$X over" with "▲ Over Budget".
- **The pace line:** "◆ On pace to end $X over Budget" or "✓ On pace to end $X under Budget". It adds each Category's projected month-end Spending, by the projection in [Anomalies and Alerts](06-anomalies-and-alerts.md). It shows from day 1.
- **The month meter:** a bar of Spending against the summed Budget. A "today" tick marks the share of the month gone. Under it: "$spent of $Budget · N days to go".
- **Yearly Budgets:** one thin row each for Travel and Gifts and donations, under the meter. Each row shows the year's Spending, the yearly Budget, and the share of the year gone. Example: "$1,240 of $3,000 · 83% of the year gone". These rows never show On pace. Their only status is ▲ Over Budget ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).
- Before the first Budget draft, the box says "Budgets appear when your history has loaded."

### 3. Goals

- Right under Left to spend: a heading "Goals" with "N of M on track", then one equal-height box per active Goal, in a row. On a phone, the boxes stack.
- Each box shows:
  - the Member who wrote it;
  - their own words, in quotes;
  - "◆ Behind" or "✓ On track", and a percentage;
  - a progress bar;
  - one detail line, such as "$180 under pace this month".
- The app computes the percentage, the status, and the detail line ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)). A Goal that uses an Unconnected account's estimated balance shows "estimated".
- A Goal that reaches its target shows "✓ Done" for one month. Then it moves to the done list on the [Goals page](#goals-page).
- The heading has "Add a Goal". With no AI provider, it says "Goals need an AI provider" and links to the AI settings.
- With no active Goal, the box shows only the heading and "Add a Goal".

### 4. Number tiles

Four tiles in a row (two by two on a phone):

| Tile | Number |
|---|---|
| "Spending in <last month>" | All posted Spending in the last complete month |
| "Income in <last month>" | All posted Income in the last complete month |
| "Cash on hand" | Today's current balance of every connected checking and savings Account |
| "Debt" | Today's current balance of every credit card and every loan, Manual loans included |

- Excluded and Closed Accounts count in no tile. Unconnected accounts are not in Cash on hand.
- **The 12-month usual:** the median of the last 12 complete months. For Cash on hand and Debt, the app uses the 12 month-end balances.
- **Direction:** "▲ $X above usual" or "▼ $X below usual". Within 2% of the usual, the tile shows "● about usual" instead.
- **Trend line:** a small line of 12 points. For Spending and Income, the last 12 complete months. For Cash on hand and Debt, the last 11 month-ends and today.
- Debt counts Manual loan balances, which are the app's own estimates. When any Manual loan exists, the tile says "Debt includes N estimated loans". Balances before an Account's first sync are estimated too ([Accounts and bank sync](02-accounts-and-bank-sync.md)). When any month-end balance behind the usual of Cash on hand or Debt is from before an Account's first sync, the direction says "estimated usual" in place of "usual", as in "▲ $X above estimated usual" or "● about estimated usual".
- Tapping Spending opens [Top Merchants](#top-merchants). Tapping Income opens the [Transactions page](#transactions-page) for last month's Income. Tapping Cash on hand or Debt opens the [Account list](#account-list).

### 5. "A usual month"

- Label: "A usual month". The big number is the usual monthly Spending: the median of the last 12 complete months.
- The line under it: "<Month> is on pace for $X, $Y above usual" (or "below usual"). Within 2%, it reads "<Month> is on pace for $X, about usual".
- Below, one small bar chart per Category group, in the group order of [Categorization](04-categorization.md).
- **Each group box shows:**
  - the group's Spending this month and its Budget: "$spent of $Budget";
  - its status: "▲ N over", "◆ N on pace to go over", or "✓ on track". N counts the group's Categories in that state; Over Budget wins over On pace;
  - 13 bars: the 12 complete months, muted, and this month so far in full color;
  - a dashed line at the group's Budget. A past month uses the Budget in effect that month. Months before the first draft have no line.
- **Scope:** this box counts the same Categories as Left to spend. Travel and Gifts and donations stay out; the yearly rows show them. The "Spending" tile still counts all Spending.
- A group's Budget is the sum of its Categories' monthly Budgets.
- **Tapping a group** opens "<Group> Budgets" under the charts, as thin rows, with "Close". Each row shows:
  - the Category and "$spent / $Budget";
  - a thin meter. Only a flexible Category (not in the Bills group) gets a "today" tick;
  - for a Category that is not on track: "▲ $X over" or "◆ on pace for $X";
  - for each Bills Budget, the Benchmark as context, such as "Housing is 41% of Income; typical is 33%" ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).
  - A Category with no Budget shows its Spending and "no Budget".
- Rows run worst first: Over Budget, then On pace, then other flexible Categories, then Bills.
- Tapping a row opens the [Transactions page](#transactions-page) for that Category and month.

### 6. Coming up

- Label: "Due in the next 14 days". The big number is the total of every outgoing item in the window.
- The line under it: "Lowest checking balance: $X on <date>".
- The window runs from tomorrow to 14 days from today.
- A table in date order, with columns "Date", "What", "Amount", and "Checking after".
- **Rows:**
  - each active Recurring charge due in the window, at its expected amount ([Anomalies and Alerts](06-anomalies-and-alerts.md));
  - each predicted payday, with the payer's name ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md));
  - each connected card's payment due, at the statement balance, on the due date. A card whose statement balance is already paid shows no row;
  - each loan payment due: a connected loan's next payment from its loan details, and a Manual loan's regular payment on its usual day.
- An active Recurring charge whose expected date has come with no charge yet shows on today's position, and counts in the big number and in "Checking after". It says "late" in place of the date only when its expected date is before today in Household time; one expected today shows today's date. An inactive one leaves Coming up ([Anomalies and Alerts](06-anomalies-and-alerts.md)).
- A connected loan with no minimum payment in its loan details falls back as a Manual loan does: the amount of its last payment, due one month after it, on the same day of the month or the month's last day. Its last payment is one of these, in this order; with neither, it shows no row.
  - The paying side of its last Transfer pair, from the past 3 months.
  - Else the last [untracked loan payment](03-money-movement.md#untracked-loans) to its lender in the past 3 months. This counts only when both hold:
    - no other open loan in the Household, of any kind (connected with or without a minimum payment, paired or not, or Manual), has that lender's name;
    - the lender's untracked loan payments in those 3 months come at most once in each calendar month.
- A Recurring charge or Income series whose interval is shorter than the window shows at every expected date in the window: its next date, then one interval after each.
- A loan payment shows once. A Recurring charge whose last Transaction is a payment to a loan that has its own loan payment row does not show.
- **The balance:** the combined current balance of all connected checking Accounts. Each row's "Checking after" is that balance after the row.
- A Recurring charge that last landed on a credit card shows "on card" in "Checking after". It does not move the checking balance. The card's payment due does.
- Paydays show in bold with a "+" amount.
- Only Recurring charges count. A series with fewer charges than [Anomalies and Alerts](06-anomalies-and-alerts.md) requires never shows.
- Tapping the box opens the [Recurring charges page](#recurring-charges-page).

## Other pages

### Main menu

The main menu holds: Dashboard, Transactions, Chat, Reviews, Review list (with its open count), and Settings. A "More" section holds Budgets, Goals, Accounts, Alert list, Recurring charges, and Top Merchants.

- **Live AI status:** while background AI works, a small sign shows in the main menu, such as "● AI working: Categories", in the accent color. It links to Settings, AI. With no work, it is not there. Its words, when it shows, and its feed are in [AI](08-ai.md#live-ai-status).
  - From 900 px wide, it sits in the menu column, under the app's name.
  - At phone width, it is a thin line at the top of the bar at the foot of the screen, over the tabs. The shell has no header bar at phone width, and the line never covers the page. The open menu shows it under the app's name.

### Transactions page

Using this page is never required.

- **Filters:** Account, Category, Merchant, date range, and type (Spending, Income, Transfer, Saving, Refund, Reimbursement).
- **Each row:** the date, the Merchant, the amount, the Account, the Category or type, and a "pending" mark when pending. Newest first, by the date each row shows.
- A Category the AI or a Web lookup chose below "high" shows an "AI unsure" tag, in the row and on the detail view. At "medium" it counts as decided and is not on the Review list ([Categorization](04-categorization.md#the-categorization-cascade)).
- **The detail view** shows:
  - how the Category was chosen: "hand-set", "Category rule", "Plaid" (the Bank-data provider's category), "Merchant history", "AI", or "AI, unsure". A no-AI guess shows "best guess";
  - the evidence for any link (Transfer, Refund, Reimbursement, or loan payment): the matched Transaction and each signal that matched ([Money movement](03-money-movement.md)), with **Undo**.
- **Edits** (each rule lives in its owner file):
  - change the Category, with "only this Transaction" ([Categorization](04-categorization.md));
  - split by amount across Categories ([Categorization](04-categorization.md));
  - undo a link, or link a Refund or Reimbursement by hand ([Money movement](03-money-movement.md));
  - set the type by hand: Spending, Transfer, Income, or Saving. A hand-set type survives every re-run, like a hand-set Category.
- A Transaction the bank removed is hidden ([Accounts and bank sync](02-accounts-and-bank-sync.md)).

### Review list page

- Its own page in the main menu. The menu item shows the number of open items. The Review list sends no push and no email.
- Other areas put things on the list, and each owner file defines its own: Category guesses ([Categorization](04-categorization.md)); Transfer guesses, one-sided Transfers ("Which account is this?"), and money from a person with no link ([Money movement](03-money-movement.md)); loan items such as "Link to this loan?" and missed payments ([Accounts and bank sync](02-accounts-and-bank-sync.md)).
- **Each item shows** the Transaction or loan, what the app decided or could not settle, and two buttons:
  - a button that accepts the app's best answer, such as "Yes, Restaurants";
  - "Not this", which opens the other choices for that kind, such as the Category list.
- Accepting a Category guess makes a Category rule ([Categorization](04-categorization.md)). Every answer counts as hand-set.
- An item closes when a Member answers it, or when a later event settles it. Otherwise it stays.
- **Category cards.** A Category item holds all of one Merchant's Transactions of its kind, such as "Marathon · 14 Transactions · The AI chose Gas, but it was unsure." Its answer covers every Transaction on the card. A folded list under the card shows each Transaction's date, amount, Account, and Category, with "Change" to set that Transaction alone; a changed row leaves the card ([Categorization](04-categorization.md#review-list-items)).
- The menu's count and the page's count count items, so a card counts once.
- Newest first. Items made at the same moment, such as by one follow-up job, run by their Transaction's date, newest first. With no items, the page says "Nothing to check."

### Recurring charges page

- Off the main screen, like Top Merchants.
- **Each row:** the Merchant, the amount, the interval, the next expected date, and the Category. The interval is weekly, every 2 weeks, monthly, or yearly.
- A row shows "on card" when the Recurring charge lands on a credit card.
- Tapping a row opens its price history: each charge's date and amount.
- Rows run by next date. Inactive Recurring charges sit in a collapsed "Inactive" section ([Anomalies and Alerts](06-anomalies-and-alerts.md)).

### Top Merchants

- A simple ranked list of Merchants by Spending, with a switch: "This month" or "Last 12 months".
- Each row: the Merchant, its Spending, its number of Transactions, and its Category.
- Tapping a row opens the Transactions page for that Merchant.

### Account list

- A simple list grouped by type: checking, savings, credit cards, loans, and Unconnected accounts.
- **Each row:** the Account name, the institution, the last 4 digits, the current balance, and these marks when they apply: "last synced <date>" for a broken Connection, "estimated", "excluded", and "Closed".
- Closed Accounts sit in a collapsed section at the end.
- A Member edits Unconnected accounts and Manual loans here. The "Exclude" switch and a loan's Cash loan or Purchase loan type are here too ([Accounts and bank sync](02-accounts-and-bank-sync.md)).
- Tapping an Account opens its page: a balance line over time, with estimated days marked, and its Transactions.

### Alert list

- Every Alert, newest first, including Alerts held back by the weekly cap and Alerts found in loaded history.
- **Each row:** the date, the kind, the template text, the AI's advice when there is any, and one of these marks: "sent", "held back (weekly cap)", or "found in history".
- Each Alert has an "Ask the AI" button and a "Not a problem" button. Their effects are in [Anomalies and Alerts](06-anomalies-and-alerts.md#ask-the-ai). A merged Alert has one "Ask the AI" button under its heading, and a "Not a problem" button on each part.

### Budgets page

- Every Category grouped by Category group, with this month's Spending, its Budget, and its status. Yearly Budgets have their own section at the end.
- A Member edits any Budget here. Each Bills Budget has a "Follow the bill" switch. "Accept all" accepts the whole draft with one click. The rules for each are in [Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md).
- Each Bills Budget shows its Benchmark context, as in "A usual month".

### Goals page

- Active Goals first, each with its author, words, date, and progress, as on the dashboard.
- Each Goal shows the AI's reading of it: the target, the change, and the deadline ([Budgets, Benchmarks, and Goals](05-budgets-benchmarks-goals.md)).
- Actions: Add, Edit the words, mark done, and mark dropped.
- A done list and a dropped list sit in collapsed sections at the end.

### Reviews page

- A list of past months' Monthly reviews, newest first. Each opens that month's review.
- No separate email or push says a review is ready. On the 1st, a note in the AI box links to it.
- With no AI provider, no review is written. The page says so and links to the AI settings.

**Layout of one review** ([prototype, round 3](https://github.com/therecluse26/family-finance-tracker-private/tree/prototype/monthly-review-and-chat/prototype/ai)). Two columns on a wide screen, one on a phone. The AI writes the words in each part ([AI](08-ai.md#monthly-review)); the app draws every number and picture.

1. **Header:** "<Month> review · written <weekday>, <date>"; the AI's one-sentence headline; a Spending-against-Budget bar; "Left over"; and "Debt".
2. **"Habits we noticed":** one card per Habit, with its name, its line, its picture, the first idea that targets it ("Try: …"), and its cost a month.
3. **"Ideas, by what they save a month":** a bar chart of 5 to 8 ideas, green for Spending ideas and red for debt ideas. Tapping an idea shows why, the Catch, the effort (Easy, Some effort, or Big step), and the saving a year.
4. **"Your <next month> plan":** the 3 chosen ideas as a checklist, with "All three" and the total a month.
5. **"Goals":** a progress meter per Goal, each with one AI line on which idea moves it.
6. **"Budget changes to consider":** open Proposals, with Accept, Edit, and Skip. Beside it, **"Alerts you did not get":** the Alerts held back by the weekly cap that month, listed by the app.

- The header numbers count the same Categories as Left to spend.
- Plan ticks are shared across the Household. They are stored apart from the review, so the review itself never changes.

### Chat page

- A list of Chat threads, newest first, and the open thread. Every Member sees every thread.
- Each message shows who wrote it: a Member's name, or "AI".
- The input says "Ask about your money…". Rules for threads, answers, tools, and Proposals are in [AI](08-ai.md#chat).

### Settings overview

Settings has one section per area. Each owner file holds the rules.

| Section | Holds | Rules in |
|---|---|---|
| Household | Household facts (ZIP code, ages, rent or own) | [05](05-budgets-benchmarks-goals.md) |
| Members | Members, invite links, removing a Member, resetting a login | [09](09-members-login-security.md) |
| My login | Password, TOTP, backup codes, passkeys, signed-in devices | [09](09-members-login-security.md) |
| Banks | Plaid keys, Connections, Repair, Remove, "Import Plaid Connection", "at least N of 10 used", Unconnected accounts, Manual loans | [02](02-accounts-and-bank-sync.md) |
| Categories | Category rules, with Delete | [04](04-categorization.md) |
| Alerts | Weekly cap, my channels, the weekly summary email, SMTP and "Send a test email", push on this device | [06](06-anomalies-and-alerts.md) |
| AI | AI provider, key, models, prices, AI cost cap, base URL, the AI usage page, and the AI request log | [08](08-ai.md#ai-settings-page) |
| Backups and data | "Back up now", last backup, "Check my Master key", data export | [11](11-backup-restore-export.md), [09](09-members-login-security.md) |
| About | Version, "Source code" link, "Data sources" page, "Update available", the update-check switch | [12](12-install-and-first-run.md) |

## Shared visual rules

### Status: color, icon, and word together

Color marks attention. Every status color comes with its icon and a word. Color alone never carries meaning.

| Icon | Color | Words | Used for |
|---|---|---|---|
| ▲ | Red (critical) | "Over Budget", "$X over", "N over" | Spending past its Budget |
| ◆ | Orange (serious) | "On pace to go over", "on pace for $X", "Behind", "Worth acting on" | On pace, a Goal behind, notes worth acting on |
| ✓ | Green (good) | "On track", "under Budget", "Done", "Good news" | On track, Goals on track or done, good news |
| ● | Blue (accent) | "Heads up" | AI notes to know about |
| ● | Grey (muted) | "about usual" | No real change |

- **Direction against usual:** "▲" or "▼", then the amount and "above usual" or "below usual". The arrow is green when the change is good and orange when it is bad. More Spending or Debt is bad; more Income or Cash on hand is good.
- Everything else uses neutral ink. A chart's current month is in full color; past months are muted.
- AI-written text carries a small "AI" mark.
- An estimated number always carries the word "estimated".

### Number formats

- **Money:** US dollars with "$" and thousands commas, such as "$12,480". No "k" or "M" short forms.
- **Whole dollars** for totals, Budgets, balances, projections, and AI text. Rounded to the nearest dollar.
- **Cents** where one Transaction or one charge shows: the Transactions page, Coming up, the Recurring charges page, and Alert facts.
- **Signs:** money out shows "−" (a true minus sign); money in shows "+" where both appear together, as in Coming up.
- **Percent:** whole numbers, such as "41%".
- **Dates:** "Oct 9" within the current year, and "Oct 9, 2025" otherwise. Chart labels use "Oct 2025".
- **Times:** 12-hour, such as "8:15 AM", in the Household's time zone.

### Charts

- Every chart is drawn by the app from its own data.
- The chart library must pass the license check in [Stack and architecture](10-stack-and-architecture.md). Paid or source-available libraries, such as Highcharts or amCharts, are ruled out. The prototype's Recharts 3.10.1 (MIT) is a candidate, not a decision.

## Sources

- [Dashboard and graphs](https://github.com/therecluse26/family-finance-tracker-private/issues/9), with notes from [Manually tracked debts](https://github.com/therecluse26/family-finance-tracker-private/issues/18), [Budget drafting and Goals](https://github.com/therecluse26/family-finance-tracker-private/issues/15), [Anomalies and Alerts](https://github.com/therecluse26/family-finance-tracker-private/issues/16), and [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23)
- [Monthly review, Insight cards, and Chat](https://github.com/therecluse26/family-finance-tracker-private/issues/17)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19) (balance history, broken Connections, history loading)
- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21) ("Finish setup", settings)
- [Hands-off Transfer, Refund, and Reimbursement detection](https://github.com/therecluse26/family-finance-tracker-private/issues/13) and [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14) (Review list items, provenance)
- Prototype: [`prototype/dashboard-and-graphs`](https://github.com/therecluse26/family-finance-tracker-private/tree/prototype/dashboard-and-graphs/prototype/dashboard), variant H. Prototype: [`prototype/monthly-review-and-chat`](https://github.com/therecluse26/family-finance-tracker-private/tree/prototype/monthly-review-and-chat/prototype/ai), round 3.
