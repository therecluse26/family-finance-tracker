import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HistoryStatusView } from "../../server/bank-views.ts";
import { historyLoadEnded, loadingLine, statusLines } from "../dashboard.ts";
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
