import type { Reporter, TestCase, Vitest } from "vitest/node";
import type { TimingRow } from "./build.ts";
import type { TimingMeta } from "./timing.ts";

// Prints one table of every case's rows at the end of `pnpm bench:history`, in Markdown, so it can
// go into the PR text as it is. Rows keep the case files' order, then each case's own order.

const ms = (value: number) => `${value.toLocaleString("en-US")} ms`;

// `runStarted` is when this run started, in milliseconds since 1970. A row the build timed before
// it is from a cached build of the same code, and says so.
export function timingTable(rows: readonly TimingRow[], runStarted = 0): string {
  const lines = rows.map((row) => {
    const cached = row.timedAt !== undefined && Date.parse(row.timedAt) < runStarted;
    const path = cached ? `${row.path} (cached build)` : row.path;
    const time = row.ms > row.limitMs ? `**${ms(row.ms)} (over)**` : ms(row.ms);
    return `| ${path} | ${time} | ${ms(row.limitMs)} |`;
  });
  return ["| Path | Time | Limit |", "| --- | --: | --: |", ...lines].join("\n");
}

export class TimingTableReporter implements Reporter {
  private vitest: Vitest | undefined;
  private started = 0;
  private readonly rows = new Map<string, TimingRow[][]>();

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
    this.started = Date.now();
  }

  onTestCaseResult(testCase: TestCase): void {
    const found = (testCase.meta() as TimingMeta).largeHistory;
    if (found === undefined) return;
    const file = testCase.module.moduleId;
    this.rows.set(file, [...(this.rows.get(file) ?? []), found]);
  }

  onTestRunEnd(): void {
    const rows = [...this.rows.keys()].sort().flatMap((file) => (this.rows.get(file) ?? []).flat());
    if (rows.length === 0) return;
    this.vitest?.logger.log(`\nLarge-history timings (K9)\n\n${timingTable(rows, this.started)}\n`);
  }
}
