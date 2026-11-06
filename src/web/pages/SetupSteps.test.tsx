import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaidView } from "../../bank/plaid-view.ts";
import type { AccountView, ConnectionView } from "../../server/bank-views.ts";
import type { SetupProgressView } from "../../server/setup-views.ts";
import { SignedOut } from "../requests.ts";
import { skippedWizardSteps } from "../setup-gate.ts";
import {
  BANKS_STEP_UNREAD,
  BanksButtons,
  type BanksStepReads,
  type BanksStepState,
  BanksStepView,
  confirmMasterKeySaved,
  DoneStepView,
  FinishStepView,
  finishLines,
  finishWizard,
  linkedBanks,
  openBanksStep,
  STEP_LABELS,
  Stepper,
  skipBanks,
  stepAfter,
  stepBefore,
  WIZARD_STEPS,
} from "./SetupSteps.tsx";
import { CONNECTIONS_UNREAD, Refused, SYNC_POLL } from "./settings/connections-page.ts";

// The first-run wizard's frame and its steps 5 and 6, as the browser first paints them (spec 12,
// The first-run wizard). What makes each step done is checked through the app's HTTP interface, in
// src/server/setup-steps-api.test.ts and src/server/master-key.test.ts.

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const NO_KEYS: PlaidView = {
  clientId: null,
  secretSet: false,
  itemsUsed: 0,
  appItems: 0,
  itemLimit: 10,
};
const KEYS_SAVED: PlaidView = { ...NO_KEYS, clientId: "client-id-for-the-test", secretSet: true };

const CONNECTION: ConnectionView = {
  id: "c1",
  provider: "fake",
  bankName: "First Fake Bank",
  health: "healthy",
  historyLoaded: false,
  lastSyncedAt: null,
  nextSyncAt: null,
  actions: { repairInApp: true, importExisting: true, refresh: true },
  removed: false,
  held: false,
};

const ACCOUNT: AccountView = {
  id: "a1",
  connectionId: "c1",
  name: "Checking",
  kind: "depository",
  subtype: "checking",
  institutionName: "First Fake Bank",
  mask: "1234",
  currentBalance: 100,
  availableBalance: 100,
  creditLimit: null,
  estimated: false,
  excluded: false,
  closed: false,
  closedAt: null,
};

describe("the wizard's frame", () => {
  it("has 6 steps, in order", () => {
    expect(WIZARD_STEPS.map((step) => STEP_LABELS[step])).toEqual([
      "Setup link",
      "Your login",
      "Master key",
      "Household",
      "Banks",
      "Finish",
    ]);
  });

  it('says "Step N of 6", names each step, and marks the steps done', () => {
    const html = renderToString(<Stepper shown="master key" reached="household facts" />);

    expect(text(html)).toBe(
      "Step 3 of 6 ✓ Setup link ✓ Your login ✓ Master key 4. Household 5. Banks 6. Finish",
    );
    expect(html).toContain('aria-current="step"');
  });

  it("shows a skipped Banks step as not done, after Skip for now and after a reload on Finish", () => {
    // The server's answer to Skip for now, and to GET /api/setup/progress after a reload: both
    // record Banks as skipped.
    const afterSkip: SetupProgressView = {
      next: "finish",
      steps: { banks: "skipped", ai: null, alerts: null, "invite members": null },
      finishSetup: ["banks", "ai", "alerts", "invite members"],
      connections: 0,
    };
    const skipped = skippedWizardSteps(afterSkip);
    const html = renderToString(<Stepper shown="finish" reached="finish" skipped={skipped} />);

    expect(text(html)).toBe(
      "Step 6 of 6 ✓ Setup link ✓ Your login ✓ Master key ✓ Household 5. Banks (skipped) 6. Finish",
    );
    expect(text(html)).not.toContain("✓ Banks");
    // Back to Banks from Finish: still skipped, not done.
    expect(
      text(renderToString(<Stepper shown="banks" reached="finish" skipped={skipped} />)),
    ).toContain("5. Banks (skipped)");
    // Once a bank is linked, Banks is done.
    const linked = skippedWizardSteps({
      ...afterSkip,
      steps: { ...afterSkip.steps, banks: "done" },
    });
    expect(
      text(renderToString(<Stepper shown="finish" reached="finish" skipped={linked} />)),
    ).toContain("✓ Household ✓ Banks 6. Finish");
  });

  it("opens the step before with Back, and the step after with Continue", () => {
    expect(stepBefore("setup link")).toBeUndefined();
    expect(stepBefore("first member")).toBe("setup link");
    expect(stepBefore("finish")).toBe("banks");
    expect(stepAfter("household facts")).toBe("banks");
    expect(stepAfter("finish")).toBeUndefined();
  });

  it("says where Continue goes from a step already done", () => {
    const html = text(
      renderToString(
        <DoneStepView
          lines={["Your login is made, and you are signed in."]}
          next="Continue to the Master key"
          onNext={() => {}}
        />,
      ),
    );

    expect(html).toBe("Your login is made, and you are signed in. Continue to the Master key");
  });
});

describe("step 5, Banks", () => {
  const view = (plaid: PlaidView, fakeBank: boolean, connections: ConnectionView[] = []) =>
    text(
      renderToString(
        <BanksStepView
          plaid={plaid}
          view={{ ...CONNECTIONS_UNREAD, connections, accounts: [ACCOUNT], fakeBank }}
          onPlaidSaved={() => {}}
          onLinked={() => {}}
        />,
      ),
    );

  it("asks for the Plaid keys first, then offers Plaid Link once they are saved", () => {
    const before = view(NO_KEYS, false);
    expect(before).toContain("Plaid keys");
    expect(before).toContain("Test and save the keys");
    expect(before).toContain("To link a real bank through Plaid, save the Plaid keys above.");
    expect(before).not.toContain("Link a new bank");

    const after = view(KEYS_SAVED, false);
    expect(after).toContain("The secret is set.");
    expect(after).toContain("Link a new bank");
    expect(after).not.toContain("save the Plaid keys");
  });

  it("says the keys are for real banks only, not that nothing works without them", () => {
    // A fake bank is linked, and no Plaid keys are saved.
    const linked = view(NO_KEYS, true, [CONNECTION]);

    expect(linked).toContain("First Fake Bank");
    expect(linked).toContain("To link a real bank through Plaid, save the Plaid keys above.");
    expect(linked).not.toMatch(/save the keys first|Enter the Plaid keys to link a bank/i);
  });

  it("does not list a removed Connection, nor count it as a bank linked", () => {
    const removed = { ...CONNECTION, removed: true };

    expect(view(KEYS_SAVED, false, [removed])).toContain("No bank is connected yet.");
    expect(linkedBanks({ ...CONNECTIONS_UNREAD, connections: [removed] })).toEqual([]);
    expect(linkedBanks({ ...CONNECTIONS_UNREAD, connections: [removed, CONNECTION] })).toEqual([
      CONNECTION,
    ]);
  });

  it("offers the fake bank only under pnpm dev", () => {
    expect(view(KEYS_SAVED, true)).toContain("Link a fake bank (dev only)");
    expect(view(KEYS_SAVED, false)).not.toContain("Link a fake bank");
  });

  it("lists the banks linked so far, with their Accounts", () => {
    const shown = view(KEYS_SAVED, true, [CONNECTION]);

    expect(shown).toContain("First Fake Bank");
    expect(shown).toContain("Checking ··1234");
    expect(view(KEYS_SAVED, true)).toContain("No bank is connected yet.");
  });

  it("offers no Account by hand, no Manual loan, no import, and no sandbox dry run", () => {
    const shown = view(KEYS_SAVED, true);

    expect(shown).not.toContain("Add an Unconnected account");
    expect(shown).not.toContain("Add a Manual loan");
    expect(shown).not.toContain("Import");
    expect(shown).not.toMatch(/sandbox|dry run/i);
    expect(shown).toContain("use Settings, Banks after setup");
  });

  const buttons = (linked: boolean, notDone?: string) =>
    renderToString(
      <BanksButtons
        busy={false}
        linked={linked}
        notDone={notDone}
        error={undefined}
        onBack={() => {}}
        onSkip={() => {}}
        onContinue={() => {}}
      />,
    );

  it("keeps Continue off until a bank is linked, and always offers Back and Skip for now", () => {
    const off = buttons(false);
    expect(text(off)).toBe("Back Skip for now Continue to Finish");
    expect(off).toMatch(/<button[^>]*disabled=""[^>]*>Continue to Finish/);

    const on = buttons(true);
    expect(on).not.toMatch(/<button[^>]*disabled=""[^>]*>Continue to Finish/);
    expect(on).not.toMatch(/<button[^>]*disabled=""[^>]*>Skip for now/);
  });

  it("says why Continue did not go on", () => {
    expect(text(buttons(true, "Link a bank first, or press Skip for now."))).toBe(
      "Back Skip for now Continue to Finish Link a bank first, or press Skip for now.",
    );
  });
});

// A fake server for step 5's reads: each read answers what `server` holds when it is asked, unless
// a test holds the next Connection list read back with `holdNext`.
function fakeBanksServer() {
  const server = {
    connections: [] as ConnectionView[],
    accounts: [] as AccountView[],
    plaid: NO_KEYS,
    failure: undefined as Error | undefined,
  };
  const held: (() => void)[] = [];
  let holding = 0;
  const reads = {
    connections: vi.fn(async () => {
      if (server.failure !== undefined) throw server.failure;
      const answer = { connections: server.connections, fakeBank: true };
      if (holding === 0) return answer;
      holding -= 1;
      return new Promise<typeof answer>((resolve) => held.push(() => resolve(answer)));
    }),
    accounts: vi.fn(async () => ({ accounts: server.accounts })),
    history: vi.fn(async () => ({ waitEnded: false, aiMayRun: false, loading: [] })),
    plaid: vi.fn(async () => {
      if (server.failure !== undefined) throw server.failure;
      return { plaid: server.plaid };
    }),
  } satisfies BanksStepReads;
  const states: BanksStepState[] = [];
  const signedOut = vi.fn();
  const step = openBanksStep(reads, (state) => states.push(state), signedOut);
  return {
    server,
    reads,
    step,
    signedOut,
    states,
    last: () => states.at(-1) ?? BANKS_STEP_UNREAD,
    holdNext: () => {
      holding += 1;
    },
    release: () => held.shift()?.(),
  };
}

describe("step 5, Banks: a new bank's first sync, with no reload", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the new Connection at once, reads again until its Accounts arrive, then stops", async () => {
    vi.useFakeTimers();
    const { server, reads, step, last } = fakeBanksServer();
    step.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().plaid).toEqual(NO_KEYS);
    expect(last().page.poll).toBe("ended");
    expect(reads.connections).toHaveBeenCalledTimes(1);

    // "Link a fake bank": the server made the Connection, and its first sync runs.
    server.connections = [CONNECTION];
    step.linked();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().page.connections).toEqual([CONNECTION]);
    expect(last().page.accounts).toEqual([]);
    expect(last().page.poll).toBe("polling");
    // A Plaid link spends an Item, so the count is read again.
    expect(reads.plaid).toHaveBeenCalledTimes(2);

    // The first sync stores the Accounts: the next read shows them, with no reload.
    const synced = { ...CONNECTION, lastSyncedAt: "2026-11-06T14:00:00.000Z" };
    server.connections = [synced];
    server.accounts = [ACCOUNT];
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(last().page.accounts).toEqual([ACCOUNT]);
    const shown = text(
      renderToString(
        <BanksStepView
          plaid={NO_KEYS}
          view={last().page}
          onPlaidSaved={() => {}}
          onLinked={() => {}}
        />,
      ),
    );
    expect(shown).toContain("First Fake Bank Checking ··1234");

    // History loaded: the step stops reading.
    server.connections = [{ ...synced, historyLoaded: true }];
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(last().page.poll).toBe("ended");
    const readsAtEnd = reads.connections.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(readsAtEnd);
  });

  it("gives up at the cap, and starts a fresh count when the next bank is linked", async () => {
    vi.useFakeTimers();
    const { server, reads, step, last } = fakeBanksServer();
    server.connections = [CONNECTION];
    step.load();
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs * SYNC_POLL.maxReads);
    expect(last().page.poll).toBe("gave up");
    expect(reads.connections).toHaveBeenCalledTimes(1 + SYNC_POLL.maxReads);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(1 + SYNC_POLL.maxReads);

    server.connections = [CONNECTION, { ...CONNECTION, id: "c2" }];
    step.linked();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().page.poll).toBe("polling");
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(reads.connections).toHaveBeenCalledTimes(3 + SYNC_POLL.maxReads);
  });

  it("stops for good when the step leaves, and shows no answer that lands after", async () => {
    vi.useFakeTimers();
    const { server, reads, step, states, holdNext, release } = fakeBanksServer();
    server.connections = [CONNECTION];
    step.load();
    await vi.advanceTimersByTimeAsync(0);
    holdNext();
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs);
    expect(reads.connections).toHaveBeenCalledTimes(2);
    const shown = states.length;

    step.stop();
    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(2);
    expect(states).toHaveLength(shown);
  });

  it("stops reading and sends the Member to sign-in once when the session ends mid-poll", async () => {
    vi.useFakeTimers();
    const { server, reads, step, signedOut } = fakeBanksServer();
    server.connections = [CONNECTION];
    step.load();
    await vi.advanceTimersByTimeAsync(0);

    server.failure = new SignedOut();
    step.linked();
    await vi.advanceTimersByTimeAsync(SYNC_POLL.everyMs * 3);
    expect(signedOut).toHaveBeenCalledTimes(1);
    const after = reads.connections.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(after);
  });

  it("shows the server's words when the Plaid keys do not load, and keeps a saved count", async () => {
    vi.useFakeTimers();
    const { server, step, last, signedOut } = fakeBanksServer();
    server.failure = new Refused("Sign in again.");
    step.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().error).toBe("Sign in again.");
    expect(signedOut).not.toHaveBeenCalled();

    server.failure = undefined;
    step.plaidSaved(KEYS_SAVED);
    expect(last().plaid).toEqual(KEYS_SAVED);
    expect(last().error).toBeUndefined();
  });
});

describe("step 6, Finish", () => {
  const finish = (connections: number, extras: ("ai" | "alerts" | "invite members")[]) =>
    text(
      renderToString(
        <FinishStepView
          connections={connections}
          extras={extras}
          busy={false}
          error={undefined}
          onBack={() => {}}
          onOpen={() => {}}
          onExtra={() => {}}
        />,
      ),
    );

  it("says that history is loading, and that the dashboard shows it per Connection", () => {
    expect(finishLines(2)).toEqual([
      "Your banks' history is loading now. You can use the app while it loads.",
      "A full load can take a few hours. The dashboard shows the progress for each Connection.",
    ]);
  });

  it("says when there is no Connection, and points to the Finish setup list", () => {
    const html = finish(0, []);

    expect(html).toContain("The Household has no Connection yet, so no bank history is loading.");
    expect(html).toContain("from the &quot;Finish setup&quot; list on the dashboard");
    expect(html).toContain("Back Open the dashboard");
  });

  it("lists each optional extra not yet done, with the AI estimate", () => {
    const html = finish(1, ["ai", "alerts", "invite members"]);

    expect(html).toContain("Optional extras");
    expect(html).toContain("They also wait in the dashboard&#x27;s &quot;Finish setup&quot; list.");
    for (const line of ["AI helper", "Set up AI", "Alerts by email", "Set up Alerts"]) {
      expect(html).toContain(line);
    }
    expect(html).toContain("Invite Members Every Member sees the whole Household.");
    expect(html).toContain("Make an invite link");
    expect(html).toContain(
      "The first AI run on all history costs about $0.20. It counts against the AI cost cap.",
    );
    expect(html.indexOf("Open the dashboard")).toBeLessThan(html.indexOf("Optional extras"));
  });

  it("lists only the extras not done, and none once all are done", () => {
    const some = finish(1, ["alerts"]);
    expect(some).toContain("Alerts by email");
    expect(some).not.toContain("AI helper");
    expect(some).not.toContain("Make an invite link");

    expect(finish(1, [])).not.toContain("Optional extras");
  });
});

// The server answers 415 to a write without a JSON body, so each write the page makes must send
// one. src/server/setup-steps-api.test.ts and src/server/master-key.test.ts send these same
// requests.
describe("the requests the wizard sends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sent(write: () => Promise<unknown>) {
    const requests: { method: string; path: string; type: string | null; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push({
        method: init.method ?? "GET",
        path: String(input),
        type: new Headers(init.headers).get("content-type"),
        body: init.body,
      });
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    await write();
    return requests;
  }

  it("sends an empty JSON body with I saved it, Skip for now, and Open the dashboard", async () => {
    expect(await sent(confirmMasterKeySaved)).toEqual([
      { method: "POST", path: "/api/setup/master-key", type: "application/json", body: "{}" },
    ]);
    expect(await sent(skipBanks)).toEqual([
      {
        method: "POST",
        path: "/api/setup/steps/banks/skip",
        type: "application/json",
        body: "{}",
      },
    ]);
    expect(await sent(finishWizard)).toEqual([
      { method: "POST", path: "/api/setup/finish", type: "application/json", body: "{}" },
    ]);
  });
});
