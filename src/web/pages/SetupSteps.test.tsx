import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlaidView } from "../../bank/plaid-view.ts";
import type { AccountView, ConnectionView } from "../../server/bank-views.ts";
import type { SetupProgressView } from "../../server/setup-views.ts";
import { skippedWizardSteps } from "../setup-gate.ts";
import {
  BanksButtons,
  BanksStepView,
  confirmMasterKeySaved,
  DoneStepView,
  FinishStepView,
  finishLines,
  finishWizard,
  STEP_LABELS,
  Stepper,
  skipBanks,
  stepAfter,
  stepBefore,
  WIZARD_STEPS,
} from "./SetupSteps.tsx";

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
          connections={connections}
          accounts={[ACCOUNT]}
          fakeBank={fakeBank}
          onPlaidSaved={() => {}}
          onLinked={() => {}}
        />,
      ),
    );

  it("asks for the Plaid keys first, then offers Plaid Link once they are saved", () => {
    const before = view(NO_KEYS, false);
    expect(before).toContain("Plaid keys");
    expect(before).toContain("Test and save the keys");
    expect(before).toContain("Enter the Plaid keys to link a bank.");
    expect(before).not.toContain("Link a new bank");

    const after = view(KEYS_SAVED, false);
    expect(after).toContain("The secret is set.");
    expect(after).toContain("Link a new bank");
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
