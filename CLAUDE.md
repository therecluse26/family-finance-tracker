# Rules for every agent in this repo

These rules apply to every builder, reviewer and helper agent, whatever its brief says. A brief may add rules. It never removes these.

## Security (hard rules)

- Use only the fake adapter, the local fake Plaid server, and AI SDK test models. Never call Plaid, not even the sandbox. Never use real Plaid tokens, Production keys, real bank data, or real AI keys.
- Do not read any file outside the repo and your own scratch folder that might hold secrets.
- Never write a secret, a key, or personal data into code, tests, commits, PR text, or logs. Generate test keys and tokens at test time.
- Never send the owner's email, name, or any personal detail to any outside service, including in a User-Agent or request header. If a site demands contact details, stop and tell the orchestrator.
- No Member names, account numbers or card numbers go to the AI. The ZIP code and ages are never sent.
- Never add a license exception or an audit exception yourself. Stop and tell the orchestrator.

## Git

- Do not use the `gh` CLI or the GitHub API. Use plain git over SSH.
- Never push to `main`. Only the orchestrator merges.
- Before your first push, rebase on `origin/main` if it moved. After it, never rebase and never force-push.
- Do not merge `main` into a pushed branch just to stay current. The orchestrator merges a branch that is behind `main` and runs every check on the merged tree. Merge `main` (with `git merge origin/main`) only when the orchestrator asks, because a code conflict needs your judgment.
- Number new migrations after the last one on `main` when you start. Write them only with `pnpm db:generate`, never by hand, so they can be regenerated. If another branch takes your number first, do nothing: the orchestrator regenerates your migration after `main`'s last one when it merges.
- Never run host-wide Docker cleanup (`docker system prune`, `docker image prune`, and so on).

## Checks

- The full set is `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check:licenses`, `pnpm check:audit`.
- Builders run the full set on the head they push. They save each output to `<scratch>/checks-<short head>/<check>.log`.
- Reviewers read those logs. If the logs exist for the head under review and all pass, reviewers run `pnpm lint`, `pnpm typecheck`, the test files near the change, and their own probes. Otherwise they run the full set.
- If a diff touches `package.json`, `pnpm-lock.yaml`, `licenses/`, `security/` or `scripts/`, reviewers always run `pnpm check:licenses` and `pnpm check:audit`.
- The orchestrator runs the full set on the exact merged tree before every push to `main`.

## Known findings: check these before you push

Each item was a blocking review finding at least once, and each cost a full review round. Builders check every item that applies to their diff before the first push. They list each one as ok or n/a under `## Evidence` in the PR text, for example "Known findings: K1 ok, K3 n/a". Reviewers check them too.

- **K1. Every new write route has 401 and 403 tests.** No session gets 401. A cross-site Origin and a missing Origin each get 403. Each case changes nothing. A JSON route rejects a wrong content type with 415.
- **K2. Every filter on a write path has a test that fails without it.** This covers filters by kind, owner, hidden state or removed state. Write through the wrong row and see nothing change. Break each filter once and confirm a test fails.
- **K3. No n² work.** Never read every open Review list item, Transaction or Merchant inside a loop over Transactions. Read by kind and subject, or once per batch, and write in one statement. A job that can touch thousands of rows gets a timing test, for example 2,500 rows with a limit of a few seconds.
- **K4. Every retry or restart path has a cap and an end state.** Sidequest gives each job 5 attempts by default. Count restarts and stop after the cap. Raise one System notice. Test that a step which always throws stops. Start a job only from the event that makes it due, not from every sync.
- **K5. A partial failure still leads to the follow-up work.** If a sync stores some pages and then fails, the stored Transactions still get the follow-up job, the hooks and the marks. Test a failure partway through, then a retry.
- **K6. Every delete path handles new foreign keys.** Foreign keys are on in app.db. Check `deleteRemovedConnection` in `src/db/bank-data.ts`, and every other delete on `main`, against each new foreign key to `household_accounts`, `connections` or `transactions`. Use `ON DELETE CASCADE`, `SET NULL`, or an explicit delete in the same transaction. Test a parent delete with a child row present. Check again after each merge of `main`.
- **K7. Test the hard Merchant lines through the real cleanup rules.**
  - No provider Merchant name: `VENMO PAYMENT 1234567890 WEB ID`, `ZELLE PAYMENT TO 5551234`, `PAYPAL *INST XFER`, `CASH APP*SENT`, `VENMO CASHOUT`.
  - Names a person or shop: `VENMO *MORGAN LEE`, `ZELLE PAYMENT TO JOHN SMITH`, `PAYPAL *ETSY SHOP`, `CASH APP*JOHN SMITH`.
  - Store numbers, lead-ins and digit runs: `PURCHASE 1005 BLUEBIRD BOOKS`, `BEST BUY CO`, `XXXX4821`, `REF#12345678`, `(800) 555-1212`.
- **K8. No personal or secret field reaches storage, logs, errors or the AI.** Raw provider data drops every account-number-like or personal field at every depth: `account_number`, `account_numbers`, `payment_reference_number`, `reference_number`, `ppd_id`, `account_owner`, `property_address`, and any new one in the Plaid types you touch. No raw error object reaches Sidequest or a log line; errors go through `src/log.ts`. Library errors such as rate limits map to their own status, not 500.
- **K9. Large-history check.** If a diff touches `src/bank/`, `src/money-movement/`, `src/categorization/`, `src/categories/`, `src/recurring/`, `src/merchants/` or `src/review/`, run `pnpm bench:history` (5 years, about 20,000 Transactions). Add a case in `src/large-history/cases/` for each changed request and follow-up job that has none. Paste its table into the PR text. No request takes more than 1 s. A streamed download is timed until its response starts (1 s); the whole file has its own limit.
- **K10. Never decide on data the browser sends when the server can learn it.** Plaid Link metadata (bank ID, bank name, account list) comes from the browser. After the token exchange, every decision that depends on it (same bank, duplicate bank, which Connection to replace) uses Plaid's own answer from `/item/get` or `/accounts/get`. Test it with a browser value that differs from Plaid's.

- **K11. Every hold on a Connection is honored by every path that starts a sync.** The paths are the schedule, the start-up catch-up, Sync now, update mode and `update-finished`. Set the hold in the same write that creates or changes the row, so no window exists. Test each path with the hold set, and break the hold once in each.
- **K12. Re-matching never ends a hand-made link for the wrong reason.** A change that shrinks a candidate set (Exclude, a new filter) must not end Member links, and must not end app links only because a side changed state. A hand link still ends when a side is hidden or removed, or when a provider change makes it fail its hard filters, such as a different amount (spec 03, Undo and hand links). A re-link is the one exception: a hand link on a Transaction hidden as `replaced by re-link` moves to its new copy (spec 02, Link carry-over). Test a hand link and an app link through the change and back, and check the totals before, during and after.
- **K13. A privacy match works on a skeleton, not on a list of forms.** Before matching a protected value (a card or Account number, a last 4, the ZIP code, an age, a Member name), map every Unicode digit to 0-9, drop combining marks and format characters, and treat any short run of non-letter, non-digit characters as a gap. Match names on a letter-only, case-folded skeleton, including first and last names glued together. Remove the matched span from the original text. Test with forms the code never names: other dashes and scripts, glued names, ages in words.
- **K14. The privacy filter checks the exact characters the model reads.** Never filter text and then encode it (JSON, Markdown, HTML, URL), and never filter encoded text the model decodes: an escape such as `\n` puts a letter inside a card number or before a name. Turn control characters into spaces and make strings well-formed before encoding, so the encoder writes no letter escape. Test that the encoded text has no backslash followed by a letter, and test a card split by a newline and a name after a tab through the real filter.
- **K15. Check the exact value you use, with the parser that uses it.** A URL, file name or date is checked in the form it is stored and sent, never in a re-parsed form. A URL a library sends must give the same host under that library's parser (web-push uses Node's `url.parse`); accept it only when it equals its own normalized form. A name with a date stamp counts only when the stamp round-trips and is not in the future. Test with `;`, `{`, `%2e`, a full-width dot, a tab, a leading space, an impossible date and a future date.
- **K16. App-made numbers reach the AI as typed parts.** Amounts, dates and counts the app builds pass the privacy filter as typed parts, as tool results do. Only text a Member types and app text with names goes through the filter. An amount such as 49.99 otherwise matches a last 4 of 4999. Test with an Account last 4 equal to an amount in the text.
- **K17. Never trim or join text pieces so words touch before the privacy filter.** A name glued to its neighbor ("atDana") escapes a word match. Join pieces with a space and keep the spaces inside each piece. Test a Member's name inside a Merchant name through the real builder and the real filter.
- **K18. Reserve a cap before the first await.** A check, then an await, then a record lets parallel requests all pass the check. Take the place in the same synchronous step as the check, and give it back on a refusal or a failure before the work starts. Test with requests fired in parallel.
When a review blocks on something new that could happen again, the orchestrator adds it here as the next K number.

## Writing

- Use the terms in `GLOSSARY.md` in code names, tests, comments and PR text.
- Match the surrounding code's style, naming, comment density and test patterns.
