import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountView,
  BalancePointView,
  ConnectionView,
  TransactionView,
} from "../../server/bank-views.ts";
import { accountEdits } from "../account-edits.ts";
import { BalanceChart, chartRows } from "../components/BalanceChart.tsx";
import { routes } from "../routes.tsx";
import { Account, AccountDetail, daysBefore } from "./Account.tsx";
import { AccountList, groupOf, marksOf } from "./Accounts.tsx";

// The Account list and each Account's page (spec 07, Account list).

const TODAY = "2026-10-20";
const ZONE = "America/New_York";

const ACCOUNT: AccountView = {
  id: "a-checking",
  connectionId: "c1",
  name: "Everyday Checking",
  kind: "depository",
  subtype: "checking",
  institutionName: "First Bank",
  mask: "1234",
  currentBalance: 250_000,
  availableBalance: 250_000,
  creditLimit: null,
  estimated: false,
  excluded: false,
  closed: false,
  closedAt: null,
};

const CONNECTION: ConnectionView = {
  id: "c1",
  provider: "plaid",
  bankName: "First Bank",
  health: "healthy",
  historyLoaded: true,
  lastSyncedAt: "2026-10-09T02:30:00.000Z",
  nextSyncAt: null,
  actions: { repairInApp: true, importExisting: true, refresh: true },
  removed: false,
  held: false,
};

const account = (fields: Partial<AccountView>): AccountView => ({ ...ACCOUNT, ...fields });
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ");
const inRouter = (node: React.ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>);

describe("the Account list", () => {
  it("marks each Account by its state", () => {
    const marks = (fields: Partial<AccountView>, connection = CONNECTION) =>
      marksOf(account(fields), [connection], TODAY, ZONE);

    expect(marks({})).toEqual([]);
    // A broken Connection's Accounts say when it last synced, in the Household's day: Oct 8 in
    // New York at 02:30 UTC on Oct 9.
    expect(marks({}, { ...CONNECTION, health: "broken" })).toEqual(["last synced Oct 8"]);
    expect(marks({}, { ...CONNECTION, health: "needs a member" })).toEqual(["last synced Oct 8"]);
    expect(marks({}, { ...CONNECTION, health: "needs a member", lastSyncedAt: null })).toEqual([
      "never synced",
    ]);
    expect(marks({}, { ...CONNECTION, health: "retrying" })).toEqual([]);
    expect(marks({ connectionId: null, kind: "unconnected", estimated: true })).toEqual([
      "estimated",
    ]);
    expect(marks({ excluded: true, currentBalance: null })).toEqual(["excluded"]);
    expect(marks({ closed: true }, { ...CONNECTION, health: "broken" })).toEqual([
      "last synced Oct 8",
      "Closed",
    ]);
  });

  it("groups Accounts as checking, savings, credit cards, loans, and Unconnected accounts", () => {
    expect(
      [
        account({ subtype: "checking" }),
        account({ subtype: "savings" }),
        account({ kind: "credit", subtype: "credit card" }),
        account({ kind: "loan", subtype: "auto" }),
        account({ kind: "loan", subtype: "personal", connectionId: null }),
        account({ kind: "unconnected", subtype: "HSA", connectionId: null }),
        account({ kind: "investment", subtype: "brokerage" }),
      ].map(groupOf),
    ).toEqual([
      "Checking",
      "Savings",
      "Credit cards",
      "Loans",
      "Loans",
      "Unconnected accounts",
      "Unconnected accounts",
    ]);
  });

  it("shows each row's name, institution, last 4 digits, balance, and marks, with Closed Accounts collapsed at the end", () => {
    const html = inRouter(
      <AccountList
        accounts={[
          account({ id: "old", name: "Old Card", kind: "credit", mask: "9999", closed: true }),
          account({
            id: "car",
            name: "Lakeside Auto",
            kind: "loan",
            connectionId: null,
            institutionName: "Lakeside Auto",
            mask: null,
            currentBalance: -967_800,
            estimated: true,
          }),
          account({}),
          account({ id: "savings", name: "Savings", subtype: "savings", mask: "2222" }),
        ]}
        connections={[{ ...CONNECTION, health: "broken" }]}
        today={TODAY}
        zone={ZONE}
      />,
    );
    const shown = text(html);

    expect([...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/g)].map((m) => m[1])).toEqual([
      "Checking",
      "Savings",
      "Loans",
    ]);
    expect(shown).toMatch(/Everyday Checking ··1234 +First Bank +last synced Oct 8 +\$2,500/);
    expect(shown).toMatch(/Lakeside Auto +Lakeside Auto +estimated +−\$9,678/);
    expect(html).toContain('href="/accounts/a-checking"');
    // The Closed section comes last, collapsed.
    const closed = html.slice(html.indexOf("<details"));
    expect(closed).not.toContain("<details open");
    expect(text(closed)).toMatch(/Closed Accounts \(1\).*Old Card ··9999.*Closed/s);
    expect(html.indexOf("Old Card")).toBeGreaterThan(html.indexOf("Lakeside Auto"));
  });
});

describe("an Account's page", () => {
  it("marks estimated days on the balance line", () => {
    const point = (date: string, currentBalance: number, estimated: boolean): BalancePointView => ({
      date,
      currentBalance,
      availableBalance: null,
      estimated,
    });

    // Estimated days before the first sync, then synced days.
    expect(
      chartRows([
        point("2026-10-01", 100, true),
        point("2026-10-02", 200, true),
        point("2026-10-03", 300, false),
        point("2026-10-04", 400, false),
      ]),
    ).toEqual([
      { date: "2026-10-01", known: null, estimated: 100 },
      { date: "2026-10-02", known: 200, estimated: 200 },
      { date: "2026-10-03", known: 300, estimated: null },
      { date: "2026-10-04", known: 400, estimated: null },
    ]);
    // A typed balance, then estimates from assigned Transfers.
    expect(chartRows([point("2026-10-05", 500, false), point("2026-10-07", 600, true)])).toEqual([
      { date: "2026-10-05", known: 500, estimated: 500 },
      { date: "2026-10-07", known: null, estimated: 600 },
    ]);
    const marked = text(
      renderToString(
        <BalanceChart
          points={[point("2026-10-05", 500, false), point("2026-10-07", 600, true)]}
          today={TODAY}
        />,
      ),
    );
    expect(marked).toContain("The dashed line marks estimated days.");
    const synced = text(
      renderToString(<BalanceChart points={[point("2026-10-05", 500, false)]} today={TODAY} />),
    );
    expect(synced).not.toContain("estimated");
  });

  it("shows the marks, the edits that apply, and the Transactions", () => {
    const txn: TransactionView = {
      id: "t1",
      accountId: ACCOUNT.id,
      amount: -4_250,
      postedDate: "2026-10-12",
      authorizedDate: null,
      pending: false,
      description: "CORNER BISTRO",
      merchantName: "Corner Bistro",
    };
    const page = (facts: Partial<Parameters<typeof AccountDetail>[0]["facts"]>) =>
      text(
        inRouter(
          <AccountDetail
            facts={{ account: ACCOUNT, marks: [], points: [], transactions: [], ...facts }}
            today={TODAY}
            onChanged={() => {}}
          />,
        ),
      );

    const checking = page({ marks: ["excluded"], transactions: [txn] });
    expect(checking).toContain("excluded");
    expect(checking).toContain("Exclude");
    expect(checking).toContain("Close this Account");
    expect(checking).toMatch(/Oct 12 +Corner Bistro +−\$42\.50/);
    expect(checking).not.toContain("Loan type");

    const loan = page({
      account: account({ kind: "loan", subtype: "personal", closed: true }),
      loan: { accountId: ACCOUNT.id, loanType: "cash loan", setBy: "app", apr: null },
    });
    expect(loan).toContain("Reopen this Account");
    expect(loan).toContain("Loan type, now Cash loan (set by the app)");
    expect(loan).toContain("APR");
    expect(loan).toContain("No Transactions in the last year.");
  });

  it("shows a year of balances and Transactions", () => {
    expect(daysBefore("2026-10-20", 365)).toBe("2025-10-20");
    expect(daysBefore("2024-03-01", 1)).toBe("2024-02-29");
  });

  it("opens from /accounts/:id", async () => {
    const shell = routes.find((route) => route.path === "/");
    const page = shell?.children?.find((route) => route.path === "accounts/:id");
    const loaded = typeof page?.lazy === "function" ? await page.lazy() : undefined;

    expect(loaded?.Component).toBe(Account);
  });
});

describe("the Account edits", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Each request the edits send: its method, path, and JSON body.
  function recordRequests() {
    const sent: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), "http://app.test");
      sent.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({});
    });
    return sent;
  }

  it("calls each edit's route", async () => {
    const sent = recordRequests();
    const unconnected = { name: "HSA", kind: "HSA", institutionName: "", mask: "", balance: null };
    const manualLoan = {
      lender: "Lakeside Auto",
      kind: "car" as const,
      balance: 1_000_000,
      balanceDate: "2026-09-01",
      apr: 7.3,
      regularPayment: null,
      escrow: null,
      loanType: null,
    };

    await accountEdits.close("a1");
    await accountEdits.reopen("a1");
    await accountEdits.setExcluded("a1", true);
    await accountEdits.setLoan("a1", { loanType: "purchase loan" });
    await accountEdits.setLoan("a1", { apr: 6.5 });
    await accountEdits.saveUnconnectedAccount(null, unconnected);
    await accountEdits.saveUnconnectedAccount("u1", unconnected);
    await accountEdits.saveManualLoan(null, manualLoan);
    await accountEdits.saveManualLoan("m1", manualLoan);

    expect(sent).toEqual([
      { method: "POST", path: "/api/accounts/a1/close", body: undefined },
      { method: "POST", path: "/api/accounts/a1/reopen", body: undefined },
      { method: "PUT", path: "/api/accounts/a1/exclude", body: { excluded: true } },
      { method: "PUT", path: "/api/accounts/a1/loan", body: { loanType: "purchase loan" } },
      { method: "PUT", path: "/api/accounts/a1/loan", body: { apr: 6.5 } },
      { method: "POST", path: "/api/unconnected-accounts", body: unconnected },
      { method: "PUT", path: "/api/unconnected-accounts/u1", body: unconnected },
      { method: "POST", path: "/api/manual-loans", body: manualLoan },
      { method: "PUT", path: "/api/manual-loans/m1", body: manualLoan },
    ]);
  });
});
