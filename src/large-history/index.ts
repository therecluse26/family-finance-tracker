// The large-history check (CLAUDE.md, K9): 5 years of one made-up Household's bank data, about
// 20,000 Transactions, loaded through the real sync path on the fake adapter, with timed requests
// and follow-up jobs.
//
// Run it: `pnpm bench:history`. It prints one table (path, time, limit) to paste into the PR text.
// It fails when a request takes more than 1 s or a job goes over its limit. It is not part of
// `pnpm test`. To run one case: `pnpm bench:history src/large-history/cases/totals.ts`.
//
// The first run builds the history and caches app.db in the OS temp folder, under
// fft-large-history/. A build takes about a minute; later runs on the same code start in seconds.
// A change to the app code or the migrations builds it again. See build.ts.
//
// Add a timed path: add one file in cases/, such as cases/merchant-rename.ts. Vitest finds it; no
// list names it. For a route a later ticket adds, such as renaming a Merchant:
//
//   import { runFollowUp } from "../../follow-up/index.ts";
//   import { timedCase } from "../index.ts";
//
//   timedCase("renaming a Merchant", async (history, time) => {
//     const id = ...; // Untimed setup reads history.database or history.generated.
//     await time.request("PUT /api/merchants/:id", () =>
//       history.browser.send("PUT", `/api/merchants/${id}`, { name: "Corner Bean" }),
//     );
//     await time.job("Follow-up after a Merchant rename", 10_000, () => runFollowUp());
//   });
//
// cases/exclude.ts is a full example.
//
// Each case gets its own copy of the built history, with a signed-in Member. Requests have the
// 1 s limit; give each job a limit with headroom. Build-time jobs are in build.ts.
//
// The build and each case start the app's modules from one list, modules.ts. A test fails when the
// app starts a module or a follow-up step that the list does not hold: add the module there, with
// its step and the build's limit for it.
//
// Not timed: POST /api/sync-now. It starts each sync on the job queue, which the bench does not run.
//
// Tests may use the built history too, such as to check totals against hand sums from
// `history.generated.shown`. openLargeHistory builds it on first use, which takes about a minute.
export type { BuildReport, TimingRow } from "./build.ts";
export {
  GENERATOR_VERSION,
  type GeneratedHistory,
  generateHistory,
  HISTORY_FIRST_DAY,
  HISTORY_LAST_DAY,
  type HistoryBank,
  K7_LINES,
  LATER_DAY,
} from "./history.ts";
export { type LargeHistory, openLargeHistory } from "./open.ts";
export { overLimit, REQUEST_LIMIT_MS, type Timer, timedCase } from "./timing.ts";
