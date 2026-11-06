import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HistoryStatusView } from "../../server/bank-views.ts";
import { historyLoadEnded, loadingLine, readHistoryAgain, statusLines } from "../dashboard.ts";
import { startPolling } from "../polling.ts";
import { SignedOut } from "../requests.ts";
import { HISTORY_POLL, StatusLineList } from "./Dashboard.tsx";

// The dashboard's "Your history is loading" list: each bank's progress, read again while a load
// runs, with a cap.

const loading = (connectionId: string, transactions: number, oldestDate: string | null) => ({
  connectionId,
  bankName: connectionId === "c1" ? "Bluebird Credit Union" : "Harbor Savings Bank",
  transactions,
  oldestDate,
  holdsBackAi: true,
});

const HISTORY: Pick<HistoryStatusView, "loading"> = {
  loading: [loading("c1", 1_240, "2025-03-03"), loading("c2", 312, "2025-08-14")],
};

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const shown = (live?: "polling" | "ended" | "gave up") =>
  text(
    renderToString(
      <StatusLineList
        lines={statusLines([], [], HISTORY)}
        onClose={() => {}}
        onRetry={() => {}}
        onChanged={() => {}}
        {...(live === undefined ? {} : { live })}
      />,
    ),
  );

describe("the dashboard while history loads", () => {
  it("shows each bank's Transactions so far and how far back they go", () => {
    expect(loadingLine(loading("c1", 1_240, "2025-03-03"))).toBe(
      "1,240 Transactions · back to Mar 2025",
    );
    expect(loadingLine(loading("c1", 1, null))).toBe("1 Transaction");
    expect(shown()).toBe(
      "Your history is loading Numbers on this page grow as each bank sends older Transactions. The app tells you when all of it is in. Bluebird Credit Union 1,240 Transactions · back to Mar 2025 Harbor Savings Bank 312 Transactions · back to Aug 2025",
    );
  });

  it("marks the list Live while it reads again, and says so when it gave up", () => {
    expect(shown("polling")).toContain("Your history is loading Live");
    expect(shown("ended")).not.toContain("Live");
    expect(shown("gave up")).toContain(
      "This page stopped checking. Reload it to see newer progress.",
    );
    // At most 10 minutes of reads.
    expect(HISTORY_POLL.everyMs * HISTORY_POLL.maxReads).toBeLessThanOrEqual(10 * 60_000);
  });

  it("reads the whole page again only once a bank's load ended", () => {
    const grew = {
      loading: [loading("c1", 2_000, "2024-11-01"), loading("c2", 400, "2025-06-01")],
    };
    const oneDone = { loading: [loading("c2", 400, "2025-06-01")] };

    expect(historyLoadEnded(HISTORY, grew)).toBe(false);
    expect(historyLoadEnded(HISTORY, oneDone)).toBe(true);
    expect(historyLoadEnded(HISTORY, { loading: [] })).toBe(true);
    // A bank that starts loading meanwhile ends nothing.
    expect(historyLoadEnded(oneDone, HISTORY)).toBe(false);
  });
});

describe("the dashboard's history poll, one read at a time", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const status = (list: HistoryStatusView["loading"]): HistoryStatusView => ({
    waitEnded: false,
    aiMayRun: false,
    loading: list,
  });
  const ONE_DONE = status([loading("c2", 900, "2024-02-01")]);
  const io = (fresh: HistoryStatusView | Error, whole = true) => ({
    history: vi.fn(async () => {
      if (fresh instanceof Error) throw fresh;
      return fresh;
    }),
    whole: vi.fn(async () => whole),
    show: vi.fn(),
    signedOut: vi.fn(),
  });

  it("shows the new progress while no load ended, and keeps reading", async () => {
    const grew = status([loading("c1", 2_000, "2024-11-01"), loading("c2", 400, "2025-06-01")]);
    const reads = io(grew);

    expect(await readHistoryAgain(HISTORY, reads)).toBe(true);
    expect(reads.show).toHaveBeenCalledWith(grew);
    expect(reads.whole).not.toHaveBeenCalled();
  });

  it("reads the whole page when a bank's load ended, and stops when none runs", async () => {
    const reads = io(ONE_DONE);
    expect(await readHistoryAgain(HISTORY, reads)).toBe(true);
    expect(reads.whole).toHaveBeenCalledTimes(1);
    expect(reads.show).not.toHaveBeenCalled();

    const last = io(status([]));
    expect(await readHistoryAgain(ONE_DONE, last)).toBe(false);
    expect(last.whole).toHaveBeenCalledTimes(1);
  });

  it("keeps reading when the whole page fails to load after a bank finished", async () => {
    const reads = io(status([]), false);
    expect(await readHistoryAgain(HISTORY, reads)).toBe(true);
    expect(reads.whole).toHaveBeenCalledTimes(1);
  });

  it("stops and sends the Member to sign-in when the session ended", async () => {
    const reads = io(new SignedOut());
    expect(await readHistoryAgain(HISTORY, reads)).toBe(false);
    expect(reads.signedOut).toHaveBeenCalledTimes(1);
    expect(reads.whole).not.toHaveBeenCalled();

    // Another failure counts toward the cap as before.
    await expect(readHistoryAgain(HISTORY, io(new Error("offline")))).rejects.toThrow("offline");
  });

  it("tries the whole page again on the next read until it loads, so a finished bank leaves the list", async () => {
    vi.useFakeTimers();
    // The dashboard as the poll sees it: the progress it shows, and the whole page's answers.
    let shown: Pick<HistoryStatusView, "loading"> = HISTORY;
    const wholeAnswers = [false, false, true];
    const page = {
      history: vi.fn(async () => status([])),
      whole: vi.fn(async () => {
        const read = wholeAnswers.shift() ?? true;
        if (read) shown = status([]);
        return read;
      }),
      show: (fresh: HistoryStatusView) => {
        shown = fresh;
      },
      signedOut: () => {},
    };
    const onEnd = vi.fn();
    startPolling(() => readHistoryAgain(shown, page), HISTORY_POLL, onEnd);

    await vi.advanceTimersByTimeAsync(HISTORY_POLL.everyMs * 2);
    expect(page.whole).toHaveBeenCalledTimes(2);
    expect(shown).toBe(HISTORY);
    expect(onEnd).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HISTORY_POLL.everyMs);
    expect(page.whole).toHaveBeenCalledTimes(3);
    expect(shown.loading).toEqual([]);
    expect(onEnd).toHaveBeenCalledWith("ended");
  });
});
