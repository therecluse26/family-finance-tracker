# Deal finder

The deal finder tells the Household where to buy its groceries and necessities for the least money. A Member writes a Shopping list of plain List items, such as "2 lb ground beef", by hand or in Chat. The app reads current prices from the Household's Stores through its Price sources. The AI matches each List item to Products. Then app code builds a Shopping plan: which Store gets which List item, at what price, in how many trips (owner decisions, 2026-11-07 and 2026-11-10).

This is an after-v1 feature (D22, "Real bugs first"). Using it is never required. A Household that sets up no Price source sees no change.

## Rules that stay in force

- **Read-only.** The app never buys, never fills a cart, and never signs in to a Store.
- **The app states facts; the AI adds words.** App code does every price, unit price, total, saving and plan. The AI only matches List items to Products, checks dietary needs, and judges substitutes.
- **Works without AI.** Without an AI provider, a Member picks the Product for each List item from the search results by hand. The plan math is the same.
- **Free, with no required paid service.** The Kroger API is free. Apify's Free plan gives $5 of usage each month. A Household may use the Kroger API alone, with no Scraping service.
- **No store data leaves the Household.** Prices, Products and plans stay in `app.db`. The app sends them nowhere but the AI provider.
- **A Store's notice ends its reader.** If a Store asks the project to stop reading it, the next release removes that Store's reader for good (owner decision, 2026-11-10).

## Price sources

A Price source is a service the deal finder reads Store data from. There are three kinds:

| Kind | In this version | Key | What it gives |
|---|---|---|---|
| Scraping service | Apify, the only one | One API token | Products, prices and weekly ads for every Store without a free API, through one Actor per Store |
| Store API | The Kroger public API ([developer.kroger.com](https://developer.kroger.com)) | A client ID and a client secret | Kroger-family Store locations, Products, regular prices and promo prices |
| Product data | Open Food Facts | None | Ingredients and allergens by barcode (UPC), for the dietary check |

- **One Scraping service per Household** (owner decision, 2026-11-10). Every Store that has no Store API uses it. The app never mixes two Scraping services. Apify counts as one service, even when each Store uses a different Actor.
- **A Store API always wins** over the Scraping service for its Stores (owner decision, 2026-11-10). Today that is Kroger only.
- The Price source adapter is one interface, like the Bank-data adapter ([Accounts and bank sync](02-accounts-and-bank-sync.md)). It has four calls: find Store locations near a ZIP code, search a Store for words, read one Product, and read the weekly ads. Each Price source maps these calls to its own API. A fake adapter serves every test and every development run.
- **How the app picks an Actor** (owner decision, 2026-11-10): Apify's own Actor first, then a well-kept Actor from the Apify Store, then our own Actor (built with Crawlee and published by the project) only as a last resort. Our own Actor brings the bot-defense work back to the project.
- The Actor for each Store is fixed in code, not a setting. A release changes it when an Actor breaks or a better one appears.

## Stores and their readers

A Store is a chain the deal finder reads, such as Walmart or Aldi. A Home store is the one location of a Store whose prices the deal finder uses. The spike tested every reader below with real runs (spike rounds 7 to 11, 2026-11-10).

| Store | Reader | How the Home store is set | Spike result |
|---|---|---|---|
| Kroger and its brands, such as Ralphs and King Soopers | Kroger API, scope `product.compact` | The Locations API near the ZIP code | 15 of 15 priced, 8 with a promo price. Prices are set per division: one of 12 Products differed between two divisions |
| Walmart | `gauravlabs/walmart-search-api` with `zipcode`. Its `storeId` input failed 2 of 2 runs (spike round 14) | The Actor picks it from the ZIP code | Different stores per ZIP code. No price differences seen |
| Target | `litescrape/target-search` with `store_id`; `apify/e-commerce-scraping-tool` for one Product's page | `axlymxp/target-store-scraper` near the ZIP code gives the nearest store's `storeId` (spike round 12) | 24 Products with `data.price` and `data.original_price`. Two stores: 2 sale prices differed |
| Aldi | `blackfalcondata/aldi-us-scraper` with `location`; `onSaleOnly` for deals | The Actor picks it from the ZIP code | 15 of 15 priced. Different store per ZIP code, same prices. 40 of 40 on-sale rows had a regular price |
| Costco | `vant47/costco-scraper` with `storeIds` and `locations` | [Find Stores near us](#find-stores-near-us-owner-design-2026-11-11) | Different warehouse per ZIP code. 2 of 12 prices differed. 6 of 12 rows had only `regularPrice` |
| Amazon | `delicious_zebu/amazon-product-data-scraper` | None: Amazon has one price for the US | The ZIP code changed no price. Rows carry a coupon, a list price and a unit price |
| Weekly ads, every chain that prints one | `gratifying_graph/us-grocery-deals` (Flipp data), mode `flyers`, with `zipCodes` and `merchants` | The ZIP code | Aldi 151 items with ALDI Finds, Target 192, Costco 208 or more, and local chains. Sale price, regular price, `validFrom` and `validTo`, in 2 to 3 s. Walmart prints no ad |

- **A weekly-ad-only Store** is a local chain that appears only in the weekly ads. Its deals count in the plan. It has no regular prices, so a List item goes there only for a deal.
- Costco gives two prices: the warehouse price (`warehousePrice`) and a higher online price (`onlinePrice`). The plan uses the warehouse price (owner decision, 2026-11-10). A Product with no warehouse price uses its online price, and the plan labels it "Online price". In spike round 12, 6 of 15 rows had a warehouse price.
- Amazon's Subscribe & Save price is not used: it needs a subscription. A coupon counts as a Deal.
- Apify's own `apify/e-commerce-scraping-tool` does not read Aldi or Kroger, and gives only each site's default store. It is used for one Product's page at Target only.

## Store locations and the ZIP code

- **Opt-in.** The deal finder sends the Household's ZIP code only after a Member turns on **Use our ZIP code to find stores** on the Price sources page. The switch shows the ZIP code from Household facts. It is off by default (owner decision, 2026-11-07).
- **Without the ZIP code**, the deal finder reads only Stores that give a price with no location: Walmart, Target and Costco at their default stores, and Amazon. Kroger, Aldi and the weekly ads need the ZIP code, so they show "Needs your ZIP code".
### Find Stores near us (owner design, 2026-11-11)

A one-time setup step finds every supported Store near the ZIP code. The Member picks which Stores the deal finder reads. Stores that are not picked are never read, so they cost nothing.

1. **Start.** It runs when a Member turns on the ZIP code switch, and when a Member presses **Find Stores near us** on the Price sources page. It runs again when the Household's ZIP code changes.
2. **Distance.** The Member picks 10, 25 or 50 miles. The default is 25.
3. **Lookups**, one per Store, about $0.03 in all:

   | Store | How the app finds it | Locations to pick from | Cost |
   |---|---|---|---|
   | Kroger and its brands | Locations API within the distance. It skips a location with no departments: the spike found one that was not a grocery store | up to 10 nearest | free |
   | Target | `axlymxp/target-store-scraper` with `within` set to the distance | up to 5 nearest open stores | about $0.015 |
   | Costco | `dromb/costco-us` with `operation: "warehouses"` lists the 5 nearest warehouses, with `warehouse_id` and `distance_miles` | up to 5 nearest; `vant47` reads the picked one by `storeIds` (spike round 14) | about $0.007 |
   | Walmart | One search with `zipcode`. Its row gives the store the Actor picked | that store only: the Actor's `storeId` input failed 2 of 2 runs, and no Actor lists Walmart stores near a ZIP code (spike round 14) | $0.002 |
   | Aldi | The weekly ads show whether an Aldi ad runs near the ZIP code | none: the Actor takes only a ZIP code and picks the store | in the weekly ads lookup |
   | Amazon | Always listed, as "Online" | none | free |
   | Local chains | The weekly ads list each chain that prints an ad near the ZIP code. Each one is a weekly-ad-only Store | none | in the weekly ads lookup |

4. **The list.** The page shows each Store found, with its nearest location and distance. A Store outside the distance is not shown. The Member ticks the Stores to read. A ticked Store is on; the rest are off.
5. **Locations.** For a ticked Store with a list, the app picks the nearest location as its Home store. A Member can pick another one from the list. Each Store has one Home store.
6. **Saved.** The app saves the ticked Stores and their Home store IDs. Plan runs use the saved IDs, and do not look them up again.

## Shopping list

- The Household has one Shopping list. Every Member sees it and can change it.
- A List item has: its words ("ground beef"), a quantity and a unit ("2 lb"), an optional brand lock ("only Jif"), and an optional note. The units are `each`, `oz`, `lb`, `fl oz`, `gal`, `ct` and `pack`.
- **Dietary needs** are one Household setting on the Shopping list page, in plain words, such as "no peanuts, gluten-free". Every match checks them.
- **By hand:** the Shopping list page adds, edits and removes List items, and ticks them off.
- **In Chat:** the AI changes the Shopping list with one tool, `edit_shopping_list` ([Chat tools](#chat-tools)). The change applies at once and shows as a card in the thread, with **Undo** (owner decision, 2026-11-11).
- A ticked List item stays on the list, struck through, until a Member presses **Clear ticked items**.
- The Shopping list holds at most 100 List items.

## Matching List items to Products

1. **Search words.** For each List item, the AI writes the search words once, such as "ground beef 80/20". Without AI, the search words are the List item's words.
2. **Search.** The app searches each Store that is on with those words. It keeps up to 15 Products at Kroger, Walmart and Target, up to 10 at Costco and Aldi, and up to 5 at Amazon and the weekly ads ([Search once, then re-read](#search-once-then-re-read-owner-decision-2026-11-11)). Later plan runs re-read the match and do not search again.
3. **Match.** The AI (Quick model) reads each List item with its Products: name, brand, size, and Open Food Facts ingredients and allergens when that source is on. For each Product it answers `match`, `substitute` or `no`. A substitute gets one line of reason, such as "Turkey instead of beef".
4. **Dietary check.** A Product that fails the dietary needs is `no`. Every result that passed a dietary check shows: "AI can get things wrong. Check the label before you buy." (owner decision, 2026-11-07).
5. **Member choice.** A Member can confirm or reject any match. The app remembers it for the same List item words, Store and Product, and does not ask the AI again.

- A brand lock makes every other brand `no`.
- App code reads the size from the Product's size field, else from its name. When code cannot read it, the AI reads it in the match call.
- **Packages to buy** = the List item quantity divided by the package size, rounded up. A List item in `each` with a Product in `ct` counts one per count.
- A List item with no `match` at any Store shows "Not found", with its best substitutes.

### Search order and filters (owner decision, 2026-11-11)

- **Order.** Every search uses the Store's own best-match order. It never sorts by price. A low-to-high sort puts cheap, loosely related items first, such as an egg cup for "eggs".
- **Ranking.** After the AI picks the `match` Products, app code ranks them by unit price ([Prices and Deals](#prices-and-deals)). The cheapest package is not always the lowest unit price.
- **Brand lock.** The brand goes into the search words at every Store. Aldi also gets its `brand` filter, and Kroger its `filter.brand`: in spike round 14 it returned 15 of 15 Jif Products.
- **Filters on every search:**

  | Store | Filter | Why |
  |---|---|---|
  | Walmart | `excludeSponsored: true` | Paid ads take result slots. It costs nothing: Walmart charges per search |
  | Weekly ads | `onlyWithPrice: true` (the default) | Drops ad images with no price |
  | Aldi | `brand`, only with a brand lock | Keeps other brands out |

- **Deal reads** use Aldi's `onSaleOnly` and Costco's `dealsOnly`.
- **Tested and not used** (spike round 14): Kroger's `filter.fulfillment=ais` changed nothing, because all 15 Products were already in store. Amazon's Grocery department changed 2 of 15 Products and gave no better matches. It would also drop household Products, such as paper towels, which Amazon lists under Health & Household.

## Prices and Deals

- The **regular price** is the Store's normal shelf price: Kroger `price.regular`, Target `original_price`, Aldi's and Costco's regular price, Amazon's list price, else the current price.
- A **Deal** is a price below the regular price for a limited time: a Kroger `price.promo`, a Target sale price, an Aldi on-sale price, a weekly-ad item, or an Amazon coupon. A Deal has an end date when the source gives one.
- **Unit price** = price divided by package size, in the List item's unit. App code compares Products by unit price.
- **Reuse.** A price read less than 24 hours ago is reused. Each plan run reads only what is older.
- **Price history.** The app stores each price read: Product, Store, date, regular price, Deal price and Deal end date. It keeps 400 days.
- **Checks on every price.** A price must parse to whole cents, above $0.00 and below $10,000.00. Else the app drops that Product. Text fields are cut to 200 characters.
- **Product links.** A link opens only when it is `https:` and its host is the Store's own domain, checked on the stored string as sent ([K15](../../CLAUDE.md)). Else the app shows the Product with no link.

## The Shopping plan

A Member presses **Find the best prices** on the Shopping list page. A job reads prices, matches Products, and builds the plan. The page shows each Store's progress while it works.

### Trip setting

One Household setting: **An extra trip must save at least $X** (owner decision, 2026-11-07). The default is $10.00. $0 means the lowest total. A large amount means the fewest trips.

- Each Store visited in person is one trip.
- An online Store, such as Amazon, is not a trip. Its cost is its delivery fee when the order is below its free-delivery amount.
- Each Store has a **Delivery fee** and a **Free delivery from** amount, set by a Member. Both are empty by default, which means no fee.

### How app code builds the plan

1. Start from the regular prices. A Deal never decides which Stores the plan visits, so the plan stays good after the Deal ends (owner decision, 2026-11-07).
2. For each set of Stores that are on, put each List item at its cheapest `match` in that set, by total for the packages to buy.
3. Give each set a score: item totals, plus delivery fees, plus $X for each trip after the first.
4. Pick the set with the lowest score. A tie goes to fewer trips, then to the lower total.
5. A List item with no `match` in the chosen set is "Not found" in this plan. A set that leaves more List items not found never wins over one that leaves fewer.

- At most 12 Stores are on at once, so a plan checks at most 4,096 sets.
- A substitute never goes in the plan by itself. A Member can pick it, and then it counts as a `match`.

### What the plan shows

- One section per Store: its List items, packages, prices and subtotal. Then the total and the number of trips.
- **Saving** against the best one-Store plan, in dollars.
- **Deals.** Beside a List item, each Deal that beats its plan price at a Store already in the plan: "Deal: $3.59 at Target until Nov 14, saves $0.90". **Use this Deal** moves the List item there until the Deal ends. Then the List item goes back to its regular-price Store.
- A Deal at a Store not in the plan shows in a list below the plan. It moves the plan only when the trip setting says the saving pays for the trip.
- Each price shows its date. The plan says: "Prices can change. Sales tax is not included."
- Stores that could not be read, each with its reason ([Failures](#failures)).

## Chat tools

| Tool | Takes | Returns |
|---|---|---|
| `get_shopping_list` | Nothing | Each List item: words, quantity, unit, brand lock, note, ticked; and the dietary needs |
| `edit_shopping_list` | Up to 30 changes: add, change or remove a List item | "done" with the card's ID, or an error that names the broken rule |
| `get_shopping_plan` | Nothing | The last plan: Stores, List items, prices, Deals, total, trips, and the date of each price |

- The AI cannot start a plan run. A Member presses **Find the best prices**.
- These tools count toward Chat's 5 tool calls per question ([AI](08-ai.md#answers)).

## Cost and limits

- **Price source cost cap.** One monthly amount for the Scraping service, like the AI cost cap. The default is $5.00, Apify's Free plan credit. When the month's cost reaches it, plan runs use stored prices only, until the 1st.
- The app takes each Actor run's cost from Apify's own run record. The Price sources page shows the month's total.
- Every Actor run sets `maxTotalChargeUsd=1.00`, the lowest Apify accepts.
- **One Actor run per Store per plan run.** It carries all the search words, for each Actor that takes a list: Walmart `queries`, Target `requests`, Costco `searchTerms`, Amazon `Keywords`, and the weekly ads' `queries`. Aldi takes one query, so it gets one run per List item. Target's `maxResults` caps the whole run, so it is set to 25 per List item.
- At most 2 Actor runs go at once.
- Kroger allows 10,000 Products calls a day. The app stops at 5,000.
- **Measured prices** (spike round 12): every charge matched the Actor's published price. Walmart $0.002 a search. Target $0.00025 a search. Aldi $0.01 a run plus $0.002 a Product. Costco $0.005 a Product. Amazon $0.0025 a Product. Weekly ads $0.002 a Deal.
- Costco re-reads cost the same $0.005 a Product as a search. No cheaper Costco Actor gives warehouse prices (spike round 13).

### Search once, then re-read (owner decision, 2026-11-11)

- **Full search.** A List item's first plan run searches each Store that is on. Products kept per search (owner decision, 2026-11-11):
  - 15 at Kroger, Walmart and Target. They are free or charge per search, so more Products cost nothing.
  - 5 at Amazon and the weekly ads. In spike round 12, all of their top 5 Products were the right kind (15 of 15 each).
  - 10 at Costco and Aldi, with no second search. Costco's search matches words in Product names, so its order is poor: its top 5 held 2 of 5 peanut butters and 0 of 5 eggs. 10 Products in one search is simpler than 5 with a retry (owner decision, 2026-11-11).
- **Re-read.** Later plan runs read only each List item's saved `match`, by item number or Product link. Walmart and Target search again, because a search costs the same as a re-read. The weekly ads search again at 5 Deals per List item, because Deals change each week.
- **Full search again** for a List item when its last full search is 30 days old or more, and when its saved `match` fails: the Store no longer has it, or it has no price.
- **Cost shown first.** Before a plan run that holds a full search, the page shows its expected cost. The run starts only when a Member confirms it. A run with only re-reads starts at once.
- **What it costs** for 30 List items with every Store on, from the prices measured in spike round 12.

  | Store | Full search | Re-read | Re-read tested |
  |---|---|---|---|
  | Kroger, 15 Products | $0.00 | $0.00 | not needed (API) |
  | Walmart, 15 Products | $0.06 | $0.06 | not needed (searches again) |
  | Target, 15 Products | $0.01 | $0.01 | not needed (searches again) |
  | Aldi, 10 Products | $0.90 | $0.07 | no; its docs say `startUrls` takes Product links |
  | Costco, 10 Products | $1.50 | $0.15 | yes, spike round 13: `productIds`, same prices |
  | Amazon, 5 Products | $0.38 | $0.08 | yes, spike round 14: the ASIN as the search word, 1 Product, same prices. Product links return nothing |
  | Weekly ads, 5 Deals | $0.30 | $0.30 | not needed (searches again) |
  | **Total** | **about $3.15** | **about $0.67** | |

- **For one List item:** a full search costs about $0.10 and a re-read about $0.02. A month of weekly plans (one full search, 3 re-reads) costs about $0.17 for each List item. So $5.00 covers about 29 List items with every Store on. Each Store a Member leaves off lowers the cost.

## Failures

- An Actor run that fails gets one retry in the same plan run. Then that Store shows "Could not read this store" with the reason, and the plan uses the other Stores.
- A refused token or key shows on the Price sources page as "Apify refused the token" or "Kroger refused the keys". Plan runs skip that Price source until a Member saves a key that passes **Test**.
- A Store that fails 3 plan runs in a row raises one System notice. It names the Store and says a release may need a new reader.
- Apify's own limit errors map to "Apify usage limit reached", not to a server error.
- No raw error from Apify, Kroger or Open Food Facts reaches a log line, a job record or the page. Errors go through `src/log.ts` ([K8](../../CLAUDE.md)).

## The Price sources page in Settings

The Settings tab is **Price sources**, not "Connections": that word means bank Connections (owner decision, 2026-11-10). Its intro line says the deal finder reads Store prices through these sources.

- **Scraping service card.** The service (Apify), its API token, **Test**, the month's cost, and the Price source cost cap.
- **Kroger card.** Client ID, client secret, and **Test**. The Kroger Home store is on the Stores card.
- **Open Food Facts card.** On or off. It needs no key.
- **ZIP code switch.** "Use our ZIP code to find stores", with the ZIP code shown.
- **Stores card.** **Find Stores near us** with the distance ([Find Stores near us](#find-stores-near-us-owner-design-2026-11-11)). Each Store found: ticked or not, its reader, its Home store with **Change** where a list exists, its distance, its delivery fee and free-delivery amount, and its last good read.
- Each key is stored encrypted by the Master key ([Members, login, and security](09-members-login-security.md#encryption-at-rest)). The page shows only the last 4 characters of a key. **Test** makes one small call: an Apify account read, or a Kroger token request.
- **Delete all deal finder data** asks once to confirm. It removes every Product, price, match and plan. It keeps the Shopping list and the keys.

## Pages

- **Shopping list page**, in the main menu's "More" section: the List items, dietary needs, the trip setting, **Find the best prices**, and the last Shopping plan.
- **Price sources** in Settings, above.
- **Chat:** the Shopping list tools, and the Shopping list change card with **Undo**.

## Data and privacy

The app sends deal finder data only to these services. Each adds a row to the Privacy table ([Scope and principles](01-scope-and-principles.md#11-privacy)).

| Service | When | What it gets |
|---|---|---|
| Apify, if set up | Plan runs and **Test** | The API token, search words, Product links, and, with the ZIP switch on, the ZIP code and a Target `store_id`. Each Actor runs on Apify with these inputs |
| Kroger API, if set up | Plan runs and **Test** | The client ID and secret (token request only), search words, a Kroger location ID, and, with the ZIP switch on, the ZIP code |
| Open Food Facts, if on | Matching | A Product barcode (UPC) only |

- The AI provider gets List items, dietary needs, Product names, brands, sizes, prices and Store names (owner decision, 2026-11-07: no privacy filter). It never gets the ZIP code, a Store location's address, or any key.
- The Apify token and the Kroger client secret never go to the AI, a log line, an error, or an export ([K8](../../CLAUDE.md)).
- No Member name, email or personal detail goes to any Price source, in a request body or a header.
- The data export has `shopping-list.csv` and `shopping-plan.csv` ([Backup, restore, and export](11-backup-restore-export.md#data-export)).
- Backups hold all deal finder data, as they hold all app data. Keys stay encrypted.

## Speed

- Building the plan from stored prices takes under 1 s, with 100 List items and 12 Stores.
- The Shopping list page opens in under 1 s.
- A plan run is a job. The spike's Actor runs took 2 to 32 s each, so a full plan run may take minutes. The page does not wait for it.

## Open before build

These need an owner decision or a short spike before tickets:

1. **Target `store_id` from a ZIP code.** Answered in spike round 12: `axlymxp/target-store-scraper`. It had 0 users in 30 days, so a release may need to replace it.
2. **Plan run cost.** Answered (owner decision, 2026-11-11): b, with a per-Store Product count and d. See [Search once, then re-read](#search-once-then-re-read-owner-decision-2026-11-11). The options weighed are below. Spike round 12 measured a run at about $5.55 for 30 List items at 15 Products per search. Weekly, that is about $24 a month. A weekly plan needs one or more of these to stay under $5.00 a month:
   - a. **5 Products per search, not 15.** About $2.10 a run. Risk: fewer Products to match from. Costco's search matches words in Product names, not Costco's own ranking. In round 12, its 5 "eggs" rows held no fresh eggs (powdered eggs, Kinder Joy, a burrito, a sofa).
   - b. **After the first run, re-read only the matched Products**, by item number or Product link. A new List item still gets a search. About $0.65 a later run for 30 List items:

     | Store | Re-read | Cost | Tested |
     |---|---|---|---|
     | Kroger | API | $0.00 | no need |
     | Walmart | search again (charged per search) | $0.06 | no need |
     | Target | search again (charged per search) | $0.01 | no need |
     | Aldi | Product links in `startUrls` | $0.07 | no (its docs say yes) |
     | Costco | `productIds` (item numbers) | $0.15 | yes, round 13: same prices; item numbers took 15 s, links 28 s |
     | Amazon | Product links | $0.08 | no |
     | Weekly ads | search again, 5 Deals per List item (Deals change each week) | $0.30 | no need |

     If Amazon cannot re-read, it searches again at 5 Products: about $0.38, so about $0.95 a later run.
   - c. **Costco off by default.** Replaced by [Find Stores near us](#find-stores-near-us-owner-design-2026-11-11): every Store is off until a Member ticks it. At 15 Products per search, Costco is $2.25 of $5.55; with option b, $0.15 of about $0.65.
   - d. **Show the expected cost before a run, and let the Member confirm it.** It saves nothing by itself. It stops a surprise charge.

   With a, b and d, weekly plans cost about $4.05 in the first month ($2.10, then 3 × $0.65) and about $2.60 in each later month, plus searches for new List items. The $5.00 credit also covers any other Apify use that month.
3. **Store location and filter tests.** Answered in spike round 14: a Costco warehouse can be picked from the 5 nearest; Walmart keeps the store its Actor picks; Amazon re-reads by ASIN; Kroger's brand filter is used, and the other two filters are not.
4. **Chat edits the list at once, with Undo.** Answered (owner decision, 2026-11-11): keep it. This differs from Proposals, which change nothing until a Member accepts. A Shopping list holds no money, so the edit applies at once.
5. **Defaults.** Answered (owner decision, 2026-11-11): the trip setting starts at $10.00, and a Member can change it. Products kept per search are 15 at Kroger, Walmart and Target, 10 at Costco and Aldi, and 5 at Amazon and the weekly ads. A full search runs again after 30 days. Price history is kept for 400 days.

## Not in this version

- Buying, carts, and signing in to a Store. Member-only prices, such as Kroger digital coupons, need a sign-in.
- Other Scraping services, such as Bright Data and ZenRows. The adapter leaves room. Bright Data needs a payment method for a personal-email account (spike, 2026-11-10).
- Our own Actor.
- Picking a Home store at Walmart or Aldi. Their Actors pick the store from the ZIP code.
- More than one Home store for one Store.
- Recurring List items, and a Shopping list built from past Line items ([Line items](14-line-items.md)).
- Price drop Alerts for one Product.
- Sales tax.
- USDA FoodData Central. Open Food Facts covers ingredients and allergens.
- Amazon Subscribe & Save prices, and Walmart+ or Amazon Prime delivery rules beyond the two delivery fields.

## Sources

- Owner request and choices in the Claude Code session of 2026-11-07: dietary disclaimer, opt-in ZIP code, List items in Chat, regular price first, the trip setting.
- Owner decisions of 2026-11-10: stealth readers kept in the public repo, one Scraping service per Household, Store APIs first, the Actor order, the Price sources page.
- Spike rounds 1 to 11, 2026-11-09 and 2026-11-10: branch `spike/price-source`, `spikes/price-source/FINDINGS.md`.
