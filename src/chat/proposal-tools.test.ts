import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../db/index.ts";
import { newTestDatabase, type TestDatabase } from "../db/testing.ts";
import { chatProposals } from "../proposals/index.ts";
import { proposalTools } from "./proposal-tools.ts";

// Chat's Proposal tools on app.db's write queue: a propose call whose write never settles holds the
// queue only up to its time limit, and the next Chat Proposal is stored. The AI's words are made up,
// and the privacy filter is a stand-in that changes nothing.

const WRITE_LIMIT_MS = 300;
// Oct 20, 2026, 4 PM UTC.
const NOW = new Date("2026-10-20T16:00:00.000Z");
const RUN = "thread-1/answer-1";

const ai = { forScreen: async (text: string) => text, toolResult: async (data: unknown) => data };

// Makes the next transaction on app.db do its writes, then wait forever before it commits.
function stallNextTransaction(database: Database): Promise<void> {
  const original = database.transaction;
  const transaction = original.bind(database);
  return new Promise((stalled) => {
    database.transaction = ((work, config) => {
      database.transaction = original;
      return transaction(async (tx) => {
        await work(tx);
        stalled();
        return new Promise<never>(() => {});
      }, config);
    }) as typeof database.transaction;
  });
}

describe("Chat's Proposal tools", () => {
  let test: TestDatabase;

  beforeEach(async () => {
    test = await newTestDatabase({ writeLimitMs: WRITE_LIMIT_MS });
  });

  afterEach(() => {
    test.close();
  });

  it("stores the next Chat Proposal once a propose call whose write never settles reaches the time limit", async () => {
    const tools = proposalTools({ database: test.database, ai, runId: RUN, now: () => NOW });
    const stalled = stallNextTransaction(test.database);
    void tools.propose_goal?.run({ words: "Save for a car", reason: "It fits." });
    await stalled;

    const started = performance.now();
    expect(
      await tools.propose_goal?.run({ words: "Save for a trip", reason: "It fits too." }),
    ).toEqual({ result: "shown" });

    expect(performance.now() - started).toBeLessThan(WRITE_LIMIT_MS * 5);
    // The stalled write was rolled back: only the next one is stored.
    const stored = await chatProposals(test.database, RUN, NOW);
    expect(stored.map((each) => each.changes)).toEqual([[`New Goal: "Save for a trip"`]]);
  });
});
