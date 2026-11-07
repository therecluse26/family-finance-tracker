import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import { timeLabel } from "../../../format.ts";
import type { UnconnectedAccountView } from "../../../server/bank-views.ts";
import type { ManualLoanView } from "../../../server/money-movement-views.ts";
import {
  ItemsUsedForm,
  NotSyncedList,
  PlaidKeysForm,
  SyncNow,
  SyncNowResults,
  syncNowLine,
} from "./Banks.tsx";

// Settings → Banks, as the browser paints it once the Plaid settings have loaded.

const NO_KEYS: PlaidView = {
  clientId: null,
  secretSet: false,
  itemsUsed: 0,
  appItems: 0,
  itemLimit: 10,
};

const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/<!-- -->/g, "");

describe("Settings → Banks", () => {
  it("shows at least N of 10 used", () => {
    const html = renderToString(
      <ItemsUsedForm plaid={{ ...NO_KEYS, itemsUsed: 3, appItems: 2 }} onSaved={() => {}} />,
    );

    expect(text(html)).toContain("At least 3 of 10 used");
    expect(html).toContain('min="2"');
  });

  it("asks for the client ID and the Production secret, with no code, and shows only that the secret is set", () => {
    const before = renderToString(<PlaidKeysForm plaid={NO_KEYS} onSaved={() => {}} />);
    const after = renderToString(
      <PlaidKeysForm
        plaid={{ ...NO_KEYS, clientId: "client-id-shown", secretSet: true }}
        onSaved={() => {}}
      />,
    );

    expect(text(before)).toContain("No Plaid keys yet.");
    expect(text(before)).toContain("Production secret");
    expect(text(before)).not.toMatch(/sandbox/i);
    expect(before).toContain('type="password"');
    expect(before).not.toContain("one-time-code");
    expect(text(after)).toContain("Client ID client-id-shown. The secret is set.");
  });

  it("says what Sync now did with each bank, and when a skipped one can sync again", () => {
    const base = { connectionId: "c1", bankName: "First Fake Bank" };
    const canSyncAt = new Date("2026-11-04T15:30:00.000Z");
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    expect(syncNowLine({ ...base, outcome: "syncing", refreshed: false })).toBe(
      "First Fake Bank: syncing now.",
    );
    expect(syncNowLine({ ...base, outcome: "syncing", refreshed: true })).toBe(
      "First Fake Bank: syncing now, and again in 5 minutes for the bank's fresh data.",
    );
    expect(
      syncNowLine(
        { ...base, outcome: "skipped", canSyncAt: canSyncAt.toISOString() },
        new Date(canSyncAt.getTime() - 60_000),
      ),
    ).toBe(
      `First Fake Bank synced a short while ago. It can sync again at ${timeLabel(canSyncAt, zone)}.`,
    );
    expect(text(renderToString(<SyncNowResults results={[]} />))).toBe("No bank is ready to sync.");
  });
});

const HSA: UnconnectedAccountView = {
  id: "acct-1",
  name: "Family HSA",
  kind: "HSA",
  institutionName: null,
  mask: null,
  closed: false,
  estimate: { balance: 840_000, state: "estimated", typedOn: null },
};

const FAMILY_LOAN: ManualLoanView = {
  id: "loan-1",
  lender: "Family loan",
  kind: "personal",
  balance: 300_000,
  balanceDate: "2026-10-05",
  apr: 0,
  regularPayment: null,
  escrow: null,
  loanType: "cash loan",
  setBy: "app",
};

const notSynced = (props: Partial<Parameters<typeof NotSyncedList>[0]>) =>
  renderToString(
    <NotSyncedList accounts={[]} loans={[]} today="2026-11-03" onSaved={() => {}} {...props} />,
  );

// The "+" buttons' own tags, by their words.
const plusButton = (html: string, words: string) =>
  new RegExp(`<button([^>]*)>\\${words}</button>`).exec(html)?.[1] ?? "";

describe("Settings → Banks: Unconnected accounts and Manual loans", () => {
  it("shows one card with a row for each, and both add forms closed behind their buttons", () => {
    const html = notSynced({ accounts: [HSA], loans: [FAMILY_LOAN] });

    expect(text(html)).toContain("Places your banks send money that Plaid cannot see");
    expect(text(html)).toContain("Family HSA · Unconnected account");
    expect(text(html)).toContain("$8,400, estimated");
    expect(text(html)).toContain("Family loan · Manual loan, Personal, Cash loan");
    expect(text(html)).toContain("$3,000 owed");
    expect(text(html)).not.toContain("yet.");
    expect(html).not.toContain("Add an Unconnected account");
    expect(html).not.toContain("Add a Manual loan");
    expect(plusButton(html, "+ Unconnected account")).toContain('aria-expanded="false"');
    expect(plusButton(html, "+ Manual loan")).toContain('aria-expanded="false"');
    expect(plusButton(html, "+ Manual loan")).not.toContain("aria-controls");
  });

  it("says when there are none, only once both lists have loaded", () => {
    expect(text(notSynced({}))).toContain("No Unconnected accounts or Manual loans yet.");
    expect(text(notSynced({ loans: undefined }))).not.toContain("yet.");
    expect(text(notSynced({ accounts: undefined }))).not.toContain("yet.");
  });

  it("opens Add a Manual loan at once when a link fills in the lender", () => {
    const html = notSynced({ lender: "Riverbank Lending" });

    expect(text(html)).toContain("Add a Manual loan");
    expect(html).toContain('value="Riverbank Lending"');
    expect(text(html)).toContain("Credit card");
    expect(plusButton(html, "+ Manual loan")).toContain('aria-expanded="true"');
    expect(plusButton(html, "+ Manual loan")).toContain('aria-controls="add-manual-loan"');
    expect(html).toContain('id="add-manual-loan"');
    expect(html).not.toContain("Add an Unconnected account");
  });

  it("has the #manual-loans part the Review list's untracked loan link names, open or closed", () => {
    // The link the server builds (src/money-movement/untracked-loans.ts, manualLoanFormPath).
    const id = "manual-loans";

    for (const html of [notSynced({}), notSynced({ lender: "Riverbank Lending" })]) {
      expect(html.match(new RegExp(`id="${id}"`, "g"))).toHaveLength(1);
    }
    // The form the link opens is inside that part.
    const open = notSynced({ lender: "Riverbank Lending" });
    expect(open.slice(open.indexOf(`id="${id}"`))).toContain('id="add-manual-loan"');
  });

  it("puts Sync now at the top of the tab, outside a card", () => {
    const html = renderToString(<SyncNow />);

    expect(html.startsWith('<section aria-labelledby="sync-now">')).toBe(true);
    expect(text(html)).toContain("Each bank syncs by itself every 6 hours.");
    expect(html).toMatch(/<button[^>]*>Sync now<\/button>/);
  });
});
