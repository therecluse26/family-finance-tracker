import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaidView } from "../../bank/plaid-view.ts";
import type { AccountView, ConnectionView } from "../../server/bank-views.ts";
import type { SetupProgressView } from "../../server/setup-views.ts";
import { SignedOut } from "../requests.ts";
import { skippedWizardSteps } from "../setup-gate.ts";
import {
  BANKS_STEP_UNREAD,
  BanksButtons,
  BanksStep,
  type BanksStepReads,
  type BanksStepState,
  BanksStepView,
  confirmMasterKeySaved,
  DoneStepView,
  FinishStepView,
  finishLines,
  finishWizard,
  focusStepTitle,
  LinkedBankList,
  linkedBanks,
  movesFocusToTitle,
  openBanksStep,
  STEP_LABELS,
  STEP_TITLES,
  StepCard,
  Stepper,
  skipBanks,
  stepAfter,
  stepBefore,
  WIZARD_STEPS,
  WizardFrame,
} from "./SetupSteps.tsx";
import { NewBankLinks } from "./settings/Connections.tsx";
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

// The words of each item in the list of steps, as a screen reader reads them (the text without its
// tags), and the "Step N of 6" line.
const stepWords = (html: string) => [
  text(html.match(/<p[^>]*>(.*?)<\/p>/)?.[1] ?? ""),
  ...[...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((item) =>
    (item[1] ?? "").replace(/<!-- -->/g, "").replace(/<[^>]+>/g, ""),
  ),
];

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

    expect(stepWords(html)).toEqual([
      "Step 3 of 6",
      "✓ Setup link",
      "✓ Your login",
      "✓ Master key",
      "4. Household",
      "5. Banks",
      "6. Finish",
    ]);
    // The number and its period are one text run in the circle.
    expect(html).toMatch(/rounded-full[^"]*">4\.<\/span> <span>Household<\/span>/);
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

    expect(stepWords(html)).toEqual([
      "Step 6 of 6",
      "✓ Setup link",
      "✓ Your login",
      "✓ Master key",
      "✓ Household",
      "5. Banks (skipped)",
      "6. Finish",
    ]);
    expect(text(html)).not.toContain("✓ Banks");
    // Back to Banks from Finish: still skipped, not done.
    expect(
      stepWords(renderToString(<Stepper shown="banks" reached="finish" skipped={skipped} />)),
    ).toContain("5. Banks (skipped)");
    // Once a bank is linked, Banks is done.
    const linked = skippedWizardSteps({
      ...afterSkip,
      steps: { ...afterSkip.steps, banks: "done" },
    });
    expect(
      stepWords(renderToString(<Stepper shown="finish" reached="finish" skipped={linked} />)).slice(
        4,
      ),
    ).toEqual(["✓ Household", "✓ Banks", "6. Finish"]);
  });

  it("moves the focus to the new step's title after Continue or Back, not when the page opens", () => {
    expect(movesFocusToTitle(undefined, "setup link")).toBe(false);
    expect(movesFocusToTitle("master key", "master key")).toBe(false);
    expect(movesFocusToTitle("master key", "household facts")).toBe(true);
    expect(movesFocusToTitle("household facts", "master key")).toBe(true);

    const focused: string[] = [];
    const element = (name: string, tabindex?: string) => {
      const attributes = new Map(tabindex === undefined ? [] : [["tabindex", tabindex]]);
      return {
        attributes,
        hasAttribute: (key: string) => attributes.has(key),
        setAttribute: (key: string, value: string) => void attributes.set(key, value),
        focus: () => void focused.push(name),
      };
    };
    // The step's <h1> takes the focus, and stays out of the Tab order.
    const title = element("h1");
    const main = {
      ...element("main"),
      querySelector: (query: string) => (query === "h1" ? title : null),
    };
    focusStepTitle(main as unknown as Parameters<typeof focusStepTitle>[0]);
    expect(focused).toEqual(["h1"]);
    expect(title.attributes.get("tabindex")).toBe("-1");
    // With no <h1>, the <main> takes it.
    const bare = { ...element("main", "0"), querySelector: () => null };
    focusStepTitle(bare as unknown as Parameters<typeof focusStepTitle>[0]);
    expect(focused).toEqual(["h1", "main"]);
    expect(bare.attributes.get("tabindex")).toBe("0");
    focusStepTitle(null);
    expect(focused).toEqual(["h1", "main"]);
  });

  it('shows "Step N of 6" at every width: in the header below 768 px, in the list from 768 px', () => {
    const html = renderToString(
      <WizardFrame shown="banks" steps={<Stepper shown="banks" reached="banks" />}>
        <StepCard step="banks" />
      </WizardFrame>,
    );
    // The header's copy shows below md and hides from md; the list's shows from md only. One
    // breakpoint for both, so no width shows neither.
    expect(html).toMatch(
      /<span class="min-w-0 md:hidden" aria-hidden="true"><span[^>]*>Step <!-- -->5<!-- --> of <!-- -->6<\/span>/,
    );
    expect(html).toMatch(/<p class="[^"]*max-md:sr-only">Step <!-- -->5<!-- --> of <!-- -->6<\/p>/);
    expect(html).not.toMatch(/\bsm:hidden\b|max-sm:hidden/);
  });

  it("names each step in the page's one h1, before the step's own reads answer", () => {
    const h1s = (html: string) => [...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/g)].map((m) => m[1]);

    // The page reads which step to open.
    expect(h1s(renderToString(<StepCard step={undefined} />))).toEqual([
      "Set up Family Finance Tracker",
    ]);
    // Step 5 before its Plaid keys read answers.
    const banks = renderToString(
      <MemoryRouter>
        <BanksStep onBack={() => {}} onProgress={() => {}} />
      </MemoryRouter>,
    );
    expect(h1s(banks)).toEqual(["Connect your banks"]);
    expect(text(banks)).toContain("Back Skip for now Continue to Finish");
    // Step 6, with its extras in a card of their own.
    const finish = renderToString(
      <FinishStepView
        connections={1}
        extras={["ai"]}
        busy={false}
        error={undefined}
        onBack={() => {}}
        onOpen={() => {}}
        onExtra={() => {}}
      />,
    );
    expect(h1s(finish)).toEqual(["You are set up"]);
    // A step already done keeps its step's heading.
    expect(
      h1s(
        renderToString(
          <DoneStepView step="master key" lines={["Saved."]} next="Go" onNext={() => {}} />,
        ),
      ),
    ).toEqual(["Save your Master key"]);
    // Each step's heading differs.
    expect(new Set(WIZARD_STEPS.map((step) => STEP_TITLES[step])).size).toBe(WIZARD_STEPS.length);
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
          step="first member"
          lines={["Your login is made, and you are signed in."]}
          next="Continue to the Master key"
          onNext={() => {}}
        />,
      ),
    );

    expect(html).toBe(
      "Make your login Your login is made, and you are signed in. Continue to the Master key",
    );
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

  it("lists the banks linked so far, each with its count of Accounts, and no Account twice", () => {
    // The first sync has not run: no Account is stored yet.
    expect(view(KEYS_SAVED, true, [CONNECTION])).toContain(
      "First Fake Bank ✓ Linked First sync running: getting the Accounts",
    );
    // The Link panel lists a new bank's Accounts as they arrive, so the bank's card counts them.
    const synced = { ...CONNECTION, lastSyncedAt: "2026-11-06T14:00:00.000Z" };
    const shown = view(KEYS_SAVED, true, [synced]);
    expect(shown).toContain("First Fake Bank ✓ Linked 1 Account · loading history");
    expect(shown).not.toContain("Checking ··1234");
    // Only the bank's own Accounts count.
    const other = { ...ACCOUNT, id: "a2", connectionId: "c2" };
    expect(
      text(renderToString(<LinkedBankList connections={[synced]} accounts={[ACCOUNT, other]} />)),
    ).toBe("First Fake Bank ✓ Linked 1 Account · loading history");
    expect(view(KEYS_SAVED, true, [{ ...synced, historyLoaded: true }])).toContain(
      "First Fake Bank ✓ Linked 1 Account · history loaded",
    );
    expect(view(KEYS_SAVED, true)).toContain("No bank is connected yet.");
  });

  it("marks each bank with an icon, a color, and a word, and says what a bank needs", () => {
    const html = (connection: ConnectionView) =>
      renderToString(<LinkedBankList connections={[connection]} accounts={[ACCOUNT]} />);

    expect(html(CONNECTION)).toContain(
      '<span class="text-good"><span aria-hidden="true">✓ </span>Linked</span>',
    );
    const broken = html({ ...CONNECTION, health: "broken" });
    expect(broken).toContain('<span class="text-critical"><span aria-hidden="true">▲ </span>');
    expect(text(broken)).toBe(
      "First Fake Bank ▲ Disconnected Fix it in Settings, Banks after setup.",
    );
    const signIn = html({ ...CONNECTION, health: "needs a member" });
    expect(signIn).toContain('<span class="text-serious"><span aria-hidden="true">◆ </span>');
    expect(text(signIn)).toBe(
      "First Fake Bank ◆ Needs a sign-in Fix it in Settings, Banks after setup.",
    );
    expect(text(html({ ...CONNECTION, held: true }))).toBe(
      "First Fake Bank ● Not in use Another Connection already covers this bank, so it never syncs.",
    );
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
  // The Plaid settings reads held back, each answering what it read when it was asked.
  const heldPlaid: (() => void)[] = [];
  let holdingPlaid = 0;
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
      const answer = { plaid: server.plaid };
      if (holdingPlaid === 0) return answer;
      holdingPlaid -= 1;
      return new Promise<typeof answer>((resolve) => heldPlaid.push(() => resolve(answer)));
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
    holdNextPlaid: () => {
      holdingPlaid += 1;
    },
    releasePlaid: () => heldPlaid.shift()?.(),
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
    expect(shown).toContain("First Fake Bank ✓ Linked 1 Account · loading history");

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

describe("step 5, Banks: the Plaid keys read", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the Member to sign-in once, and reads nothing more, when it finds the session ended", async () => {
    vi.useFakeTimers();
    const { server, reads, step, signedOut } = fakeBanksServer();
    server.connections = [CONNECTION];
    // Only the Plaid read answers 401; the Connection list still answers.
    reads.plaid.mockImplementationOnce(async () => {
      throw new SignedOut();
    });
    step.load();
    await vi.advanceTimersByTimeAsync(0);
    expect(signedOut).toHaveBeenCalledTimes(1);

    const after = reads.connections.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads.connections).toHaveBeenCalledTimes(after);
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it("never lets an older answer replace a newer one or the keys just saved", async () => {
    vi.useFakeTimers();
    const { server, step, last, holdNextPlaid, releasePlaid } = fakeBanksServer();
    // The first read is held back, and answers NO_KEYS after a link's read answered.
    holdNextPlaid();
    step.load();
    await vi.advanceTimersByTimeAsync(0);
    server.plaid = { ...KEYS_SAVED, itemsUsed: 1 };
    step.linked();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().plaid).toEqual({ ...KEYS_SAVED, itemsUsed: 1 });
    releasePlaid();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().plaid).toEqual({ ...KEYS_SAVED, itemsUsed: 1 });

    // A read asked before the keys were saved answers after: the saved keys stay.
    server.plaid = NO_KEYS;
    holdNextPlaid();
    step.linked();
    await vi.advanceTimersByTimeAsync(0);
    step.plaidSaved(KEYS_SAVED);
    releasePlaid();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().plaid).toEqual(KEYS_SAVED);
  });
});

// Every element of `type` in a component's answer, at any depth. Components that use no hooks are
// called directly, so a test reads what each child is handed.
function elementsOf<P>(node: ReactNode, type: (props: P) => ReactNode): ReactElement<P>[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => elementsOf(child, type));
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const own = node.type === type ? [node as unknown as ReactElement<P>] : [];
  return [...own, ...elementsOf(node.props.children, type)];
}

describe("step 5, Banks: what its Link panels are handed", () => {
  it("hands Settings → Banks' Link panels the view the step's poll read, and its link handler", () => {
    const view = {
      ...CONNECTIONS_UNREAD,
      connections: [CONNECTION],
      accounts: [ACCOUNT],
      fakeBank: true,
      poll: "polling" as const,
    };
    const onLinked = () => {};
    const answer = BanksStepView({ plaid: KEYS_SAVED, view, onPlaidSaved: () => {}, onLinked });

    const [links, ...more] = elementsOf(answer, NewBankLinks);
    expect(more).toEqual([]);
    expect(links?.props).toEqual({ plaid: KEYS_SAVED, view, onLinked });
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
