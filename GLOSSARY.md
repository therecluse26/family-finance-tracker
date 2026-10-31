# Family Finance Tracker

A self-hosted, read-only tracker for one household's personal finances. It pulls transactions from US banks and cards, separates real spending from money moving between the household's own accounts, and gives analysis and AI-driven advice with no manual upkeep.

## People

**Household**:
The group of people whose finances one instance tracks. One instance serves exactly one Household.
_Avoid_: Family, tenant, organization

**Member**:
A person in the Household who has a login. Every Member sees all of the Household's data and has the same powers; there are no roles.
_Avoid_: User, account holder

## Accounts and money movement

**Account**:
A bank account, credit card, or loan that belongs to the Household.
_Avoid_: Login, user account

**Unconnected account**:
An Account the Household owns but does not sync, such as an HSA. Money sent to it counts as a Transfer.
_Avoid_: External account, manual account

**Transaction**:
One movement of money on one Account, as the bank reports it.
_Avoid_: Entry, activity, charge

**Transfer**:
Money that moves between two of the Household's own Accounts, including a credit card bill payment. Never counts as Spending or Income.
_Avoid_: Internal transfer, linked pair

**Spending**:
Money that leaves the Household for goods or services. Refunds and Reimbursements reduce it.
_Avoid_: Expense, outflow

**Income**:
Money that enters the Household from outside, such as a paycheck. Refunds and Reimbursements are not Income.
_Avoid_: Inflow, deposit

**Saving**:
Money moved from an Account into an investment or retirement account. Not Spending.
_Avoid_: Contribution

**Refund**:
Money a merchant returns for an earlier purchase. It reduces Spending in that purchase's category.
_Avoid_: Return, credit

**Reimbursement**:
Money a person outside the Household pays back for shared Spending, such as a split dinner. It reduces that Spending.
_Avoid_: Payback, repayment

## Targets and warnings

**Category**:
A label for what Spending paid for, such as Restaurants or Interest and fees.
_Avoid_: Tag, bucket, type

**Budget**:
A monthly Spending limit for one Category. The AI drafts it and a Member accepts or edits it.
_Avoid_: Limit, target, envelope

**Goal**:
A plain-English statement of intent by a Member, such as "I want to spend less on restaurants". It steers the AI's advice and its proposed Budget changes.
_Avoid_: Resolution, rule, objective

**Overspending**:
Spending in a Category above its Budget, or on pace to pass it. The Budget is the only baseline.
_Avoid_: Over budget, excess

**Anomaly**:
A Transaction or pattern that is unusual against the Household's own history, such as a duplicate charge or a subscription price increase.
_Avoid_: Outlier, unusual activity

**Alert**:
A notice sent to Members' phones or email about Overspending or an Anomaly.
_Avoid_: Notification, warning

## Outside services

**Bank-data provider**:
A third-party service that connects to many banks and returns their Transactions, such as Plaid.
_Avoid_: Aggregator, connector

**AI provider**:
A service that runs an AI model with the Household's own API key, such as OpenAI or Anthropic.
_Avoid_: LLM vendor, model host

## AI output

**Monthly review**:
A written AI report on the past month's overspending and practical ways to save.
_Avoid_: Monthly report, summary

**Insight card**:
A short AI finding shown on the dashboard and refreshed after each sync.
_Avoid_: Tip, widget

**Chat**:
A conversation where a Member asks the AI questions about the Household's money.
_Avoid_: Assistant, Q&A
