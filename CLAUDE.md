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
- Before your first push, rebase on `origin/main` if it moved. After it, never rebase and never force-push. Take in new `main` with `git merge origin/main`.
- Number new migrations after the last one on `main`. On a clash, delete your migration in the merge and regenerate it. Then confirm `pnpm db:generate` reports no changes.
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
- **K8. No personal or secret field reaches storage, logs, errors or the AI.** Raw provider data drops every account-number-like field at every depth: `account_number`, `account_numbers`, `payment_reference_number`, and any new one in the Plaid types you touch. No raw error object reaches Sidequest or a log line; errors go through `src/log.ts`. Library errors such as rate limits map to their own status, not 500.
- **K9. Large-history check.** If a diff touches `src/bank/`, `src/money-movement/`, `src/categorization/`, `src/merchants/` or `src/review/`, run it on 5 years of synthetic history (about 20,000 Transactions). Time each changed request and follow-up job, and put the numbers in the PR text. No request takes more than 1 s.
- **K10. Never decide on data the browser sends when the server can learn it.** Plaid Link metadata (bank ID, bank name, account list) comes from the browser. After the token exchange, every decision that depends on it (same bank, duplicate bank, which Connection to replace) uses Plaid's own answer from `/item/get` or `/accounts/get`. Test it with a browser value that differs from Plaid's.

- **K11. Every hold on a Connection is honored by every path that starts a sync.** The paths are the schedule, the start-up catch-up, Sync now, update mode and `update-finished`. Set the hold in the same write that creates or changes the row, so no window exists. Test each path with the hold set, and break the hold once in each.
When a review blocks on something new that could happen again, the orchestrator adds it here as the next K number.

## Writing

- Use the terms in `GLOSSARY.md` in code names, tests, comments and PR text.
- Match the surrounding code's style, naming, comment density and test patterns.
