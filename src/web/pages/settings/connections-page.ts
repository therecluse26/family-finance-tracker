import type { AccountView, ConnectionView, HistoryStatusView } from "../../../server/bank-views.ts";
import { answerOrder, createPoller, type PollPlan, type PollState } from "../../polling.ts";
import { SignedOut } from "../../requests.ts";

// What Settings → Banks reads and shows: the Connections, their Accounts and history progress, and
// whether the page is still reading them by itself while a first sync or history load runs. It is
// plain code, apart from React, so a test can drive it with fake reads and a fake clock.

// One Connection's history load progress, from GET /api/history-status.
export type HistoryLoadingView = HistoryStatusView["loading"][number];

// Settings → Banks reads the Connection list again every 3 seconds while a Connection's first
// sync or history load runs, for at most 10 minutes. Each read is GET /api/connections alone; the
// Accounts and the history progress are read again only once a sync has finished.
export const SYNC_POLL: PollPlan = { everyMs: 3_000, maxReads: 200 };

// Whether a Connection's first sync or history load still runs, so the page keeps reading. One that
// needs a Member, is Broken, removed, or held stops: it waits on a Member.
export function syncRunning(connection: ConnectionView): boolean {
  if (connection.removed || connection.held) return false;
  if (connection.health !== "healthy" && connection.health !== "retrying") return false;
  return connection.lastSyncedAt === null || !connection.historyLoaded;
}

// What changes when a sync finishes or a Connection changes state. The page reads the Accounts and
// the history progress again only when this changes.
export function syncKey(connections: readonly ConnectionView[]): string {
  return connections
    .map((c) => [c.id, c.lastSyncedAt, c.historyLoaded, c.health, c.removed, c.held].join("|"))
    .join("\n");
}

// A refused read, with the server's words for the Member.
export class Refused extends Error {}

export type ConnectionsPageView = {
  connections: ConnectionView[];
  accounts: AccountView[];
  loading: HistoryLoadingView[];
  fakeBank: boolean;
  error: string | undefined;
  poll: PollState;
};

export const CONNECTIONS_UNREAD: ConnectionsPageView = {
  connections: [],
  accounts: [],
  loading: [],
  fakeBank: false,
  error: undefined,
  poll: "ended",
};

// The page's three reads. Each throws Refused for a refusal, and SignedOut for a 401.
export type ConnectionsReads = {
  connections(): Promise<{ connections: ConnectionView[]; fakeBank: boolean }>;
  accounts(): Promise<{ accounts: AccountView[] }>;
  history(): Promise<HistoryStatusView>;
};

export type ConnectionsPage = {
  // Reads everything again, as after a Member's change on the page.
  load(): void;
  // A bank was linked: a fresh count of reads starts, even after a give-up, and everything is read.
  linked(): void;
  // The page left: no read starts, and no answer shows.
  stop(): void;
};

// Hands `show` each new view. A 401 stops every read and calls `signedOut` once. When a poll's read
// and a Member's read overlap, an older answer never replaces a newer one.
export function createConnectionsPage(
  reads: ConnectionsReads,
  show: (view: ConnectionsPageView) => void,
  signedOut: () => void,
): ConnectionsPage {
  let view = CONNECTIONS_UNREAD;
  let round = 0;
  let stopped = false;
  // The syncKey of the list whose Accounts and history progress were last read.
  let detailsOf: string | undefined;
  const order = answerOrder();

  const set = (change: Partial<ConnectionsPageView>) => {
    if (stopped) return;
    view = { ...view, ...change };
    show(view);
  };
  const running = (connections: readonly ConnectionView[]) => connections.some(syncRunning);

  // Reads the Connection list. The Accounts and the history progress are read with it the first
  // time, after a change on this page (`all`), and when a sync has finished since the last read.
  // Every part is set together, so a Connection never shows synced without its Accounts. Answers
  // with the list shown after the read.
  async function refresh(all: boolean): Promise<ConnectionView[]> {
    const newest = order.begin();
    const listed = await reads.connections();
    const key = syncKey(listed.connections);
    let details: Pick<ConnectionsPageView, "accounts" | "loading"> | undefined;
    if (all || key !== detailsOf) {
      const [read, history] = await Promise.all([reads.accounts(), reads.history()]);
      details = { accounts: read.accounts, loading: history.loading };
    }
    if (stopped || !newest()) return view.connections;
    if (details !== undefined) detailsOf = key;
    set({
      ...details,
      connections: listed.connections,
      fakeBank: listed.fakeBank,
      error: undefined,
    });
    poller.update(running(listed.connections), SYNC_POLL, round);
    return listed.connections;
  }

  const stop = () => {
    stopped = true;
    poller.stop();
  };

  const failed = (failure: unknown) => {
    if (failure instanceof SignedOut) {
      if (stopped) return;
      stop();
      signedOut();
      return;
    }
    set({ error: failure instanceof Refused ? failure.message : "The server did not answer." });
  };

  // A poll's read that fails for another reason counts toward the cap, and shows nothing.
  const poller = createPoller(
    async () => {
      try {
        return running(await refresh(false));
      } catch (failure) {
        if (!(failure instanceof SignedOut)) throw failure;
        failed(failure);
        return false;
      }
    },
    (poll) => set({ poll }),
  );

  const load = () => {
    refresh(true).catch(failed);
  };

  return {
    load,
    linked() {
      round += 1;
      poller.update(running(view.connections), SYNC_POLL, round);
      load();
    },
    stop,
  };
}
