# After-release list

Small items left open after the T107 notes triage, for after the first release (owner decision D22, "Real bugs first"). The release fixes are tickets X16, X17 and X19 to X27. Each line gives the triage ID, its size (S, M or L), its kind and where it lives. "Security" items here are low risk; "cannot tell" items need a check before any fix.

## Logging, secrets and repo checks

- N4 (M, security) The logger misses a registered secret passed as a `Buffer`/`Uint8Array`, `new String(value)`, `[...value]`, an upper-case copy, or spelled through dotted field names in the refused-fields line. In: src/log.ts.
- N5 (S, security) The secret-name check `keys?$` misses names with "key" in the middle (`aikeyvalue`, `vapidkeyhex`, `keyhex`) and over-refuses `monkey`, `hotkeys`. In: src/log.ts.
- N6 (S, polish) A very short registered secret (a one-letter SMTP password, `3000`) turns many log lines into `[refused]`; consider a minimum length with a test. In: src/log.ts.
- N7 (S, security) `MasterKey.key` is readable by any module that imports the type; only a comment limits it. In: src/secrets/.
- N8 (M, security) The Master key both wraps the data key and feeds `derive`; consider a derived wrapping key when key rotation comes. In: src/secrets/.
- N16 (S, polish) `@better-auth/utils` is a direct dependency at `^0.5.1` while `better-auth` pins `0.5.1`; keep them in step on upgrades. In: package.json.
- N25 (S, security) The `gitleaks stdin` pass splits input into about 100 KB chunks and can cut a token in half; pipe through `sed G`. In: scripts/secret-scan.sh.
- N26 (S, security) The `gitleaks stdin` pass is skipped when the stream starts like a binary file (author `MZ`); start the stream with 40,000 newlines. In: scripts/secret-scan.sh.
- N27 (S, security) The Drizzle driver ban scans only top-level folders; `prisma/sqlite/`, `prisma/pg/`, `prisma/mysql/` and `aws-data-api/pg/` also hold a `driver.js`. In: src/seams.test.ts.
- N28 (S, security) `parsePnpmTreePaths` accepts `[]` or a missing `dependencies` key without error, so the shipped-package list can silently fall back and leave out optional native packages. In: scripts/licenses.ts.
- N29 (S, polish) In a checkout with a symlinked `node_modules`, the native package drops out of the shipped license list with no error (CI and image not affected). In: scripts/licenses.ts.
- N30 (S, polish) Dev-only moderate advisory GHSA-67mh-4wv8-2f99 in `esbuild@0.18.20` through `drizzle-kit`, below the high bar. In: package.json.
- N254 (S, security) The 6-character floor for registered secrets also drops their JSON and URL forms, so a short secret's JSON-escaped form (`a"b`) is not refused; apply the floor to base64 forms only. In: src/log.ts.

## Login, Members and the web server

- N1 (S, polish) The refusal log has one shared limit of 100 lines a minute, so one busy refusal reason can hide the others; consider a share per reason. In: src/server/security-mode.ts.
- N14 (S, polish) `verifications.identifier` is not unique, so two `new-totp` calls at once can leave two pending TOTP rows for one Member. In: src/auth/.
- N15 (S, security) `totpOnce` and Better Auth read the clock separately; a request crossing a 30-second boundary can let a code one step ahead pass once unrecorded. In: src/auth/totp-once.ts.
- N19 (S, polish) `fft setup` reads the Master key file before it checks for a Member, so a bad key file fails it even when setup is done. In: src/fft/setup.ts.
- N21 (S, polish) Wrong Master-key paste tries count even when refused with 429, so a Member who keeps pasting stays locked out (the sign-in limit drops refused tries). In: src/server/master-key.ts.
- N45 (S, flaky test) `src/server/main.test.ts` "logs the reason and exits when TRUSTED_PROXIES is *" hit the 5 s default timeout under load. In: src/server/main.test.ts.
- N47 (S, security) The API tests for T25's 409 answers do not assert by name that no token is in the body. In: src/server/connections-api.test.ts.
- N64 (S, polish) A refused PO box ZIP code gets no hint to use the street-address ZIP code. In: src/server/api.ts.
- N158 (S, polish) `src/server/app.ts`: the plain-HTTP install block sits between the jsonOnly comment and `jsonOnly`, so that comment describes the wrong code. In: src/server/app.ts.
- N200 (S, polish) A host clock set back before a join can still shift Member label numbers, and so the first Member (order by `created_at`); store the label number on the Member row at join. In: src/db/members.ts, schema migration.
- N202 (S, polish) Cancelling an invite leaves its pending TOTP secret (`invite-new-totp-<id>`) until the 10-minute expiry. In: src/db/invites.ts, src/auth/invites.ts.
- N203 (S, polish) A right token's try counts against the limit while its request is in flight, so a wrong token at the same moment can be refused one try early. In: src/auth/ link-token tries.
- N204 (S, security) No K18 test sends wrong tokens in parallel to the reset and invite routes (the cap holds in a probe). In: src/server/*-api.test.ts.
- N205 (S, polish) `fft reset-login`'s migration mismatch message says "Start the app with this version once", which is wrong when app.db is newer than the CLI. In: src/fft/reset-login.ts.
- N206 (S, polish) The mismatch and missing-Master-key paths of `fft reset-login` have no tests. In: src/fft/reset-login.test.ts.
- N207 (S, security) A reset finished in another Member's tab leaves that session row until it expires. In: src/auth/ reset.
- N208 (S, polish) The reset link's "It works until …" shows only the day, not the time. In: Members.tsx.
- N209 (S, security) `fft reset-login` looks up the email before `checkDataKey`, so a wrong Master key still tells whether an email belongs to a Member. In: src/fft/reset-login.ts.
- N218 (S, polish) `pnpm dev` has no email service, so wizard step 7 and Settings, Alerts show "The Alert settings did not load." in dev only. In: src/server/dev-app.ts.
- N219 (S, polish) No test marks the wizard's Banks step done through a Manual loan alone. In: src/server/setup.ts tests.
- N220 (S, polish) If marking the Alerts step done fails, `POST /api/smtp/test` answers 500 after the test email already went out. In: src/server/api.ts.
- N229 (S, security) No test covers a port change keeping passkeys; switching `passkeyHostOf` to `.host` would pass every test. In: src/auth/passkeys.ts tests.
- N230 (S, security) `session.freshAge: 0` is safe only because `ROUTES` hides `/list-sessions`, `/unlink-account` and `/delete-user`; add a comment or a 404 test. In: src/auth/auth.ts, route tests.
- N231 (S, security) A failed passkey check logs the full simplewebauthn Error and stack at error level; log a warn without the stack. In: src/auth/auth.ts.
- N233 (S, polish) An IP-address `APP_URL` over HTTPS offers passkeys that always fail (WebAuthn refuses an IP RP ID). In: src/auth/passkeys.ts, Settings page.
- N234 (S, security) No parallel passkey sign-in test (a probe holds). In: passkeys-api.test.ts.

## AI uses

- N82 (S, polish) `aiRetries.failed` reads then writes, so two failures at once can store the same count. In: src/ai/retries.ts.
- N98 (S, polish) When every AI call fails, Merchant cleanup restarts its retry cycle in each later run (22 calls over about 3 hours, not about 8). In: src/ai/retries.ts.
- N124 (S, polish) A `get_totals` month row for a range that starts mid-month is named by its month though it holds only part of it. In: src/chat/totals.ts.
- N153 (S, polish) The Proposal company list holds common words ("Discover", "Ally", "Chase", "Affirm", "Marcus", "Citizens", "Regions"), so legitimate Proposals ("Discover new restaurants", "an ally in saving") are refused. In: src/proposals/companies.ts.
- N154 (S, security) Company check gaps: a Cyrillic look-alike letter and a short form of the Household's bank name ("Pinecrest" for "Pinecrest Credit Union") pass. In: src/proposals/companies.ts.
- N172 (S, polish) `AiCall.facts` (T88) and T82's `{ role: "user", parts }` message build the same message; keep one path. In: src/ai/prompt.ts, src/tailoring/.
- N177 (S, polish) Emoji can make streamed Chat text differ slightly from reloaded text. In: src/chat/.
- N214 (S, polish) The `FOLLOW_UP_AI_USES` comment in `src/ai/retries.ts` is stale (Insight cards now also run from the 6 AM check, not only the follow-up job). In: src/ai/retries.ts.
- N251 (S, polish) The every-use test counts AI uses by name; a new path reusing a use name would not fail it. In: src/ai/every-use.test.ts.
- N289 (S, polish) Spec 08's Expected cost totals were written before thinking tokens counted and before Sonnet 5.5's cache read rose to $0.20; recompute them from measured calls. In: docs/spec/08-ai.md.
- N290 (S, polish) On OpenRouter, Reading a Goal at `low` effort may get Anthropic's 1,024-token minimum thinking budget, which leaves about half of its 2,000-token limit for the answer. In: src/ai/prompt.ts.
- N291 (S, polish) The AI request log's Request view turns `\n` into line breaks but shows `\r` as written. In: src/web/pages/settings/AiRequestLog.tsx.
- N292 (S, polish) The `ai_settings_whole` check does not cover `chat_model` (nullable by design, D44); a later generated table rebuild can add it. In: src/db/schema.ts.
- N293 (S, polish) `enteredFor` in `src/ai/settings.ts` uses the first tier's price when a hand-made save sends different prices for two tiers with the same model; it does not refuse. In: src/ai/settings.ts.
- N294 (S, polish) The large-history cases do not set `chatModel`; they rely on the Writer fallback. In: src/large-history/cases/.

## Bank data and sync

- N33 (S, polish) Demo Connections use provider "fake", which a running app has no adapter for, so their scheduled sync fails. In: src/bank/sync.ts, src/server/dev-app.ts.
- N34 (S, polish) Spec 02's adapter block does not list `check()` or `statementIssueDate`. In: spec 02.
- N35 (S, polish) Spec 02 does not say the description falls back to Plaid's `name` when `original_description` is missing. In: spec 02.
- N37 (M, polish) A whole Plaid sync run (up to 1,000 pages of 500) is held in memory before the adapter returns. In: src/bank/plaid.ts.
- N39 (S, polish) The history-wait check lists every Connection each minute, even after the wait ended. In: src/bank/history-load.ts.
- N54 (S, polish) `refused_links.other_id` has no foreign key, so a refusal stays after its loan or Spending is deleted. In: src/db/schema.ts (migration).
- N90 (S, polish) Transactions page Merchant filter is an exact, case-sensitive match on a free-text field. In: src/db/bank-data.ts, src/web/pages/Transactions.tsx.
- N91 (S, polish) The Category-and-month filter includes pending Transactions and Excluded Accounts, which Totals leave out, so the list can disagree with the Category's Total it opens from. In: src/db/bank-data.ts.
- N150 (S, polish) The demo snapshot day (2026-11-20) has no November Spending, so every "this month" summary line is 0.00. In: src/bank/demo.ts / summary tests.
- N235 (S, polish) After 5 failed tries to end a copies wait, no System notice is raised (K4 word for word). In: src/bank/copies-wait.ts.
- N236 (M, polish) A carry-over onto a Connection whose first load already ended (or whose 7-day cap passed) ends hand links at once, though the copy may still arrive. In: src/db/link-carry-over.ts, src/db/bank-data.ts carryOver.
- N237 (S, polish) One new Connection carrying Accounts from two old ones records only the last old one (`onConflictDoUpdate` on `connection_carry_overs`). In: src/db/bank-data.ts.
- N255 (M, security) Raw Plaid data stored before X17 still holds the `payment_meta` fields X17 now drops; a one-time migration should remove them. In: src/db/ (migration).
- N256 (M, cannot tell) An old Connection that finished syncs but never finished its history load still splits at its last sync, so older history goes missing on the new Connection; needs a spec 02 rule. In: src/bank/, docs/spec/02.
- N257 (S, polish) Two refused old Transactions with the same Account, date and amount but one new copy leave one refusal on a hidden Transaction; move every refusal to the one copy. In: src/db/link-carry-over.ts.
- N258 (S, polish) `refused()` in link carry-over, and `carryLinks`, scan all of `refused_links` once per old Transaction (`other_id` has no index, and the OR blocks the `transaction_id` index); 10,000 × 5,000 took 3.3 s. Add the index and split the OR. In: src/db/link-carry-over.ts (migration).
- N259 (S, polish) List and search date filters use the posted date while rows sort by purchase date. In: Transactions list and search.

## Money movement

- N74 (S, polish) Loan payment matching is wide: a step 5.6 transfer that names the lender's bank can link as a loan payment, even a confident first link. In: src/money-movement/loan-payments.ts.
- N75 (S, polish) A payment dated before payoff that arrives after the loan closes goes on the Review list instead of linking. In: src/money-movement/loan-payments.ts.
- N85 (S, polish) `src/budgets/large-purchase.ts` copies money-movement's `purchaseDate` rule instead of importing it. In: src/budgets/, src/money-movement/index.ts.
- N92 (S, polish) The 20-part limit on a stored split is checked only by the split route. In: src/money-movement/splits.ts.
- N190 (M, polish) One failed window call makes all of that money item's Reimbursement pick calls go again on the next try. In: src/money-movement/ai-links.ts.
- N224 (S, polish) `calendarDateIn` builds a new `Intl.DateTimeFormat` for each removed card on each card payment. In: card-payments.ts.
- N225 (S, polish) The `(?!\p{L})` after the card word in the last-4 pattern does nothing. In: card-payments.ts.
- N226 (S, polish) `0x4821` reads as a card's last 4 (harmless). In: card-payments.ts.
- N260 (S, polish) A cash-back-only line that Plaid fills with the store's Merchant name or code takes the store's Category; only bare lines stay Cash. In: src/money-movement/.
- N261 (S, polish) Spending a Reimbursement could pay back still breaks ties on row ID. In: src/db/refunds.ts.

## Categorization and the Review list

- N87 (S, polish) Merchant history counts a split Transaction once, as its first part's Category marked hand-set, so splits steer the next unsplit purchase. In: src/categorization/, src/db/decisions.ts.
- N99 (S, cannot tell) A split Transaction that waits through an AI retry has no test. In: src/categorization/quick-tier.test.ts.
- N188 (S, polish) `reviseOpenReviewItems` writes one UPDATE per item inside one transaction; K3 asks for one statement. In: src/db/review-items.ts.

## Recurring charges, Alerts and push

- N68 (S, polish) `paydays` can return a date up to 2 days in the past. In: src/recurring/income.ts.
- N93 (S, polish) No test for the yearly "for {year}" Large purchase Budget line. In: src/anomalies/.
- N94 (S, polish) The hidden filter is tested only through Recurring charge tests, not the Anomaly tests. In: src/anomalies/.
- N95 (S, polish) The date shown differs by Alert kind (purchase date for Duplicate charge and Large purchase, posted date for the others). In: src/anomalies/.
- N107 (S, polish) Whole-dollar rounding gives "$35 of $35" when Spending is only cents over. In: src/anomalies/templates.ts.
- N108 (S, polish) "Card interest" depends on Plaid's `BANK_FEES_INTEREST_CHARGE` code; otherwise it reads as "Fee". In: src/anomalies/overspending.ts.
- N109 (S, polish) `listCategoryAlerts` reads every stored Over Budget and On pace Alert. In: src/db/alerts.ts.
- N126 (S, polish) Pin the 7.5% steadiness band in `isSteady` with a test (widening it to 15% fails no test). In: src/recurring/.
- N127 (S, polish) `src/recurring/series.ts` has a 171-character comment line. In: src/recurring/series.ts.
- N128 (S, polish) Alerts found in history all show the load date. In: src/anomalies/, src/web/pages/AlertList.tsx.
- N129 (S, polish) Alert order follows a random ID on ties, and the page breaks ties the opposite way from the server. In: src/web/pages/AlertList.tsx, src/db/alerts.ts.
- N130 (S, polish) The Top Merchants link filters by exact clean name (a row grouped by Merchant ID can count Transactions the link does not show) and carries no date range. In: src/web/pages/TopMerchants.tsx.
- N131 (S, polish) Top Merchants nets Refunds over the whole period while Goals floor each month at $0; they differ when an unlinked Refund exceeds its month's Spending. In: src/merchants/ top Merchants totals.
- N132 (S, polish) An ended Recurring charge still shows "next <date>". In: src/web/pages/RecurringCharges.tsx.
- N133 (S, polish) The price history uses the date as its React key, which can repeat. In: src/web/pages/RecurringCharges.tsx.
- N157 (S, security) No test fails when only the `url.parse` half of the push endpoint check is broken (a 260-character host under `.push.apple.com`). In: src/notify/push-endpoint.test.ts.
- N167 (S, polish) While an advice retry is pending, each follow-up job still reads Budgets, Spending and Goals before it learns the retry is not due. In: src/anomalies/advice.ts.
- N168 (S, polish) The advice reply schema is not `.strict()`: an extra field is dropped, not refused (same as other Quick replies). In: src/anomalies/advice.ts and other Quick reply schemas.
- N239 (S, polish) A Recurring charge saved before X5 that fits no fixed day can show inactive a few days early until the next follow-up job. In: src/recurring.
- N240 (S, polish) The schedule cache's tie-break between two months is untested. In: src/recurring.
- N262 (S, polish) A `PAYPAL *ETSY SHOP` line whose provider Merchant name is "PayPal" gets PayPal as its Merchant, so it never gets a Duplicate charge (cleanup takes the provider name first). In: src/merchants/.
- N263 (S, polish) `isPaymentApp`'s fallback treats "Payment", "Transfer", "Received", "Pmt" and "Web Id" as a payment app, so a non-app line that cleans to "Payment" gets no Duplicate charge. In: src/anomalies/checks.ts.
- N264 (S, polish) Card payment Merchant names keep noise ("St National Bank card payment" from 1ST, city words, "Target Srvcs", full-width payment words, a person's name on the line; no last 4 survives), and a card payment keeps the provider's Merchant ID, so it may share a Merchant with that brand's purchases. In: src/merchants/.
- N284 (S, polish) Jobs start even when the start-up move of old price histories fails; an ended Recurring charge then looks empty, and its Transactions can form a new series and later leave it. In: src/recurring/, start-up.
- N285 (S, polish) After an edit, the Merchant-only find may name a Transaction wrongly in the set sent back through the cascade when that Transaction's Merchant changed. In: src/recurring/charges.ts.
- N286 (S, polish) "Show older" on "Add a charge" gets 404 when the cursor Transaction is hidden between pages. In: src/server/, src/web/pages/RecurringCharges.tsx.
- N287 (S, polish) A Transaction that leaves a Recurring charge with a Member Category and needs the AI shows no Category until the next follow-up job (seconds), and so does each one after it by date. In: src/recurring/charges.ts.
- N288 (S, polish) The bench has no case for the find on a kept masked Recurring charge (a review probe shows it is fast). In: src/large-history/cases/.

## Budgets, Benchmarks and Goals

- N71 (S, polish) No sanity range on fetched CPI values; a broken BLS answer would scale the Groceries and Superstores Benchmark. In: src/benchmarks/cpi.ts.
- N102 (S, polish) `POST /api/goals/:id/status` recomputes every Goal's progress to return one (368 to 894 ms). In: src/server/goals.ts.
- N103 (S, polish) A Goal a Member marks done shows 100% even when it fell short. In: src/goals/goals.ts.
- N110 (S, polish) Before the Household facts exist, the Budgets page falls back to the browser's zone and the server to UTC (add a `thisMonth` helper with an end-of-month test). In: src/web/, src/budgets/.
- N111 (S, polish) `src/web/budgets.ts` imports `centsOf` from a page component. In: src/web/.
- N112 (S, polish) Each Budget row's switch and edit field share one label with no Category name (needs an `aria-label`). In: src/web/pages/Budgets.tsx.
- N113 (S, polish) The Budgets context line always uses today's Steady Income and Benchmarks, whatever month is asked. In: src/server/budgets.ts.
- N192 (S, polish) `sample_benchmarks` is recorded with redraft inputs but no trigger reads it: a move from sample Benchmarks to real data with the same CE year starts no redraft. In: src/tailoring/ redrafts.
- N222 (S, polish) The Benchmarks route returns a renter's Housing as `role: "context"` with null amount and share. In: Benchmarks route.
- N223 (S, polish) `rent: ["Rented dwellings"]` in `CE_LINE_MAP` is dead data, kept on purpose. In: src/benchmarks/ce-lines.ts.
- N228 (M, polish) Late bank data with an earlier posted date still moves an n = 0 Budget figure; freezing it needs a stored snapshot. In: src/budgets/.
- N244 (S, polish) Test name reads "an Proposal". In: src/budgets tests.
- N265 (S, polish) After an undone first Budget, the Budgets page shows no form to set a Budget for that Category; only a later Proposal or the API can. In: src/web/pages/Budgets.tsx.
- N266 (S, polish) Goal amount Accept reads the Goal's start before its transaction, so a new AI reading landing in between stores the old start; refuse inside the transaction when the reading changed. In: src/goals/.
- N267 (S, polish) When Month start hits its cap and stops, its Goal Done check stops too; follow-up jobs still check. In: src/goals/, src/jobs/.

## Household summary, Insight cards, Monthly review and Tailoring

- N149 (S, polish) ATM street and city names appear among the top Merchants in the summary's Habit counts. In: src/summary/habits.ts.
- N160 (S, polish) A Monthly review's Debt is taken when the review is written, not at month-end, so a late catch-up review shows a later Debt. In: src/monthly-review/review.ts.
- N161 (S, polish) "Budget changes to consider" also lists Goal Proposals; the heading may read oddly. In: src/web/pages/Reviews.tsx.
- N169 (S, polish) If the AI reply arrives and storing the cards then throws, the paid reply is lost and the run stays due, so a recurring fault costs one call per qualifying follow-up job that day. In: src/insights/cards.ts.
- N170 (S, polish) With no AI provider, every qualifying follow-up job still builds the Household summary and reads feedback before the call is refused. In: src/insights/cards.ts.
- N174 (S, polish) A retried Goal run (after its first Proposal is stored) makes a new AI call with the same runId, and the 2-per-run cap then refuses the Goal amount Proposal. In: src/tailoring/.
- N175 (S, cannot tell) A Tailoring run can follow a first draft that had an AI provider when `tailorFirstDraft` threw a non-AI error. In: src/tailoring/runs.ts.
- N182 (S, polish) A crash or restart during the Monthly review Writer call, or a throw from `storeMonthlyReviewReply`, leads to a second paid call, since nothing marks that a call went out. In: src/monthly-review/, src/db/monthly-review-runs.ts.
- N183 (S, polish) During an AI pause, the hourly re-check rebuilds the Household summary each time (Budget tailoring does the same). In: src/monthly-review/, src/tailoring/.
- N189 (S, polish) The redo's Matching run may store "found in history" Alerts that are never sent (normal decided-again path); the review asked only for a comment. In: src/redo/.
- N210 (S, polish) No in-code guard against two Insight card runs at once. In: src/jobs/, src/insights/.
- N211 (S, polish) Before the first Insight card run, the "new posted Transaction" query has no lower bound (`posted_seen_at IS NOT NULL`). In: src/db/insight-cards.ts.
- N212 (S, polish) No daylight-saving or far-time-zone test for the 6 AM Insight card rule. In: src/insights/.
- N213 (S, polish) The `start.ts` "insight cards" retry line is untested. In: src/server/start.test.ts.
- N221 (S, polish) The Household summary gives a renter the fixed note that Housing and Car Spending "can sit above their Benchmarks", though a renter has no Housing Benchmark. In: src/summary/summary.ts.
- N268 (S, polish) Chat Proposals from one AI round are stored in transaction order, not tool-call order; it matters only for two Budget changes on one Category in one round. In: src/chat/.
- N269 (S, polish) Redraft triggers firing together can log "A redraft already waits" one extra time. In: src/tailoring/.
- N295 (S, polish) The summary's 3-month and 12-month averages divide by every month, even months before the first loaded Transaction, so a new Household gets low averages and a high amount at stake. In: src/summary/.
- N296 (S, polish) The Biggest changes "a day keeps it in Budget" amount ignores Recurring charges still due this month, though the projection counts them. In: src/summary/.
- N297 (S, polish) With 5 or more prices, "now X% from the first price" refers to a price the summary does not list (it shows the last 4). In: src/summary/.
- N298 (S, polish) Spec 08 says the Insight card `check` field is never stored; the AI request log keeps it in the raw reply while a Member has the log on. Say "outside the AI request log". In: docs/spec/08-ai.md.
- N299 (S, polish) No test checks the stored Insight card row's keys, so copying the whole AI card (with `check`) into it would pass. In: src/insights/.
- N300 (S, polish) The Monthly review summary build is about 100 ms slower after X33 (839 ms alone against a 1 s limit). In: src/summary/, src/large-history/cases/.

## Pages and dev tools

- N62 (S, polish) The Data sources page renders the developer section ("Building the snapshot") of `docs/data-sources.md`. In: src/web/pages/settings/DataSources.tsx.
- N78 (S, polish) Account page chart draws the flat stretch after a typed balance as dashed. In: src/web/components/BalanceChart.tsx, src/db/balances.ts.
- N79 (S, polish) With no typed balance, an Unconnected account's line does not start at $0. In: src/db/balances.ts.
- N80 (S, polish) A Manual loan's Account page shows an always-empty Transactions list. In: src/web/pages/Account.tsx.
- N114 (S, polish) At 900 px the Shell's 15rem menu leaves the dashboard's right column about 244 px wide. In: src/web/Shell.tsx, Dashboard.tsx.
- N115 (S, polish) The dashboard reads `/api/household` (ZIP code and ages) only for `timeZone`. In: src/server/, src/web/dashboard.ts.
- N134 (S, cannot tell) At 375 px the Spending amount sometimes wraps under the Merchant line. In: src/web/pages/.
- N142 (M, polish) `pnpm seed:demo` loads only bank data: no follow-up pipeline, Budgets, Members or Alerts, so most dashboard boxes are empty in dev (T75 I8). In: scripts/seed-demo.ts, src/bank/demo.ts.
- N144 (S, polish) Removing the month ticks in `BalanceChart.tsx` fails no test; only the `monthTicks` helper is tested (T75 F3). In: src/web/components/BalanceChart.tsx.
- N171 (S, cannot tell) At 375 px the cards' picture cuts card names short ("Rewards ..."). In: src/web/components/Picture.tsx.
- N216 (S, polish) The wizard's Finish step says history "can take a few hours"; no spec gives that figure. In: SetupSteps.tsx.
- N217 (S, polish) The iPhone "Add to Home Screen" note also shows on Chrome and Firefox for iPhone but says "In Safari, tap Share", and names only Alerts though System notices also come by push. In: SetupSteps.tsx.
- N270 (S, polish) A failed Household time-zone read hides a Settings page's times until the next page load, with no retry and no message. In: src/web/household-zone.ts.
- N281 (S, polish) No test pins the 128 MiB `MAX_ZIP_ENTRY_BYTES` default. In: scripts/zip-table.ts.

## Reports

- N301 (S, polish) A report's range starts at the first posted date, but totals use the month of purchase, so a first Transaction bought Oct 31 and posted Nov 2 leaves October out of every range. In: src/server/reports.ts, src/db/budgets.ts (`readHistoryStart`).
- N302 (S, polish) Spending over time's Budget line sums only monthly Budgets, but its bars include yearly-Budget Categories such as Travel, so a big Travel month sits far above the line. In: src/reports/spending.ts.
- N303 (S, polish) "Change from the range before" and the usual line treat the history's first month differently, so they can be one month apart at the start of the history. In: src/reports/spending.ts.
- N304 (S, polish) A "No Category yet" row with Spending only in the range before is dropped, so its change does not show. In: src/reports/spending.ts.
- N305 (S, polish) Balances and debt reads a synced card's or loan's daily balances twice per request. In: src/server/reports-balances.ts.
- N306 (S, polish) Credit use falls back to the Account's current credit limit when a day's saved row has none, not to the last saved limit. In: src/reports/balances.ts.
- N307 (S, polish) The "No Account has this ID" state hides the Account filter, so it gives no way back to all Accounts. In: src/web/pages/reports/Balances.tsx.
- N308 (S, polish) The test that keeps Unconnected accounts out of Cash on hand cannot fail on the connection check, because those Accounts are another kind. In: src/reports/balances.test.ts.
- N309 (S, polish) Cash on hand and Debt drill down by month only, so the Transactions list also shows Excluded Accounts' Transactions. In: src/web/pages/reports/Balances.tsx.
- N310 (S, polish) A linked Refund counts in its Spending's month on the Merchants report, but the Transactions page's `month` filter lists it in its own month, so the list may not add up to the bar. In: src/reports/merchants.ts, src/db/bank-data.ts.
- N311 (S, polish) A Merchant group with no provider Merchant ID drills down by the words of its latest name, so names that differ only by punctuation ("Trader Joe's", "Trader Joes") can miss rows. In: src/web/pages/reports/merchant-words.ts.
- N312 (S, polish) The Recurring report picks the year-ago payment by posted-date order but compares purchase dates, so near the cut-off day it can pick the wrong payment. In: src/reports/recurring.ts.
- N313 (S, polish) The one-Merchant bench row's label reads `&merchant=` with no key. In: src/large-history/cases/reports-merchants.ts.
- N314 (S, polish) Top Merchants rows do not link to the Merchants report with their Merchant set. In: src/web/pages/TopMerchants.tsx.

## Amazon orders

- N315 (L, feature) Line items and Amazon orders: spec written in [14 Line items](spec/14-line-items.md) (2026-11-09). The file name and columns are fixed from a real export (2026-11-09). In: new `src/line-items/`, an Amazon page in Settings, the Transactions detail view.

## Backups, export, jobs and start-up

- N12 (S, polish) A job cut off by a stop can wait about an hour to run again (Sidequest's stale-job defaults); meets the spec, check the timing. In: src/jobs/sidequest.ts.
- N63 (S, polish) No test fails if the `^` anchor leaves `RELEASE_TAG`. In: src/updates.
- N96 (S, cannot tell) Marks under the old step name stay unread in the database. In: src/db/.
- N163 (S, polish) The PRAGMA test checks how the word is written, not what SQL is sent; add a test that records every SQL string `readEverySetting` sends. In: src/db/pragma.test.ts, src/db/testing.ts.
- N166 (S, polish) Running as root, no start-level test shows the start stopping on a failed safety copy. In: src/server/start.test.ts.
- N195 (S, polish) The data export reads outside one transaction, so a sync during it can make `linked_ids` or `data.json` parts disagree; a second download fixes it. In: src/db/data-export.ts.
- N196 (S, polish) The export's 4 GB stop is checked only after a file streams, and has no test. In: src/server/zip.ts.
- N198 (S, polish) The export's status cell is lower case `pending`/`posted`; spec 11 says "Pending or posted". In: src/server/data-export.ts or spec 11.
- N249 (S, polish) Optional: pin the Compose subnet so the Tailscale gateway address stays fixed. In: docker/ compose file.
- N271 (M, polish) A hung backup mount still hangs start-up: `chooseBackupFolder` runs `stat`, `mkdir` and `chmod` with no time limit, and `docker/entrypoint.sh` runs `find /backups` and `chmod` before Node starts. Fix both together. In: src/backups/folder.ts, docker/entrypoint.sh.
- N272 (S, polish) On a hung backup mount the stop still ends with Docker's kill, because `process.exit(0)` waits while a file-system thread is blocked. In: src/server/stop.ts.
- N273 (S, polish) `VACUUM INTO` and the integrity check run synchronously, so no time limit covers them and Member writes wait during a backup (under 1 s on 5 years of history); a copy that timed out can still run `VACUUM INTO` later into an untracked temporary file, which the next start deletes. In: src/db/backup.ts, src/backups/.
- N274 (S, polish) The backup folder code follows a `/data/backups` that is itself a link; fix the "follows no link" wording or skip a linked folder. In: src/backups/folder.ts.
- N275 (S, security) Add `cap_drop` for the root `docker-init` process. In: compose.yaml.
- N276 (S, polish) Platforms without Compose can still miss a stop in the first half second. In: src/server/main.ts.
- N282 (S, flaky test) The install drill can fail if the 30-second TOTP step rolls over mid-step. In: scripts/quick-start-test.sh.
- N283 (S, security) The drill containers keep normal outbound network; an internal-only Compose network would guarantee no request leaves. In: scripts/quick-start-test.sh.

## Specs

- N164 (S, polish) Spec 10: "The one other use" should read "The one other use in code" (the migration pair is also a use). In: spec 10.
- N191 (S, polish) Undo of an accepted redraft keeps its inputs recorded, so the trigger does not repeat (matches Skip; spec 05 silent). In: spec 05.
- N227 (S, polish) Spec 05 says the days of history run "to the day the app computes", but the code counts to the day m's figure is set (the day before the 1st for the Month start). In: spec 05.
- N277 (S, polish) Spec 02's first sentence says raw data holds no personal detail, which contradicts the D20 line that keeps `verification_name`. In: docs/spec/02.

## Tests

- N88 (M, flaky test) Run the full suite with the clock a year ahead and fix every date-bound test. In: test suite.
- N278 (S, polish) No test fails without the `connectionId !== null` filter in `balanceTile`; without it a Manual loan makes Debt say "estimated usual". In: src/server/bank-data.ts.
- N279 (S, polish) No test covers the `main.ts` stop wiring, and the auth test's `holding === false` check is weak alone. In: src/server/main.ts, src/auth/.

## Owner

- N44 (S, owner) Nobody has run update mode (Repair, Add accounts) or the OAuth pop-up by hand on the Plaid sandbox. In: Plaid sandbox, by hand.
- N187 (S, owner) An install with no AI provider, already past its history wait, never gets the first AI run when AI is set up. In: src/redo/redo.ts.
