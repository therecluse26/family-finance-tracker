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

**Connection**:
One link to one bank, through one Bank-data provider. It brings in one or more Accounts. A bank has at most one Connection.
_Avoid_: Item, link, enrollment, login

**Unconnected account**:
An Account that holds the Household's money but does not sync, such as an HSA. Money sent to it counts as a Transfer, or as Saving when it is an investment or retirement account. A loan is never an Unconnected account, and neither is a payment app such as Venmo.
_Avoid_: External account, manual account

**Manual loan**:
A loan that a Member enters by hand, because no Bank-data provider syncs it. The app finds its payments and lowers its balance by itself.
_Avoid_: Manual debt, offline loan

**Cash loan**:
A loan whose money lands in one of the Household's Accounts, such as a personal loan. Its principal payments are Transfers.
_Avoid_: Personal loan, cash advance

**Purchase loan**:
A loan whose lender pays the seller directly, such as a car loan or a mortgage. Its principal payments are Spending.
_Avoid_: Financing, secured loan

**Transaction**:
One movement of money on one Account, as the bank reports it.
_Avoid_: Entry, activity, charge

**Merchant**:
The business or person on the other side of a Transaction, under a clean name, such as Starbucks.
_Avoid_: Payee, vendor, counterparty

**Masked Merchant**:
A Merchant whose bank line shows a card service, not the shop, such as Privacy.com.
_Avoid_: Hidden merchant, proxy merchant

**Transfer**:
Money that moves between two of the Household's own Accounts, including a credit card bill payment. Never counts as Spending or Income.
_Avoid_: Internal transfer, linked pair

**Spending**:
Money that leaves the Household for goods or services. Cash withdrawals, loan interest, and principal payments on a Purchase loan count as Spending. Refunds and Reimbursements reduce it.
_Avoid_: Expense, outflow

**Income**:
Money that enters the Household from outside, such as a paycheck. Card rewards count as Income. Refunds, Reimbursements, and money borrowed from a loan are not Income.
_Avoid_: Inflow, deposit

**Saving**:
Money moved from an Account into an investment or retirement account. Not Spending. Money taken back out of such an account reduces Saving.
_Avoid_: Contribution

**Refund**:
Money a merchant returns for an earlier purchase. It reduces Spending in that purchase's Category and month. An unlinked Refund reduces its Merchant's Category, in the month it arrives.
_Avoid_: Return, credit

**Reimbursement**:
Money a person outside the Household pays back for shared Spending, such as a split dinner. It reduces that Spending, in that Spending's month.
_Avoid_: Payback, repayment

## Categories

**Category**:
A label for what Spending paid for, such as Restaurants or Interest and fees. When the app cannot see what Spending paid for, the Category says where it went, such as Superstores or Cash. Only Spending has a Category. A Refund or Reimbursement takes the Category of the Spending it reduces.
_Avoid_: Tag, bucket, type

**Category group**:
A named set of Categories, such as Bills or Leisure, for seeing Spending at a high level. Each Category belongs to exactly one Category group.
_Avoid_: Super-category, parent category

**Category rule**:
A rule that gives every Transaction with one Merchant the same Category. A Member's correction creates it. It covers past and future Transactions, except those a Member set by hand.
_Avoid_: Payee rule, auto-rule, filter

**Line item**:
One product on a store order, such as one product on an Amazon order. It links to the Transaction that paid for it, and has its own Category.
_Avoid_: Order item, product line, receipt line

**Item rule**:
A rule that gives every Line item of one product the same Category. A Member's correction of a Line item creates it. It covers past and future Line items, except those a Member set by hand.
_Avoid_: Product rule, ASIN rule

## Targets and warnings

**Budget**:
A Spending limit for one Category, per month, or per year for Travel and Gifts and donations. The app drafts it, and a Member may edit it. Money left over does not carry into the next month.
_Avoid_: Limit, target, envelope

**Benchmark**:
Typical Spending for a Category by similar US households, from public data. It is a reference for drafting Budgets, never a Budget itself.
_Avoid_: Average, norm, standard

**Goal**:
A plain-English statement of intent by a Member, such as "I want to spend less on restaurants". It steers the AI's advice and its proposed Budget changes.
_Avoid_: Resolution, rule, objective

**Overspending**:
Spending in a Category above its Budget, or on pace to pass it. The Budget is the only baseline. It has two states: Over Budget, when Spending has passed the Budget, and On pace, when Spending is on course to pass it.
_Avoid_: Excess

**Recurring charge**:
Spending with one Merchant that repeats at a steady interval and a similar amount, such as a subscription or a utility bill. A shop the Household visits often, such as a weekly grocery store, never forms one. A Member may give one a name, a Category, a price band and price changes, and add or remove its Transactions. The app keeps each edit.
_Avoid_: Subscription, bill

**Anomaly**:
A Transaction or pattern that is unusual against the Household's own history, such as a duplicate charge or a subscription price increase.
_Avoid_: Outlier, unusual activity

**Alert**:
A notice sent to Members' phones or email about Overspending or an Anomaly.
_Avoid_: Notification, warning

**System notice**:
A notice to Members about the app itself, such as a failed backup or the AI cost cap. It is never about the Household's Spending.
_Avoid_: Error, warning

**Weekly summary email**:
A short email each Sunday morning about the Household's last 7 days, which each Member turns on for themselves. The app writes it from its own numbers, with no AI. It is not an Alert.
_Avoid_: Digest, newsletter, weekly report

## Review

**Review list**:
An optional list of the app's uncertain decisions, and things it cannot settle alone, such as a guessed Transfer or a missing loan payment. A Member may check it; nothing waits for it.
_Avoid_: Inbox, queue, triage

## Security

**Master key**:
The secret that locks the other secrets the app stores, such as bank and AI keys. The Household keeps a copy outside the app. Without it, every Connection must be made again.
_Avoid_: Encryption key, recovery key, password

## Outside services

**Bank-data provider**:
A third-party service that connects to many banks and returns their Transactions, such as Plaid.
_Avoid_: Aggregator, connector

**AI provider**:
A service that runs an AI model with the Household's own API key, such as OpenAI or Anthropic.
_Avoid_: LLM vendor, model host

**AI cost cap**:
The most the Household lets the app spend on its AI provider in one calendar month. When the app reaches it, background AI stops until the 1st.
_Avoid_: AI budget, spending limit, quota

**Model tier**:
One of the three kinds of model the app calls at the AI provider, each with its own model: the Quick tier makes the small choices during sync, the Writer tier writes the Insight cards, the Monthly review and Budget tailoring, and the Chat tier answers Chat.
_Avoid_: Model class, model level

## AI output

**Monthly review**:
An AI report, written on the 1st, on the past month's Habits, overspending, and practical ways to save. It never changes once written.
_Avoid_: Monthly report, summary

**Insight card**:
A short AI finding in the dashboard's AI box, rewritten at most once a day, after 6 AM, when new posted Transactions have arrived since the last run.
_Avoid_: Tip, widget

**Chat**:
A conversation where a Member asks the AI questions about the Household's money. Every Member can see every Chat.
_Avoid_: Assistant, Q&A

**Habit**:
A repeated behavior the AI notices in the Household's Spending, named in plain words, such as "Takeout fills the busy nights".
_Avoid_: Pattern, trend

**Proposal**:
A change the AI suggests, such as a new Budget amount or a new Goal. Nothing changes until a Member accepts it.
_Avoid_: Suggestion, recommendation

## Deal finder (after v1)

**Store**:
A chain the deal finder reads prices from, such as Walmart, Aldi, or a local chain in the weekly ads. A Store is not a Merchant: a Merchant is the business on a Transaction.
_Avoid_: Retailer, shop, vendor

**Home store**:
The one location of a Store whose prices the deal finder uses, such as the nearest Kroger.
_Avoid_: Branch, local store

**Product**:
One thing a Store sells, with its own price and size, such as "Jif Creamy Peanut Butter, 16 oz" at Walmart. A Line item is a Product a Member already bought.
_Avoid_: SKU, listing, offer

**Shopping list**:
The Household's one list of things to buy. Every Member sees it and can change it.
_Avoid_: Grocery list, cart

**List item**:
One thing on the Shopping list, in plain words with a quantity, such as "2 lb ground beef". It names no Store and no brand unless a Member locks one.
_Avoid_: Entry, need

**Deal**:
A price below a Product's regular price for a limited time, such as a promo price, a weekly-ad item, or a coupon.
_Avoid_: Discount, special

**Shopping plan**:
The deal finder's answer: which Store gets each List item, at what price, in how many trips. App code builds it, never the AI.
_Avoid_: Route, basket

**Price source**:
A service the deal finder reads Store data from: the Household's Scraping service, a Store's own free API such as Kroger's, or Open Food Facts.
_Avoid_: Connection, feed, integration

**Scraping service**:
A third-party service that reads Store web pages for the app, such as Apify. A Household uses at most one.
_Avoid_: Proxy, unblocker, scraper API
