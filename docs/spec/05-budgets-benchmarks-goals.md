# Budgets, Benchmarks, and Goals

The app drafts every Budget with a fixed formula, so Budgets work with no AI provider. Bills Budgets follow what the Household's Recurring charges cost. Flexible Budgets take the lower of the Benchmark and the Household's own 12-month average × 1.10. History can tighten a Budget, never loosen it. After the draft, a flexible Budget changes only when a Member edits it or accepts a Proposal. Goals are a Member's own words: the AI reads them, and the app computes their progress.

## Formula terms

Every formula in this file uses these terms.

| Term | Meaning |
|---|---|
| m | The month the app is computing a Budget for. |
| History window | The last 12 complete calendar months before m. When the Household's history is shorter, the window holds every complete month there is. History starts at the earliest posted Transaction on any Account. |
| n | The number of months in the history window. "Months of history" means n. |
| A(c) | Spending in Category c over the history window, divided by n. |
| A_other(c) | A(c), leaving out Spending that belongs to any Recurring charge (active or not) or to a tracked loan payment. |
| A_flex(c) | A(c), leaving out yearly Recurring charges. |
| K(c, m) | The known amounts in c for m (below). |
| Y(c, m) | The yearly Recurring charges in c expected in m, at their latest amount. Y is part of K. |
| B(c) | The Benchmark for c, per month ([Benchmarks](#benchmarks)). |
| I | Steady Income, per month ([Steady Income](#steady-income)). |

**Known amounts K(c, m)** are the sum of:

- each active Recurring charge in c, once for each expected date in m, at its latest amount. A date already paid by an earlier Transaction does not count. Recurring charges and their expected dates are in [Anomalies and Alerts](06-anomalies-and-alerts.md#recurring-charges).
- each Spending part in c of each tracked loan payment expected in m. A tracked loan is a connected loan or a Manual loan. Its next payment is expected one month after its last linked payment. Each part is expected at its amount in that last payment. [Money movement](03-money-movement.md#payments-on-a-tracked-loan) gives the parts.

**General rules:**

- Spending means posted Spending, net of linked Refunds and Reimbursements, in the month of its purchase date ([Categorization](04-categorization.md#which-month-a-transaction-counts-in)).
- A flexible Category is any Category outside the Bills group.
- **Room above typical Spending:** in the draft, the Household's own figure for a flexible Category is its 12-month average × 1.10, rounded as drafts round. The draft still takes the lower of the Benchmark and that figure, and history still never loosens a Budget after the draft. The 10% keeps a typical month under its Budget. The [total must fit](#the-total-must-fit) step runs as before.
- **History shorter than one complete month:** n is 0. Then A(c), A_other(c), and A_flex(c) use all Spending loaded so far, scaled to a month: × the days in m ÷ the days of history. The days of history run from the start of history to the day the app computes, both days counted. With fewer than 7 days of history, the app counts 7 days. Groceries and Superstores then use the [split rule](#shopping-groceries-and-superstores).
- The app rounds every Budget to the nearest whole dollar.
- A Category group's Budget is the sum of its Categories' Budgets.

## Household facts

- The setup wizard asks for these once: the ZIP code, each person's age, and whether the Household rents or owns. People without a login count, such as children. No one is asked their sex.
- A Member may edit the facts in settings at any time.
- The facts stay on the server. The AI never receives the ZIP code or the ages.
- The app ships a ZIP table. It maps each ZIP code to a state and a time zone.
- A county that two time zones divide gets one time zone, so Household time can be one hour off there. The app has no time zone override.
- The facts feed these rules:

| Fact | Used for |
|---|---|
| Number of people | The household size for the USDA food plan and the CE table |
| Each person's age | The USDA food cost per person |
| Rent or own | The CE housing line for the Housing context line: owned dwellings for a Household that owns. A Household that rents gets no typical Housing figure ([Context for Bills Budgets](#context-for-bills-budgets)). |
| ZIP code | The Household time zone; the Alaska and Hawaii food rule |

- The Household time zone sets every Household-time rule: the 1st of the month, quiet hours, and the Alert week.
- An edit to the facts changes the time zone at once. With an AI provider, it also starts a [redraft Proposal](#which-proposals-exist).

## Benchmarks

A Benchmark is typical Spending for a Category by similar US households, from public data. It is a reference for drafting Budgets, never a Budget itself.

### The shipped data

- Each release ships a Benchmark snapshot. A release script builds it. Every source is a US federal work in the public domain.
- The snapshot holds:
  - the BLS Consumer Expenditure Survey (CE) tables: Spending per CE line by income, and by household size × income;
  - the Category-to-CE-line map;
  - the USDA Food Plans at the Moderate-Cost level, for the latest month at release, with the household-size adjustment USDA publishes;
  - the USDA Thrifty plan for the US, Alaska, and Hawaii;
  - the ZIP table;
  - the CPI value each figure was priced at.
- v1 ships no IRS Collection Financial Standards, HUD Fair Market Rents, Census ACS, or DOL childcare data.

### CPI

- The app fetches the CPI from the BLS API v1, which needs no key.
- It fetches two series: `CUUR0000SA0` (all items) and `CUUR0000SAF11` (food at home).
- It fetches once a month, on the 20th, Household time. A failed fetch tries again the next day.
- Offline, or until a fetch succeeds, the app uses the newest CPI value it has: shipped or fetched.
- A new CPI value changes the Benchmarks the app shows. It never changes a Budget by itself.

### The Benchmark for a Category

1. **Pick the CE column.** Take the Household's yearly Income: I × 12. Use the CE size × income table for the Household's size. Pick the income column whose mean income after taxes is nearest that figure. If that table has no column for the size, use the one-year income table.
2. **Find the share.** s(c) = the column's mean yearly Spending on c's CE lines ÷ the column's mean total yearly Spending.
3. **Apply it to Income.** B(c) = s(c) × I.

Example: the column spends 5% of its total on the Restaurants lines, and I is $6,000. B(Restaurants) = $300 a month.

Shares are ratios, so CE figures need no CPI aging. The Category-to-CE-line map comes from the [Category list research](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transaction-categorization/docs/research/transaction-categorization.md), section 7. Travel and Insurance sum several CE lines, not one major group.

### The Groceries and Superstores Benchmark

Groceries and Superstores share one Benchmark, B_GS, because Superstores mixes food at home, household supplies, and personal-care products.

B_GS = F + (s(housekeeping supplies) + s(personal care products)) × I

- F is the USDA Moderate-Cost plan for the Household, per month:
  1. Take each person's cost for their age. Where USDA splits by sex, use the mean of the male and female costs. A child under 1 uses the 1-year cost.
  2. Add the people's costs. Apply USDA's household-size adjustment.
  3. Multiply by the CPI food at home now ÷ the CPI food at home in the plan's month.
  4. For an Alaska or Hawaii ZIP code, multiply by that state's Thrifty cost ÷ the US Thrifty cost.
- The Personal care Benchmark uses only CE personal care services, because the products sit in B_GS.

Example: F is $1,000 for two adults and one child. Supplies are 2% of I = $6,000, so $120. B_GS = $1,120.

### Which Categories have a Benchmark

| Benchmark role | Categories |
|---|---|
| Drafts the Budget | Clothing, Home and garden, Alcohol and tobacco, Gas, Car, Transit and rideshare, Health, Personal care, Childcare, Pets, Fitness, Restaurants, Entertainment, Hobbies, Books and education |
| Drafts the Budget, shared | Groceries and Superstores (B_GS) |
| Context only | Housing (for a Household that owns), Utilities, Phone and internet, Insurance |
| None | Taxes and government, Interest and fees, Travel, General goods, Gifts and donations, Services, Cash, Payments to people, Miscellaneous |

### Context for Bills Budgets

- Each Bills Budget with a Benchmark shows one context line: "<Category> is X% of Income; typical is Y%". X = the Budget ÷ I. Y = B(c) ÷ I. Example: "Housing is 41% of Income; typical is 33%".
- **A Household that rents** has no Housing Benchmark. The CE mean for rented dwellings is an average over all households, owners included, so it reads far too low for a renter, such as "typical is 7%". Housing's line then shows no typical figure: "Housing is 41% of Income". The AI gets no Housing Benchmark either.
- CE leaves mortgage principal out, as a reduction of debt. It counts a financed car at its full price in the year of purchase. So Housing and Car Spending can sit above their Benchmarks for this reason alone. The app gives the AI this fact with any Housing or Car comparison.
- 50/30/20 and the 30% housing rule appear only as plain-English framing, never as a rule. 50/30/20 comes from Warren and Tyagi's *All Your Worth* (2005), with no statistical basis found.

### The Data sources page

The app has one "Data sources" page in settings. The repo has a matching file. They:

- name each agency, table, and data date;
- say that no agency endorses the app;
- show this sentence and the date the app last fetched the CPI: "BLS.gov cannot vouch for the data or analyses derived from these data after the data have been retrieved from BLS.gov.";
- mark the copied government numbers as public domain, outside the AGPL;
- keep our own work, such as the Category-to-CE-line map, under the AGPL.

Sources: [Free public US spending benchmarks](https://github.com/therecluse26/family-finance-tracker-private/issues/6), [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23), [Benchmark research](https://github.com/therecluse26/family-finance-tracker-private/blob/research/spending-benchmarks/docs/research/spending-benchmarks.md).

## Steady Income

Steady Income (I) is the Household's regular Income per month. It sets the Benchmarks, the "must fit" total, and the Income Proposal trigger. It also predicts paydays.

**Finding Income series.** The app runs the Recurring charge rule from [Anomalies and Alerts](06-anomalies-and-alerts.md#recurring-charges) on Income, with these changes:

- It uses Income Transactions on checking and savings Accounts only.
- It groups them by payer: the Merchant on the Income Transaction.
- Amounts must be within 15% of each other, not 7.5%.
- A monthly Income series is measured from a fixed day of the month, with the business-day shift, as a monthly Recurring charge is ([Monthly series](06-anomalies-and-alerts.md#monthly-series)).
- It adds a twice-a-month schedule: two fixed days of the month, each within ±2 days. Examples: the 1st and the 15th, or the 15th and the last day.
- The two fixed days are the pair whose expected dates are the fewest total days from all of the series' Transactions, as for the fixed day of a monthly series. The app picks them again as Transactions arrive. So a payer on the 15th and the 28th that is first found in February keeps the 28th, not the last day.
- Each of the two fixed days has the same business-day shift as a monthly series. When its expected date is a weekend day or a Federal Reserve holiday, a Transaction may also land within ±2 days of the business day before it or the business day after it. Example: a payer on the 1st and the 15th pays on Friday, December 29, because January 1 is a Monday and a holiday. That is 3 days early, but it is on the business day before.
- A series may fit both every 2 weeks and twice a month. Then the app picks the schedule whose expected dates are fewer total days from the actual dates.
- Yearly series never count as steady Income.

**The figure.**

- A series counts when it is active and has Income in the last 3 months.
- I = the sum, over counted series, of the series' median amount in the last 3 months × its factor.

| Schedule | Factor |
|---|---|
| Weekly | 52 ÷ 12 |
| Every 2 weeks | 26 ÷ 12 |
| Twice a month | 2 |
| Monthly | 1 |

- Income outside every series is a one-off, such as a tax refund, a bonus, or a gift. It is left out.
- The app recomputes I after each sync.
- With no counted series, I = the median of total Income over the last 3 complete months.
- When I is $0, flexible Categories draft as if they had no Benchmark. The "must fit" step does not run.
- A Member may type a different figure in settings. This is optional. The typed figure replaces the detected one until a Member clears it.

**Paydays.** Each counted series predicts its next date from its schedule, at its latest amount. "Coming up" shows them ([Dashboard and pages](07-dashboard-and-pages.md#6-coming-up)).

**Example.** Acme pays $2,000, $2,050, and $2,000, every 2 weeks: $2,000 × 26 ÷ 12 = $4,333. A second job pays $1,667 monthly. A $1,500 tax refund fits no series. I = $6,000.

## Drafting Budgets

### When the app drafts

- **The first draft** runs once, when the first history load ends ([Accounts and bank sync](02-accounts-and-bank-sync.md#first-history-load)).
- The first draft takes effect in the month it runs. Months before it have no Budget.
- The draft is the active Budget at once. Members can edit any Budget, or accept them all with one click. If nobody looks, the draft stays active.
- **Bills Budgets** are computed again on the 1st of every month, Household time.
- **A Category with no Budget** gets its first Budget on the 1st after it qualifies (below). The formula sets it, with no Proposal.
- **An undone first Budget:** when a Member undoes an accepted Proposal that gave a Category its first Budget, the Category stays without a Budget. The formula does not give it a first Budget again on a later 1st. It gets a Budget again only when a Member sets one: by an edit, or by accepting a later Proposal for that Category.

### Which Categories get a Budget

- A Category gets no Budget when it has no Spending in the history window and no known amounts for m. It never gets a $0 Budget this way. With n = 0, the Spending loaded so far counts in place of the history window.
- Interest and fees always gets a Budget, even $0.
- A Category with no Benchmark gets no Budget until there are 3 months of history (n ≥ 3). Bills Categories are exempt.
- Spending in a Category with no Budget still counts against Left to spend ([Dashboard and pages](07-dashboard-and-pages.md#2-left-to-spend)).

### Bills group: Housing, Utilities, Phone and internet, Insurance, Taxes and government

**Rule:** Budget(c, m) = K(c, m) + A_other(c)

- The app sets this on the 1st for that month.
- A Recurring charge's new amount reaches the Budget from the next month. So a Bills Category can be Over Budget in the month a Recurring charge rises. [Anomalies and Alerts](06-anomalies-and-alerts.md#overspending-alerts) decides which Alert that sends.
- A yearly Recurring charge counts only in the month it is expected. A due yearly Recurring charge never makes Overspending.
- **Early or late:** an expected Recurring charge or loan payment can post within its margin but in the next or previous month. Then its known amount moves to the Budget of the month it posted in.
- **Pinned:** when a Member edits a Bills Budget, it is pinned. It stays at the typed amount each month. Its "Follow the bill" switch puts it back on the formula from the next month.
- The Benchmark is context only. The formula never uses it.

**Example: Utilities in March.** The electric Recurring charge is $120 a month. Water posts every 2 months, which is not a Recurring charge schedule. It totals $360 in the window, so A_other = $360 ÷ 12 = $30. Budget = $120 + $30 = $150.

**Example: Insurance.** Car insurance is a yearly Recurring charge of $1,200, expected in June. Nothing else is in Insurance. June's Budget is $1,200. Every other month's Budget is $0.

### Bills group: Interest and fees

**Rule:** Budget(m) = the interest expected on every tracked loan payment in m. Card interest and fees get $0.

- When a loan payment posts, its actual interest replaces its expected interest in the Budget.
- So Interest and fees goes Over Budget only through card interest or a fee. Any card interest or fee is Overspending.
- With no tracked loans, the Budget is $0.

**Example.** The Larkspur payment's expected interest is $100, so the Budget is $100. The payment posts with $98 of interest, so the Budget becomes $98. A $35 card late fee posts. Spending is $133, so the Category is $35 Over Budget.

### Shopping: Groceries and Superstores

The app drafts the two together, then splits the total by the Household's own ratio.

1. T = the lower of B_GS and (A_flex(Groceries) + A_flex(Superstores)) × 1.10. With n < 3, T = B_GS.
2. r = Groceries Spending ÷ (Groceries + Superstores Spending), over the history window. With n = 0, use all Spending loaded so far.
3. Groceries: Budget = max(K, Y + T × r). Superstores: Budget = max(K, Y + T × (1 − r)). K and Y are each Category's own.

When one of the two gets its first Budget while the other holds all of T, the app splits T between them by r, so their total stays T. The other keeps its Budget when the formula would give it none this month, or when its share rounds to $0, because no Category gets a $0 Budget this way; the total can then stay above T.

**Example.** B_GS = $1,120. Groceries averages $600 and Superstores $400, so history is $1,000 × 1.10 = $1,100. T = $1,100. r = 60%. Groceries = $660; Superstores = $440. If history had been $1,500, T = $1,120: Groceries $672, Superstores $448.

### Shopping, Transportation, Health and care, Leisure: Categories with a Benchmark

This covers Clothing, Home and garden, Alcohol and tobacco, Gas, Car, Transit and rideshare, Health, Personal care, Childcare, Pets, Fitness, Restaurants, Entertainment, Hobbies, and Books and education.

**Rule:** Budget(c, m) = max(K(c, m), Y(c, m) + min(B(c), A_flex(c) × 1.10))

- With n < 3, use B(c) in place of min(B(c), A_flex(c) × 1.10).
- The floor K keeps a fixed cost from being Over Budget every month.

**Examples:**

- Restaurants: B = $300, A_flex = $450, K = $0. Budget = $300.
- Clothing: B = $150, A_flex = $100, K = $0. $100 × 1.10 = $110, below the Benchmark. Budget = $110.
- Fitness: B = $40, A_flex = $60. The gym is a $50 monthly Recurring charge, so K = $50. Budget = $50.
- Car in March: B = $300, A_flex = $500. An untracked car loan is a $400 monthly Recurring charge. Registration is a $240 yearly Recurring charge, due in March. K = $640. Y + min = $240 + $300 = $540. Budget = $640.

### Shopping and Other: Categories with no good Benchmark

This covers General goods, Services, Cash, Payments to people, and Miscellaneous.

**Rule:** Budget(c, m) = max(K(c, m), Y(c, m) + A_flex(c) × 1.10). It needs n ≥ 3.

**Example.** General goods: A_flex = $250 and K = $0. Budget = $275.

### Leisure and Other: Travel, and Gifts and donations (yearly)

**Rule:** yearly Budget(c) = A(c) × 1.10 × 12. It needs n ≥ 3.

**Example.** Travel Spending in the last 12 months is $4,800. The yearly Budget is $5,280. With 6 months of history and $1,800 spent, it is $300 × 1.10 × 12 = $3,960.

### The total must fit

- The draft's monthly total is the sum of:
  - every monthly Budget for m, with each yearly Recurring charge counted as 1/12 of its amount instead of in its due month;
  - every yearly Budget ÷ 12.
- If the total is at or below I, nothing is cut.
- Otherwise the gap G = the total − I. The app cuts in two steps, in this order:
  1. the Leisure group, including Travel at 1/12 of its yearly Budget;
  2. the Shopping group, except Groceries and Superstores.
- **Room:** each Category's room = its draft − the larger of 50% of its draft and K. A yearly Budget has no K.
- **Cut:** in each step, f = the lower of 1 and G ÷ the step's total room. Each Category drops by f × its room. G drops by the step's cut.
- If G is still above $0 after both steps, the draft stays as cut. Its note says the fixed costs pass steady Income.
- The app never cuts Bills, Interest and fees, Groceries, Superstores, Transportation, Health and care, or Other.

**Example.** I = $6,000. The draft's monthly total is $6,200, so G = $200. Leisure holds Restaurants at $400 (room $200). It also holds Travel at $4,800 a year, or $400 a month (room $200). f = $200 ÷ $400 = 0.5. Restaurants becomes $300. Travel becomes $300 a month, or $3,600 a year.

### The AI's part in a draft

- With an AI provider, Budget tailoring adjusts flexible Budgets for active Goals. It gives a short reason per Category.
- It points out any Category with no good Benchmark whose Budget looks high.
- It never changes a Bills Budget or the Interest and fees Budget.
- An AI figure stays within 50% of the formula's figure.
- The first draft applies the AI's figures at once, with no Proposal. Later drafts are Proposals ([Changing Budgets](#changing-budgets)).
- Budget tailoring receives what [AI](08-ai.md) lists for it, plus the formula's figures and the CE note on Housing and Car. It never receives the ZIP code or the ages.
- Without an AI provider, or when the AI fails, the draft is the formula's figures, with no reasons.

Sources: [Budget drafting and Goals](https://github.com/therecluse26/family-finance-tracker-private/issues/15), [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14), [Manually tracked debts](https://github.com/therecluse26/family-finance-tracker-private/issues/18).

## Yearly Budgets

- Travel and Gifts and donations have yearly Budgets, over the calendar year, January 1 to December 31. Every other Budget is monthly.
- The year's Spending counts from January 1, including Spending before the first draft.
- Yearly Budgets never show On pace, anywhere: not on the dashboard, in the Monthly review, or in Alerts.
- They show the year's Spending, the yearly Budget, and how much of the year has passed. The share of the year = day of the year ÷ days in the year.
- Their only Overspending state is Over Budget: the year's Spending has passed the yearly Budget.
- An edit or an accepted change to a yearly Budget applies to the whole current year.
- On January 1, the yearly Budget keeps its amount. Money left over does not carry into the new year.

## Stored Budgets

- Each Budget record holds: the Category, the amount, monthly or yearly, the month or year it takes effect, its source (formula, AI draft, Member edit, or Proposal), and who set it. A Bills Budget also holds its pinned flag.
- The app stores each Bills Budget per month, when it computes it on the 1st.
- A month uses the Budget in effect that month. A past month keeps its Budget when a later Budget changes.
- There is no Budget line before the first draft's month.
- There is no rollover: money left in a Budget does not carry into the next month.

## Changing Budgets

- Bills Budgets keep following the Recurring charges, unless pinned.
- A Member may edit any Budget at any time. The edit takes effect in the current month.
- Otherwise, a flexible Budget changes only when a Member accepts a Proposal.
- Proposals need an AI provider. Without one, flexible Budgets change only by a Member's edit.

### Which Proposals exist

Each row except Chat and the Monthly review is a Budget tailoring run ([AI](08-ai.md)).

| Proposal | When the app makes it | What it proposes |
|---|---|---|
| Goal Budget change | A Goal is added, or a Member edits its words | Budget changes for the flexible Categories the Goal touches |
| Goal amount | A "spend less" Goal, always. A "save toward an amount" Goal whose reading has no change. | The Goal amount ([Goals](#goals)) |
| Income redraft | I differs by more than 10% from the I behind the current Budgets | A redraft at the new I |
| Benchmark redraft | The first run of a release whose CE data year is newer than the one behind the current Budgets. At most once a year. | A redraft with the new Benchmarks |
| New bank redraft | A Connection added after the first draft finishes its history load, and any Category's 12-month average moves more than 10% ([Accounts and bank sync](02-accounts-and-bank-sync.md#a-bank-added-later)) | A redraft with the new history |
| Facts redraft | A Member edits the Household facts | A redraft with the new Benchmarks |
| Tailoring | An AI provider is set up after the first draft | One Proposal: the AI adjusts the current Budgets for Goals, with a reason per Category |
| Chat | A Member asks in Chat | A new monthly Budget for one Category, or a new Goal ([AI](08-ai.md#proposals)) |
| Monthly review | The review is written on the 1st | Budget changes to consider ([AI](08-ai.md#monthly-review)) |

- A Goal whose target is not a Category, such as Saving, a Merchant, or a loan, may change any flexible Category in its Goal Budget change.
- **A redraft** runs the full draft for flexible Categories: the formulas, the "must fit" step, and the AI's part. It makes one Proposal. The Proposal lists each Category whose figure differs from its current Budget by 5% or more. If none differs, there is no Proposal.
- The app records the inputs behind the current Budgets: I and the CE data year. The first draft records them.
- Guardrails, expiry, replacement, and where Proposals appear are in [AI](08-ai.md#proposals).

### What accepting a Proposal changes

- **Budget changes:** each new Budget takes effect in the current month, with the source "Proposal". Edit lets a Member change any figure before accepting.
- **A redraft:** accepting also records its inputs as the ones behind the current Budgets.
- **Skip, or expiry, of a redraft:** no Budget changes. The app still records the redraft's inputs, so the same trigger does not repeat.
- **Goal amount:** the Goal amount is set. Progress starts that day.
- **New Goal (from Chat):** an active Goal is created. The accepting Member is its author.

## Goals

A Goal is a plain-English statement of intent by a Member. It steers the AI's advice and its proposed Budget changes.

### What the app stores

- The Member's own words, the author, the date, and a status: active, done, or dropped.
- The AI's reading ([AI](08-ai.md)). Members see it on the Goals page. It has three fields, each empty when the words do not say:
  - the target: a Category, a Merchant, Saving or one or more Accounts, or a loan;
  - the change: an amount or a percent;
  - the deadline.
- The Goal amount: the number progress counts toward ([Progress](#progress)).

### Rules

- Goals need an AI provider. Without one, Members cannot add a Goal. Existing Goals keep their reading, and the app still computes their progress.
- On a new Goal, or new words, the AI reads it. The app then makes the Goal Proposals at once. The Member accepts, edits, or skips them.
- A Member may edit the words, mark a Goal done, or mark it dropped. The AI cannot edit or delete a Goal.
- Every active Goal goes into each Insight card, Alert, Monthly review, and Chat ([AI](08-ai.md)).
- Done and dropped Goals leave the AI's context.
- A reading with no target still steers the AI. That Goal shows no progress.

### Progress

The app computes every number. The AI never does. The target sets the kind of Goal.

| Kind | Target | Goal amount | Percentage | On track when | Done when |
|---|---|---|---|---|---|
| Spend less | A Category or a Merchant | A monthly amount: the baseline minus the change. Always a Proposal; empty until a Member accepts it. | (baseline − P) ÷ (baseline − Goal amount) | P ≤ Goal amount | A complete calendar month ends at or under the Goal amount |
| Save toward an amount | Saving, or one or more Accounts | A balance: the start balance plus the change | (balance − start) ÷ (Goal amount − start) | Balance ≥ the straight line | Balance ≥ Goal amount |
| Pay down a loan | One tracked loan | Principal to pay: the change. With no change, the whole balance at the start. | Principal paid since the start ÷ Goal amount | Principal paid ≥ the straight line | Principal paid ≥ Goal amount, or the loan's balance reaches $0 |

- **Baseline:** Spending on that Category or Merchant in the 3 complete calendar months before the Goal's date, ÷ 3.
- **A percent change** applies to the baseline, the start balance, or the loan's balance at the start.
- **No change:** for a spend less or save Goal, the AI proposes the Goal amount in the Goal's Budget tailoring run. A spend less amount comes from the baseline.
- **P:** this month's projected Spending for that Category or Merchant, by the projection in [Anomalies and Alerts](06-anomalies-and-alerts.md#the-projection).
- **Start:** the day the Goal amount takes effect. That is the Goal's date, or the day a Member accepts the Goal amount Proposal. "Start" also means the balance or principal on that day.
- **Balance:** the sum of the named Accounts' balances. An Unconnected account uses its balance estimate. With Saving as the target, the balance is Saving since the start, from $0.
- **The straight line** on a given day = start + (Goal amount − start) × days since the start ÷ days from the start to the deadline.
- With no deadline, a save or loan Goal shows the percentage only, with no On track or Behind.
- When On track is false, the Goal is Behind.
- The percentage is a whole number from 0% to 100%.
- A Goal whose money sits in an Unconnected account shows "estimated" ([Accounts and bank sync](02-accounts-and-bank-sync.md#balance-estimate)).

**The detail line** under each Goal:

| Kind | Detail line |
|---|---|
| Spend less | "On pace for $P this month; Goal is $G" |
| Save toward an amount | "$balance of $G; $X ahead of pace" or "$X behind pace" |
| Pay down a loan | "$paid of $G paid; $X ahead of pace" or "$X behind pace" |
| Any, before its Goal amount is set | "Goal amount not set yet" |

**Examples:**

- **Spend less:** "I want to spend 20% less on restaurants." The baseline is $600. The Goal amount Proposal is $480, and a Member accepts it. On October 15, P = $540. The Goal is Behind, at (600 − 540) ÷ (600 − 480) = 50%.
- **Save toward an amount:** "Save $10,000 for a house by December 31, 2027." On January 1, 2027, the account holds $2,000, so the Goal amount is $12,000. On July 2, the straight line is $7,000. The balance is $8,000: On track, at 60%.
- **Pay down a loan:** "Pay off the car loan by the end of 2027." The balance on January 1, 2027 is $12,000. By July 2, $5,000 of principal is paid; the straight line is $6,000. The Goal is Behind, at 42%.

### Done

- The app sets a Goal to done when it meets its "Done when" rule. It checks every active Goal in each follow-up job and on the 1st, Household time. So a Goal is done on the day of the first check that finds its rule met, not on the day a Member opens the Goals list.
- A done Goal shows "Done" for one month. Then it moves to the done list.
- A passed deadline does not end a Goal. It stays active and shows Behind until it is done or a Member drops it.

## Sources

- [Budget drafting and Goals](https://github.com/therecluse26/family-finance-tracker-private/issues/15)
- [Free public US spending benchmarks](https://github.com/therecluse26/family-finance-tracker-private/issues/6)
- [Hands-off categorization](https://github.com/therecluse26/family-finance-tracker-private/issues/14)
- [Manually tracked debts](https://github.com/therecluse26/family-finance-tracker-private/issues/18)
- [Anomalies and Alerts](https://github.com/therecluse26/family-finance-tracker-private/issues/16)
- [Dashboard and graphs](https://github.com/therecluse26/family-finance-tracker-private/issues/9)
- [Monthly review, Insight cards, and Chat](https://github.com/therecluse26/family-finance-tracker-private/issues/17)
- [Bank sync interface](https://github.com/therecluse26/family-finance-tracker-private/issues/19)
- [Install and first-run setup](https://github.com/therecluse26/family-finance-tracker-private/issues/21)
- [Software license](https://github.com/therecluse26/family-finance-tracker-private/issues/23)
- Research: [Free public US spending benchmarks](https://github.com/therecluse26/family-finance-tracker-private/blob/research/spending-benchmarks/docs/research/spending-benchmarks.md) (branch `research/spending-benchmarks`)
- Research: [Transaction categorization](https://github.com/therecluse26/family-finance-tracker-private/blob/research/transaction-categorization/docs/research/transaction-categorization.md), section 7 (branch `research/transaction-categorization`)
