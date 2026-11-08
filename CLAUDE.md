# Rules for every agent in this repo

These rules apply to every builder, reviewer and helper agent, whatever its brief says. A brief may add rules. It never removes these.

## Security (hard rules)

- Use only the fake adapter, the local fake Plaid server, and AI SDK test models. Never call Plaid, not even the sandbox. Never use real Plaid tokens, Production keys, real bank data, or real AI keys.
- Do not read any file outside the repo and your own scratch folder that might hold secrets.
- Never write a secret, a key, or personal data into code, tests, commits, PR text, or logs. Generate test keys and tokens at test time.
- Never send the owner's email, name, or any personal detail to any outside service, including in a User-Agent or request header. If a site demands contact details, stop and tell the orchestrator.
- The AI provider gets Household data as it is, with no privacy filter (owner decision, 2026-11-07). Never send a secret, a key or a token to the AI.
- Never add a license exception or an audit exception yourself. Stop and tell the orchestrator.

## Git

- Do not use the `gh` CLI or the GitHub API. Use plain git over SSH.
- Never push to `main`. Only the orchestrator merges.
- Before your first push, rebase on `origin/main` if it moved. After it, never rebase and never force-push.
- Do not merge `main` into a pushed branch just to stay current. The orchestrator merges a branch that is behind `main` and runs every check on the merged tree. Merge `main` (with `git merge origin/main`) only when the orchestrator asks, because a code conflict needs your judgment.
- Number new migrations after the last one on `main` when you start. Write them only with `pnpm db:generate`, never by hand, so they can be regenerated. If another branch takes your number first, do nothing: the orchestrator regenerates your migration after `main`'s last one when it merges.
- Never run host-wide Docker cleanup (`docker system prune`, `docker image prune`, and so on).

## Keep each agent small

Every tool call sends the whole conversation to the model again. Each call costs more as the context grows, so fewer calls and less output matter more than anything else here.

- Find before you read. Use `rg -n` or `grep -n` to find the lines, then read only those ranges with some lines around them. Do not `cat` a whole large file to find one function.
- Batch reads. Read all the files or line ranges you need in one command, not one call per file or range.
- Do not read a file again if it is already in your context and has not changed.
- Keep command output short. Send long output to a file, and print only the end or the matching lines, for example `| tail -n 40`.
- Put several test files in one `pnpm vitest run` call.
- Reviewers start from `git diff --stat origin/main...HEAD`. Then they read the diff of the files that matter, a few files per call. Do not print the whole diff of a large change at once.
- Reports to the orchestrator are short: what changed, the head, one line per check, and anything blocking. No full logs and no file dumps.

## Checks

- The full set is `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm check:licenses`, `pnpm check:audit`.
- While they work, builders run only `pnpm typecheck` and the test files near the change.
- Builders run the full set on the head they push, in one command. They save each output to `<scratch>/checks-<short head>/<check>.log` and print only one pass or fail line per check, plus the failing lines.
- Reviewers read those logs. If the logs exist for the head under review and all pass, reviewers run only the test files near the change and their own probes. Otherwise they run the full set.
- If a diff touches `package.json`, `pnpm-lock.yaml`, `licenses/`, `security/` or `scripts/`, reviewers always run `pnpm check:licenses` and `pnpm check:audit`.
- The orchestrator runs the full set on the exact merged tree before every push to `main`.

## Reviews

The orchestrator gives each ticket a review level in its brief.

- **Full review** (a reviewer agent) for a diff that touches security or privacy (K8, K15), auth or write routes, Plaid or bank sync, migrations or deletes, money math, or dependencies.
- **Light review** (the orchestrator itself, no agent) for every other diff, such as UI, copy, styling, docs or tests only. The orchestrator reads `git diff --stat`, the check logs and the PR text, and opens only the parts that look wrong.
- The orchestrator puts small tickets in the same area into one builder brief. One reviewer may review several small full-review diffs together.
- A ticket gets at most two review rounds. After the second round, the reviewer lists what is left, and the orchestrator fixes it or sends one last fix to the builder without another review. A third review round is only for a blocking security or privacy finding.
- Reviewers block only on bugs, failed checks, broken rules in this file, and missing tests for changed behavior. They list other notes in one short non-blocking list. They do not ask for style changes or rewording.

## Known findings: check these before you push

Each item was a blocking review finding at least once, and each cost a full review round. Builders check every item that applies to their diff before the first push. They list each one as ok or n/a under `## Evidence` in the PR text, for example "Known findings: K1 ok, K3 n/a". Reviewers check the items that apply too.

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
- **K8. No personal or secret field reaches storage, logs or errors.** Raw provider data drops every account-number-like or personal field at every depth: `account_number`, `account_numbers`, `payment_reference_number`, `reference_number`, `ppd_id`, `payer`, `payee`, `by_order_of`, `reason`, `account_owner`, `property_address`, `verification_insights`, and any new one in the Plaid types you touch. No raw error object reaches Sidequest or a log line; errors go through `src/log.ts`. Library errors such as rate limits map to their own status, not 500.
- **K9. Large-history check.** If a diff touches `src/bank/`, `src/money-movement/`, `src/categorization/`, `src/categories/`, `src/recurring/`, `src/merchants/` or `src/review/`, run `pnpm bench:history` (5 years, about 20,000 Transactions). Add a case in `src/large-history/cases/` for each changed request and follow-up job that has none. Paste its table into the PR text. Run it once, on the head you push. Reviewers do not run it again if the PR text has a table for the head under review. No request takes more than 1 s. A streamed download is timed until its response starts (1 s); the whole file has its own limit.
- **K10. Never decide on data the browser sends when the server can learn it.** Plaid Link metadata (bank ID, bank name, account list) comes from the browser. After the token exchange, every decision that depends on it (same bank, duplicate bank, which Connection to replace) uses Plaid's own answer from `/item/get` or `/accounts/get`. Test it with a browser value that differs from Plaid's.

- **K11. Every hold on a Connection is honored by every path that starts a sync.** The paths are the schedule, the start-up catch-up, Sync now, update mode and `update-finished`. Set the hold in the same write that creates or changes the row, so no window exists. Test each path with the hold set, and break the hold once in each.
- **K12. Re-matching never ends a hand-made link for the wrong reason.** A change that shrinks a candidate set (Exclude, a new filter) must not end Member links, and must not end app links only because a side changed state. A hand link still ends when a side is hidden or removed, or when a provider change makes it fail its hard filters, such as a different amount (spec 03, Undo and hand links). A re-link is the one exception: a hand link on a Transaction hidden as `replaced by re-link` moves to its new copy (spec 02, Link carry-over). Test a hand link and an app link through the change and back, and check the totals before, during and after.
- **K13, K14, K16, K17.** Retired on 2026-11-07, when the owner removed the AI privacy filter.
- **K15. Check the exact value you use, with the parser that uses it.** A URL, file name or date is checked in the form it is stored and sent, never in a re-parsed form. A URL a library sends must give the same host under that library's parser (web-push uses Node's `url.parse`); accept it only when it equals its own normalized form. A name with a date stamp counts only when the stamp round-trips and is not in the future. Test with `;`, `{`, `%2e`, a full-width dot, a tab, a leading space, an impossible date and a future date.
- **K18. Reserve a cap before the first await.** A check, then an await, then a record lets parallel requests all pass the check. Take the place in the same synchronous step as the check, and give it back on a refusal or a failure before the work starts. Test with requests fired in parallel.
When a review blocks on something new that could happen again, the orchestrator adds it here as the next K number.

## Writing

- Use the terms in `GLOSSARY.md` in code names, tests, comments and PR text.
- Match the surrounding code's style, naming, comment density and test patterns.
