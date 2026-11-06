import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlaidView } from "../../../bank/plaid-view.ts";
import type { AccountView, ConnectionView } from "../../../server/bank-views.ts";
import {
  BeforeLink,
  ConnectionItem,
  FakeBankLink,
  ImportConnection,
  ImportPreviewList,
  LinkBank,
  linkResultOf,
  PLAID_LINK_SCRIPT,
} from "./Connections.tsx";

// Settings → Banks: the Connections, and what the Member reads before Plaid Link opens.

const KEYS_SET: PlaidView = {
  clientId: "client-id-shown",
  secretSet: true,
  itemsUsed: 2,
  appItems: 2,
  itemLimit: 10,
};

const CONNECTION: ConnectionView = {
  id: "c1",
  provider: "plaid",
  bankName: "First Bank",
  health: "healthy",
  historyLoaded: true,
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
  institutionName: "First Bank",
  mask: "1234",
  currentBalance: 100,
  availableBalance: 100,
  creditLimit: null,
  estimated: false,
  excluded: false,
  closed: false,
  closedAt: null,
};

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");

describe("Settings → Banks: linking a new bank", () => {
  it("lists the banks and Accounts already connected, gives the advice, and shows at least N of 10 used", () => {
    const shown = text(
      renderToString(
        <BeforeLink plaid={KEYS_SET} connections={[CONNECTION]} accounts={[ACCOUNT]} />,
      ),
    );

    expect(shown).toContain("First Bank");
    expect(shown).toContain("Checking ··1234");
    expect(shown).toContain("Link each bank once.");
    expect(shown).toContain("Pick every Account at the bank the first time");
    expect(shown).toContain("At least 2 of 10 used");
  });

  it("says linking is blocked at N of 10", () => {
    const shown = text(
      renderToString(
        <BeforeLink plaid={{ ...KEYS_SET, itemsUsed: 10 }} connections={[]} accounts={[]} />,
      ),
    );

    expect(shown).toContain("At least 10 of 10 used");
    expect(shown).toContain("cannot link a new bank");
  });

  it("offers Link only once the Plaid keys are set", () => {
    const none = { ...KEYS_SET, clientId: null, secretSet: false };

    expect(
      text(
        renderToString(
          <LinkBank plaid={none} connections={[]} accounts={[]} onLinked={() => {}} />,
        ),
      ),
    ).toContain("Enter the Plaid keys to link a bank.");
    expect(
      text(
        renderToString(
          <LinkBank plaid={KEYS_SET} connections={[]} accounts={[]} onLinked={() => {}} />,
        ),
      ),
    ).toContain("Link a new bank");
  });

  it("loads Plaid's script from Plaid's CDN over HTTPS", () => {
    expect(new URL(PLAID_LINK_SCRIPT).origin).toBe("https://cdn.plaid.com");
  });

  it("sends the server the institution and each Account's type and last 4 digits from Link's metadata", () => {
    expect(
      linkResultOf("public-token-from-link", {
        institution: { institution_id: "ins_1", name: "First Bank" },
        accounts: [{ name: "Card", mask: "9876", type: "credit", subtype: "credit card" }],
      }),
    ).toEqual({
      publicToken: "public-token-from-link",
      bankId: "ins_1",
      bankName: "First Bank",
      accounts: [{ name: "Card", type: "credit", subtype: "credit card", mask: "9876" }],
    });
    expect(linkResultOf("public-token-from-link", { institution: null, accounts: [] })).toBe(
      undefined,
    );
  });
});

describe("Settings → Banks: Import Plaid Connection", () => {
  it("is offered next to Link a new bank once the Plaid keys are set", () => {
    const shown = text(renderToString(<ImportConnection plaid={KEYS_SET} onImported={() => {}} />));
    const none = renderToString(
      <ImportConnection plaid={{ ...KEYS_SET, secretSet: false }} onImported={() => {}} />,
    );

    expect(shown).toContain("Import Plaid Connection");
    expect(none).toBe("");
  });

  it("shows the bank and each Account's last 4 digits before it saves", () => {
    const shown = text(
      renderToString(
        <ImportPreviewList
          preview={{
            bankName: "First Bank",
            accounts: [
              { name: "Checking", type: "depository", subtype: "checking", mask: "1234" },
              { name: "Loan", type: "loan", subtype: null, mask: null },
            ],
          }}
        />,
      ),
    );

    expect(shown).toContain("First Bank");
    expect(shown).toContain("Checking ··1234");
    expect(shown).toContain("Loan");
  });
});

describe("Settings → Banks: the fake bank, under `pnpm dev` only", () => {
  it("offers Link a fake bank only when the server says the fake adapter runs", () => {
    const shown = text(renderToString(<FakeBankLink offered={true} onLinked={() => {}} />));
    const none = renderToString(<FakeBankLink offered={false} onLinked={() => {}} />);

    expect(shown).toContain("Link a fake bank (dev only)");
    expect(none).toBe("");
  });
});

describe("Settings → Banks: removing a Connection", () => {
  const item = (connection: ConnectionView, accounts: AccountView[]) =>
    text(
      renderToString(
        <ConnectionItem connection={connection} accounts={accounts} onChanged={() => {}} />,
      ),
    );

  it("offers Remove on each Connection, with its Accounts", () => {
    const shown = item(CONNECTION, [ACCOUNT]);

    expect(shown).toContain("First Bank");
    expect(shown).toContain("Checking ··1234");
    expect(shown).toContain("Remove");
    expect(shown).not.toContain("Delete history");
  });

  it("offers Delete history on a removed Connection that still has Accounts, and hides one with none", () => {
    const removed = { ...CONNECTION, removed: true };
    const closed = { ...ACCOUNT, closed: true };

    const shown = item(removed, [closed]);
    expect(shown).toContain("First Bank (Removed)");
    expect(shown).toContain("Checking ··1234 (Closed)");
    expect(shown).toContain("Delete history");
    expect(shown).not.toMatch(/\bRemove\b(?! )/);
    expect(item(removed, [])).toBe("");
  });
});

describe("Settings → Banks: Repair, Link again, and Add accounts", () => {
  const item = (connection: ConnectionView) =>
    text(
      renderToString(
        <ConnectionItem
          connection={connection}
          accounts={[ACCOUNT]}
          onChanged={() => {}}
          linkAgain={<span>LINK AGAIN SHOWN</span>}
        />,
      ),
    );

  it("offers Repair and Add accounts on a Connection that needs a Member", () => {
    const shown = item({ ...CONNECTION, health: "needs a member" });

    expect(shown).toContain("Needs you to sign in again");
    // "use Repair" in the note, and the Repair button.
    expect(shown.match(/Repair/g)).toHaveLength(2);
    expect(shown).toContain("Add accounts");
    expect(shown).not.toContain("LINK AGAIN SHOWN");
  });

  it("offers Link again, not Repair or Add accounts, on a Broken Connection", () => {
    const shown = item({ ...CONNECTION, health: "broken" });

    expect(shown).toContain("LINK AGAIN SHOWN");
    expect(shown).not.toContain("Repair");
    expect(shown).not.toContain("Add accounts");
  });

  it("offers Add accounts on every Connection that is not Broken or removed", () => {
    for (const health of ["healthy", "retrying"] as const) {
      const shown = item({ ...CONNECTION, health });
      expect(shown).toContain("Add accounts");
      expect(shown).not.toContain("Repair");
    }
    expect(item({ ...CONNECTION, removed: true })).not.toContain("Add accounts");
  });

  it("shows a held Connection as not in use, with Remove and nothing that would sync it", () => {
    const shown = item({ ...CONNECTION, held: true });

    expect(shown).toContain("Not in use: another Connection already covers this bank");
    expect(shown).toContain("Remove");
    expect(shown).not.toContain("Add accounts");
    expect(shown).not.toContain("Repair");
  });

  it("names Link again for the Broken Connection it replaces", () => {
    const shown = text(
      renderToString(
        <LinkBank
          plaid={KEYS_SET}
          connections={[]}
          accounts={[]}
          onLinked={() => {}}
          replaces={{ ...CONNECTION, health: "broken" }}
        />,
      ),
    );

    expect(shown).toContain("Link again");
    expect(shown).not.toContain("Link a new bank");
  });
});
