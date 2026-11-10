# Line items and Amazon orders

A Line item is one product on a store order, such as "Brawny paper towels, 12 rolls". The first source is Amazon: a Member uploads Amazon's order history file, and the app links each shipment's Line items to the card Transaction that paid for it. Each Line item gets a Category. When a Transaction's Line items have more than one Category, the app splits the Transaction into Category parts, so Budgets, reports and every other total count each product in its own Category (owner decisions, 2026-11-09).

Using this is never required. A Household that never uploads a file sees no change.

## Rules that stay in force

- The bank's Transaction stays as the bank reports it. Line items never change its amount, date, Account or Merchant.
- Totals still come from posted Transactions and their parts ([Categorization](04-categorization.md#splits)). Line items add no new money math: they only make split parts.
- A Member's own choice always wins: a hand-set Category, a hand split, and a hand-set type each stay as the Member set them.
- The app never signs in to Amazon. It reads only the file a Member uploads (owner decision, 2026-11-09).

## Getting the file

- The Amazon page in Settings shows these steps:
  1. On amazon.com, open **Account & Lists → Your Account → Request Your Data**.
  2. Pick **Your Orders**, then **Submit Request**.
  3. Confirm the request from Amazon's email.
  4. When Amazon's second email arrives, download the ZIP file.
  5. Upload the ZIP file here, as it is.
- Amazon usually takes a few hours to a few days. A Member may upload a newer file at any time.

## Reading the file

- The upload is the ZIP file from Amazon, or the order history CSV file inside it.
- The app reads only Amazon's retail order history file. It ignores every other file in the ZIP, and never opens one. The ZIP also holds digital orders, returns, cart history and delivery photos. Those are not read in this version.
- The parser names each column it needs. A file whose header lacks a needed column is refused, and the message names the missing column. A file with extra columns is read.
- Limits, checked before any row is stored:
  - The upload is at most 50 MB.
  - A ZIP is read entry by entry. Its unpacked size is at most 200 MB, and it holds at most 500 entries.
  - A CSV file has at most 200,000 rows.
  - An entry name is checked as stored in the ZIP. A name with `..`, a leading `/`, or a control character is skipped.
- Only amazon.com rows in US dollars are read. Other rows are counted as skipped.
- Cancelled rows and rows with no ship date are skipped. A later file may bring the row again, once it has shipped.

### The order file

These facts come from a real export of 2026-11-09. Only file names, column names and the shapes of values were read. Tests use made-up rows in this form.

- The entry is `Your Amazon Orders/Order History.csv`. The parser finds it by the file name `Order History.csv`, at any folder depth.
- It is UTF-8 with a byte order mark, comma-separated, with `"` quotes. A quoted field may hold a line break.
- It has a header row and one row per product per shipment. Every row has the same number of fields.
- `Not Available` stands for an empty value in every column.

| Column | What the app does with it |
|---|---|
| `Website` | Reads the row only when it is `Amazon.com`. Other values, such as `Audible` and `CBA`, are skipped. |
| `Order ID` | The order ID, in the form `123-1234567-1234567`. |
| `Order Date` | The order date. |
| `Ship Date` | The ship date. `Not Available` means not shipped: the row is skipped. |
| `Order Status` | `Cancelled` rows are skipped. `Closed` rows are read. |
| `Currency` | Reads the row only when it is `USD`. |
| `ASIN` | The product ID. Every row in the export had one, 10 letters and digits. |
| `Product Name` | The name. It can be 300 characters long and hold any character. |
| `Original Quantity` | The quantity. |
| `Unit Price`, `Unit Price Tax` | The unit price and its tax. |
| `Shipping Charge`, `Total Discounts` | Kept, to show on the detail view. |
| `Total Amount` | The Line item's total. |
| `Payment Method Type` | Only the card's last 4 digits are kept ([The app's link](#the-apps-link)). |

- **Dates.** A date is an ISO 8601 time in UTC, such as `2026-05-01T14:03:22Z` or `2026-05-01T14:03:22.123Z`. The app turns it into a day in the Household's time zone. It also keeps the ship time in UTC, to the second, for the row's key and its shipment. An impossible date, such as February 30, or a time more than 1 day in the future refuses the row, and the skip count names the column.
- **Amounts.** An amount is in dollars, such as `12.5`, `7`, or `1,234.56`. A negative amount is in single quotes, such as `'-3.20'`. The parser removes the quotes and the commas, and reads it to the cent with no floating point. Any other form refuses the row, and the skip count names the column. `Not Available` in `Unit Price Tax`, `Shipping Charge` or `Total Discounts` counts as $0.00. In `Unit Price` or `Total Amount` it refuses the row.
- **Total check.** For each row, `Total Amount` equals `Original Quantity` × (`Unit Price` + `Unit Price Tax`) + `Shipping Charge` + `Total Discounts`. This held for every shipped row of the export. A row that fails it is skipped, and counted as "amounts do not add up".
- **Columns never read.** The app never reads or stores the addresses, the gift columns, the carrier and tracking number, the serial number, or any other column not in the table above.
- The app keeps no copy of the uploaded file. It keeps only the Line items it reads.
- **A refused file.** A file that is not a ZIP or CSV file, a ZIP file without `Order History.csv`, or one with two of them, is refused, and nothing is stored. So is a ZIP file that is damaged, encrypted, split into parts, in ZIP64 form, or over a limit. The message says which, and names no row's content.
- One import or one delete runs at a time. A second upload while one runs is refused, and the Member may try again.
- No row's content goes into a log line or an error. A log line names the row number and the column only.

### Each Line item holds

| Field | From |
|---|---|
| Source | `amazon` |
| Order ID and order date | The file |
| Ship date | The file |
| Product ID | Amazon's ASIN, when the row has one |
| Name | The product name, as the file gives it |
| Quantity, unit price, tax | The file |
| Shipping charge and discounts | The file |
| Total | The amount the row says was owed for it, tax included |
| Card's last 4 digits | The file's payment method, when it names a card |
| Category, with its source | [Categories of Line items](#categories-of-line-items) |
| Linked Transaction, with the link kind (app or hand) | [Linking](#linking-line-items-to-transactions) |

### Importing the same orders again

- Amazon's files overlap. Each row has a key: the order ID, the product ID (or the name, when there is no product ID), the ship date and time, and the row's place among identical rows of that order.
- A row whose key is already stored updates that Line item's file fields. Its Category and its link stay.
- A stored Line item missing from a newer file stays. A file may cover a shorter time.
- Importing the same file twice changes nothing.

## Linking Line items to Transactions

Amazon charges a card when it ships, not when the order is placed. So the app links by **shipment**: the Line items of one order with the same ship date and time, to the second.

- In the export, rows with the same order ID and ship time always shared one shipment subtotal, equal to their items' prices. Rows with the same order ID and ship day did not always. So the ship day alone is not a shipment.
- A shipment's total is the sum of its Line items' totals.

### The app's link

- The app tries each unlinked shipment against Spending Transactions that are:
  - posted, not hidden, and not removed;
  - Amazon's, by Merchant [Identity](04-categorization.md#identity), or with `AMAZON` or `AMZN` in the bank description;
  - for exactly the shipment's total, to the cent;
  - with a purchase date from 1 day before to 7 days after the ship date;
  - on an Account whose last 4 digits match the shipment's card, when the shipment names a card and some Account in the Household has those digits. When no Account has them, this filter does not apply.
- When no shipment of an order fits alone, the app tries the whole order's total the same way. Amazon sometimes charges an order once.
- Exactly one Transaction fits, and it has no Line items yet: the app links the shipment to it.
- Two or more Transactions fit: the app links nothing, and puts a Review list item up ([Review list items](#review-list-items)).
- No Transaction fits: the shipment waits. The app tries again after each sync, until 60 days after the ship date. After that, it counts as "not matched".
  - A gift card, points, or a promotion often changes the amount charged. Such a shipment usually ends as "not matched". A Member may link it by hand.
  - A payment method that names a gift card means the card charge is less than the total. The app does not try such a shipment. It counts as "paid in part by gift card", and a Member may link it by hand.
- Linking runs after each import, and in each sync's follow-up job, after the cascade.
- A Transaction holds the Line items of one order at most.

### Hand links

- On a Spending Transaction's detail view, **Link Amazon items** lists the unlinked shipments with an order date from 30 days before to 3 days after the Transaction's purchase date. A Member picks one.
- A hand link may join a shipment to a Transaction with a different amount. The parts still add up to the Transaction's amount ([Splits from Line items](#splits-from-line-items)).
- **Undo** on the detail view removes a link, app or hand. The app never links that shipment to that Transaction again.

### When the bank changes the Transaction

- The bank removes it, or hides it: its Line items become unlinked, and the app tries them again.
- The bank changes its amount:
  - An app link whose totals no longer match ends, and the app tries again.
  - A hand link stays. The parts scale, as for every split.
- A pending Transaction has no links. Its posted copy is linked as above.

## Categories of Line items

Each Line item takes the first answer it gets, in this order:

| Step | Source | It answers when |
|---|---|---|
| 1 | Hand-set | A Member set this Line item's Category by hand. |
| 2 | Item rule | An Item rule matches the product. |
| 3 | AI | An AI provider is set up and available. Its answer always applies. |
| 4 | The Transaction's Category | No AI is available. The Line item takes the Category its Transaction would get without Line items. An unlinked Line item takes Miscellaneous. |

- **Step 3.** The AI gets each Line item's name, quantity and price, and the store name. It answers with one Category from the fixed list and a confidence: high, medium or low ([AI](08-ai.md#every-ai-use)).
  - At "low", the Line item also goes on the Review list.
  - At "medium", the Category counts as decided. The Line item shows an "AI unsure" tag.
- **Step 4.** These Line items are marked. When AI is available again, the app sends each marked Line item to the AI once, as for Transactions ([AI](08-ai.md#redo-of-no-ai-work)).
  - When every Line item of a Transaction took step 4, the Transaction keeps its own Category and has no split, even when that Category is Superstores and the Line items show Miscellaneous. A split into Miscellaneous would say less than Superstores. The AI's later answers make the split.
  - The Transaction's Category is the one cascade steps 2 to 6 give it. A Line item linked to a Transaction with no Category yet waits for it.
  - When that Category is Superstores, Cash or Payments to people, the Line item takes Miscellaneous.
  - While the AI waits to try again after an error, the Line items and their Transaction wait too. After the last retry, they take step 4 ([AI](08-ai.md#every-ai-use)).
- A Line item with no Transaction gets its Category soon after the import, in the background, and the import does not wait for it.
- The app stores which step chose each Line item's Category, and how confident it was.
- A Line item never takes Superstores, Cash or Payments to people. Those Categories say where money went when the app cannot see what it paid for, and a Line item shows that. They are not offered, and an AI answer of one of them counts as "low" with Miscellaneous.

### Item rules

- When a Member changes a Line item's Category, the app makes an Item rule for that product. The changed Line item itself counts as hand-set.
- The rule covers the product's past and future Line items, except those a Member set by hand.
- The Member may pick "only this item" instead. Then the app makes no rule.
- Accepting a guess on the Review list also makes an Item rule.
- A product is its product ID. When the rule or the Line item has no product ID, it matches by clean name: the name in lower case, with punctuation removed and spaces joined.
  - Each size or pack of a product has its own product ID. A rule on "12 rolls" does not cover "6 rolls".
- Each product has at most one rule. A newer correction replaces the older rule.
- Settings lists every Item rule, under Categories, with Delete. Deleting a rule sends its Line items not set by hand down the steps again.
- When a rule is made, changed or deleted, the app changes every matching Line item in one batch. It then remakes the parts of every Transaction it changed, in one batch ([Splits from Line items](#splits-from-line-items)).

## Splits from Line items

- A Spending Transaction with linked Line items takes its Category from them, at a new cascade step ([Categorization](04-categorization.md#the-categorization-cascade)):
  - All its Line items have one Category: the Transaction takes that Category. It has no split.
  - Its Line items have two or more Categories: the app splits the Transaction into one part per Category.
- **Part amounts.** Each part's share of the Transaction's amount is in proportion to its Line items' totals.
  - The app rounds each part to the cent. It gives the leftover cents to the parts with the largest remainders, so the parts always add up to the Transaction's amount.
  - Example: a $65.40 charge pays for $40.00 of groceries and $20.00 of household goods, plus tax and shipping. The parts are $43.60 Groceries and $21.80 Home and garden.
  - So tax, shipping, a promotion and gift card money spread over the parts with no separate rule.
- The detail view marks these parts "from Amazon items". The Transactions page shows "split" on the row, as for a hand split.
- The app remakes the parts when a link changes, when a linked Line item's Category changes, and when the bank changes the amount.
- **The Member wins.**
  - A hand-set Category on the Transaction wins over its Line items. It has no split.
  - A hand split wins. The app never changes it. Its Line items keep their own Categories, which then change no total.
  - When the Member removes the hand split, the Transaction goes back to the cascade, and its Line items answer again.
- A split from Line items makes no Category rule.
- Refunds and Reimbursements reduce the parts in proportion, as for every split ([Categorization](04-categorization.md#splits)).
- Only Spending Transactions take parts. A Transaction a Member made Income, a Transfer or Saving keeps its Line items, unused.

## Review list items

| Item | Why it is there | What a Member's answer does |
|---|---|---|
| An Amazon shipment that fits two or more Transactions | The app could not tell which Transaction paid for it | Picking one makes a hand link. "None of these" leaves it unlinked, and the app never offers those Transactions for it again. |
| A Line item Category the AI chose with confidence "low" | The AI was unsure | Accepting makes an Item rule. Picking another Category is a correction, and makes a rule unless the Member picks "only this item". |

- Line item Category items group into one card per product, as Category items group per Merchant ([Categorization](04-categorization.md#review-list-items)).
- A shipment item closes by itself when a Member links the shipment by hand, or when only one of its Transactions is left.

## The Amazon page in Settings

- The steps to get the file ([Getting the file](#getting-the-file)), and **Upload**.
- After an upload: rows read, Line items added, Line items updated, rows skipped, with the reason for each skip count.
- The last import: its date and the Member who uploaded it.
- Link counts: linked, waiting for a charge, waiting on the Review list, and not matched.
- **Delete all Amazon data.** It asks once to confirm. It removes every Line item, every link and every Item rule. Each Transaction with Line items goes back to the cascade. Hand-set Categories and hand splits stay.

## Pages

- **Transactions page.** A row with linked Line items shows the item count, such as "3 items". The detail view lists each Line item: its name, quantity, total and Category, with **Change** and "only this item". It shows the order ID, the order date and the link kind, with **Undo** ([Dashboard and pages](07-dashboard-and-pages.md#transactions-page)).
- **Reports and the dashboard** count the parts, as for every split. They need no change.

## Data and privacy

- Line items are Household data. The AI provider gets each Line item's name, quantity and price when it picks a Category (owner decision, 2026-11-07: no privacy filter).
- The card's last 4 digits are stored as an Account's mask is stored. They never go to the AI, a log line or an error.
- The ZIP also holds addresses, gift messages, tracking numbers and delivery photos. The app never reads them.
- The data export has `line-items.csv` and `item-rules.csv` ([Backup, restore, and export](11-backup-restore-export.md#data-export)).
- Backups hold Line items, links and Item rules, as they hold all app data.

## Speed

- An import of 20,000 rows, with linking, finishes in under 10 s on the large-history data set.
- An Item rule that changes 2,000 Line items finishes in under 2 s.
- The Transactions page and every report keep their 1 s limit with 20,000 Line items stored.

## Not in this version

- Signing in to Amazon, or any scraping. Amazon's sign-in needs a browser, and the owner judged that worse than a file upload (spike, 2026-11-09).
- Amazon's digital orders and returns files. A returned item's Refund reduces every part in proportion, not only that item's Category.
- Other stores, and scanned receipts. The Line item source field leaves room for them.
- "Also apply to similar items" on an Item rule, such as other sizes of one product.
- Searching Transactions by Line item name.

## Sources

- Owner request and decisions in the Claude Code session of 2026-11-09; backlog item N315.
