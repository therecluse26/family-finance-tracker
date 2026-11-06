import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountView, ConnectionView, HistoryStatusView } from "../../../server/bank-views.ts";
import { SignedOut } from "../../requests.ts";
import {
  type ConnectionsPageView,
  type ConnectionsReads,
  createConnectionsPage,
  Refused,
  SYNC_POLL,
} from "./connections-page.ts";

// Settings → Banks reading by itself while a new bank's first sync runs: what it reads, when it
// stops, and which answer shows when reads overlap.

const SYNCED: ConnectionView = {
  id: "c1",
  provider: "plaid",
  bankName: "First Bank",
  health: "healthy",
  historyLoaded: true,
  lastSyncedAt: "2026-11-06T14:00:00.000Z",
  nextSyncAt: null,
  actions: { repairInApp: true, importExisting: true, refresh: true },
  removed: false,
  held: false,
};
const FIRST_SYNC: ConnectionView = {
  ...SYNCED,
  id: "c2",
  bankName: "Harbor Savings Bank",
  lastSyncedAt: null,
  historyLoaded: false,
};
const ACCOUNT: AccountView = {
  id: "a2",
  connectionId: "c2",
  name: "Checking",
  kind: "depository",
  subtype: "checking",
  institutionName: "Harbor Savings Bank",
  mask: "1234",
  currentBalance: 100,
  availableBalance: 100,
  creditLimit: null,
  estimated: false,
  excluded: false,
  closed: false,
  closedAt: null,
};

const LOADING: HistoryStatusView["loading"][number] = {
  connectionId: "c2",
  bankName: "Harbor Savings Bank",
  transactions: 312,
  oldestDate: "2025-08-14",
  holdsBackAi: true,
};

// A fake server: each read answers what `server` holds when it is asked, unless a test holds the
// next Connection list read back with `holdNext`.
function fakeServer(connections: ConnectionView[]) {
  const server = {
    connections,
    accounts: [] as AccountView[],
    loading: [] as HistoryStatusView["loading"],
    failure: undefined as Error | undefined,
  };
  const held: (() => void)[] = [];
  let holding = 0;
  const reads = {
    connections: vi.fn(async () => {
      if (server.failure !== undefined) throw server.failure;
      const answer = { connections: server.connections, fakeBank: false };
      if (holding === 0) return answer;
      holding -= 1;
      return new Promise<typeof answer>((resolve) => held.push(() => resolve(answer)));
    }),
    accounts: vi.fn(async () => ({ accounts: server.accounts })),
    history: vi.fn(
      async (): Promise<HistoryStatusView> => ({
        waitEnded: false,
        aiMayRun: false,
        loading: server.loading,
      }),
    ),
  } satisfies ConnectionsReads;
  return {
    server,
    reads,
    holdNext: () => {
      holding += 1;
    },
    // Lets the oldest held read answer, with the list it read when it was asked.
    release: () => held.shift()?.(),
  };
}

function open(reads: ConnectionsReads) {
  const views: ConnectionsPageView[] = [];
  const signedOut = vi.fn();
  const page = createConnectionsPage(reads, (view) => views.push(view), signedOut);
  const last = () => views.at(-1);
  return { page, views, last, signedOut };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Settings → Banks reading by itself", () => {
  it("reads nothing more while no first sync or history load runs", async () => {
    const { reads } = fakeServer([SYNCED]);
    const { page, last } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(1);
    expect(last()?.poll).toBe("ended");
  });

  it("reads again while a first sync runs, shows the Accounts when it ends, then stops", async () => {
    const { server, reads } = fakeServer([SYNCED, FIRST_SYNC]);
    const { page, last } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.poll).toBe("polling");
    expect(reads.accounts).toHaveBeenCalledTimes(1);

    // While nothing changes, each read is the Connection list alone.
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs * 2);
    expect(reads.connections).toHaveBeenCalledTimes(3);
    expect(reads.accounts).toHaveBeenCalledTimes(1);
    expect(reads.history).toHaveBeenCalledTimes(1);

    server.connections = [SYNCED, { ...FIRST_SYNC, lastSyncedAt: SYNCED.lastSyncedAt }];
    server.accounts = [ACCOUNT];
    server.loading = [LOADING];
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(reads.accounts).toHaveBeenCalledTimes(2);
    expect(last()?.accounts).toEqual([ACCOUNT]);
    expect(last()?.poll).toBe("polling");

    server.connections = [
      SYNCED,
      { ...FIRST_SYNC, lastSyncedAt: SYNCED.lastSyncedAt, historyLoaded: true },
    ];
    server.loading = [];
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(last()?.poll).toBe("ended");
    expect(last()?.loading).toEqual([]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(5);
  });

  it("stops for good when the page leaves, and shows no answer that lands after", async () => {
    const { reads, holdNext, release } = fakeServer([FIRST_SYNC]);
    const { page, views } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(0);
    holdNext();
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(reads.connections).toHaveBeenCalledTimes(2);
    const shown = views.length;

    page.stop();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(2);
    expect(views).toHaveLength(shown);
  });

  it("gives up at its cap, and starts a fresh count when the next bank is linked", async () => {
    const { server, reads } = fakeServer([FIRST_SYNC]);
    const { page, last } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs * SYNC_POLL.maxReads);
    expect(last()?.poll).toBe("gave up");
    expect(reads.connections).toHaveBeenCalledTimes(1 + SYNC_POLL.maxReads);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(1 + SYNC_POLL.maxReads);

    server.connections = [FIRST_SYNC, { ...FIRST_SYNC, id: "c3" }];
    page.linked();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.poll).toBe("polling");
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(reads.connections).toHaveBeenCalledTimes(3 + SYNC_POLL.maxReads);
  });

  it("starts reading when a bank linked while nothing ran has a first sync", async () => {
    const { server, reads } = fakeServer([SYNCED]);
    const { page, last } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.poll).toBe("ended");

    server.connections = [SYNCED, FIRST_SYNC];
    page.linked();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.connections).toHaveLength(2);
    expect(last()?.poll).toBe("polling");
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(reads.connections).toHaveBeenCalledTimes(3);
  });

  it("never lets a poll's older answer replace the list read after a link", async () => {
    const { server, reads } = fakeServer([FIRST_SYNC]);
    const held: (() => void)[] = [];
    const { page, last } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(0);

    // A poll's read asks for the list before the new bank is saved, and answers late.
    const before = { connections: [FIRST_SYNC], fakeBank: false };
    reads.connections.mockImplementationOnce(
      () => new Promise((resolve) => held.push(() => resolve(before))),
    );
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);

    server.connections = [FIRST_SYNC, { ...SYNCED, id: "c3", bankName: "Third Bank" }];
    page.linked();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.connections.map((c) => c.id)).toEqual(["c2", "c3"]);

    held.shift()?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.connections.map((c) => c.id)).toEqual(["c2", "c3"]);
    expect(last()?.poll).toBe("polling");
  });

  it("stops reading and sends the Member to sign-in once the session ends mid-poll", async () => {
    const { server, reads } = fakeServer([FIRST_SYNC]);
    const { page, last, signedOut } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(reads.connections).toHaveBeenCalledTimes(2);

    server.failure = new SignedOut();
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(signedOut).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(3);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(last()?.error).toBeUndefined();

    // A Member action after that reads nothing more either.
    page.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it("sends the Member to sign-in when the first read finds the session ended", async () => {
    const { server, reads } = fakeServer([FIRST_SYNC]);
    server.failure = new SignedOut();
    const { page, signedOut, views } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(signedOut).toHaveBeenCalledTimes(1);
    expect(reads.connections).toHaveBeenCalledTimes(1);
    expect(views).toEqual([]);
  });

  it("shows the server's words for a refusal, and a general line when the server does not answer", async () => {
    const { server, reads } = fakeServer([FIRST_SYNC]);
    server.failure = new Refused("Not now.");
    const { page, last } = open(reads);

    page.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.error).toBe("Not now.");

    server.failure = new Error("offline");
    page.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(last()?.error).toBe("The server did not answer.");
  });
});
