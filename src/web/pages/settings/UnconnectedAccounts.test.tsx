import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UnconnectedAccountView } from "../../../server/bank-views.ts";
import {
  BalanceLine,
  centsOf,
  UnconnectedAccountForm,
  UnconnectedAccountList,
} from "./UnconnectedAccounts.tsx";

// Settings → Banks: the Unconnected accounts, as the browser paints them.

const SAVINGS: UnconnectedAccountView = {
  id: "acct-1",
  name: "Credit union savings",
  kind: "savings",
  institutionName: "Credit union",
  mask: "1234",
  closed: false,
  estimate: { balance: 1_250_000, state: "typed", typedOn: "2026-10-05" },
};

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
const line = (account: UnconnectedAccountView) =>
  text(renderToString(<BalanceLine account={account} today="2026-11-03" />));

describe("an Unconnected account's balance", () => {
  it("shows as typed with its date right after a Member types it", () => {
    expect(line(SAVINGS)).toBe("$12,500, as typed on Oct 5");
  });

  it("shows estimated once an assigned Transfer moves it", () => {
    const moved = { ...SAVINGS, estimate: { ...SAVINGS.estimate, state: "estimated" as const } };

    expect(line(moved)).toBe("$12,500, estimated");
  });

  it("always shows estimated with no typed balance", () => {
    const never = { ...SAVINGS, estimate: { balance: 0, state: "estimated", typedOn: null } };

    expect(line(never as UnconnectedAccountView)).toBe("$0, estimated");
  });
});

describe("the Unconnected account form", () => {
  it("asks for a name, a kind, and an optional balance, institution name, and last 4 digits", () => {
    const html = text(renderToString(<UnconnectedAccountForm account={null} onSaved={() => {}} />));

    for (const label of [
      "Name",
      "Savings",
      "HSA",
      "Investment or retirement",
      "Other",
      "Current balance (optional)",
      "Institution name (optional)",
      "Last 4 digits (optional)",
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain(
      "A payment app, such as Venmo or PayPal, is never an Unconnected account.",
    );
  });

  it("says a loan is added as a Manual loan, and lists each account with its balance", () => {
    const html = text(
      renderToString(
        <UnconnectedAccountList accounts={[SAVINGS]} today="2026-11-03" onSaved={() => {}} />,
      ),
    );

    expect(html).toContain("A loan is added as a Manual loan, not here.");
    expect(html).toContain("Credit union savings ··1234: $12,500, as typed on Oct 5");
  });

  it("reads a typed balance in whole cents", () => {
    expect(centsOf("$1,234.56")).toBe(123_456);
    expect(centsOf("1234.5")).toBe(123_450);
    expect(centsOf("0")).toBe(0);
    expect(centsOf("-20")).toBe(-2_000);
    expect(centsOf("12.345")).toBeUndefined();
    expect(centsOf("twelve")).toBeUndefined();
  });
});
