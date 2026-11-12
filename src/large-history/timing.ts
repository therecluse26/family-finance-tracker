import { expect, it } from "vitest";
import { type TimingRow, timeWork } from "./build.ts";
import { useHistoryClock } from "./clock.ts";
import { type LargeHistory, openLargeHistory } from "./open.ts";

// K9: no request takes more than 1 s.
export const REQUEST_LIMIT_MS = 1_000;

// A case may take long: a first run builds the history.
const CASE_TIMEOUT_MS = 600_000;

export type Timer = {
  // Times one request through the app's HTTP interface, body included. `path` names the route,
  // such as "GET /api/transactions/:id". Throws unless the app answers 2xx. Returns the JSON body.
  request(path: string, send: () => Promise<Response>): Promise<unknown>;
  // Times one job, such as a sync or a follow-up run, against its limit.
  job<T>(path: string, limitMs: number, run: () => Promise<T>): Promise<T>;
  // Adds a row timed elsewhere, such as by the build.
  add(row: TimingRow): void;
};

// The rows over their limit, as the failure message names them.
export function overLimit(rows: readonly TimingRow[]): string[] {
  return rows
    .filter((row) => row.ms > row.limitMs)
    .map((row) => `${row.path}: ${row.ms} ms of CPU time, over its ${row.limitMs} ms limit`);
}

// Where a case's rows go for the table: the test's meta, which the reporter reads.
export type TimingMeta = { largeHistory?: TimingRow[] };

// One timed case, as a test on a new copy of the built history. It fails when a request takes
// more than 1 s, a job goes over its limit, or a request does not answer 2xx. Each limit counts
// CPU time, so a busy host does not fail a case (TimingRow). It runs on the history's clock
// (clock.ts), so it sees the history as it was on HISTORY_NOW, whatever the real date.
export function timedCase(
  name: string,
  run: (history: LargeHistory, time: Timer) => Promise<void>,
): void {
  it(
    name,
    async ({ task }) => {
      const rows: TimingRow[] = [];
      (task.meta as TimingMeta).largeHistory = rows;
      const measure = async <T>(path: string, limitMs: number, work: () => Promise<T>) => {
        const { result, ms, wallMs } = await timeWork(work);
        rows.push({ path, ms, wallMs, limitMs });
        return result;
      };
      const time: Timer = {
        request: (path, send) =>
          measure(path, REQUEST_LIMIT_MS, async () => {
            const res = await send();
            const body = await res.text();
            if (!res.ok) throw new Error(`${path} answered ${res.status}: ${body}`);
            return body === "" ? undefined : JSON.parse(body);
          }),
        job: measure,
        add: (row) => rows.push(row),
      };
      const realClock = useHistoryClock();
      try {
        const history = await openLargeHistory();
        try {
          await run(history, time);
        } finally {
          history.close();
        }
      } finally {
        realClock();
      }
      expect(overLimit(rows)).toEqual([]);
    },
    CASE_TIMEOUT_MS,
  );
}
