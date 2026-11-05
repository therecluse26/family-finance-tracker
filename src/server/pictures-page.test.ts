import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { startBank } from "../bank/index.ts";
import { draftFirstBudgets } from "../budgets/index.ts";
import { startCategorization } from "../categorization/index.ts";
import { markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { wholeDollars } from "../format.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import type { PictureChoice, PictureView } from "../pictures/index.ts";
import { findRecurringCharges } from "../recurring/index.ts";
import {
  calendarWeeks,
  cardRows,
  cardsCaption,
  daysCaption,
  readPicture,
  recurringCaption,
  recurringRows,
  trendCaption,
} from "../web/pictures.ts";
import { createApp } from "./app.ts";
import type { AccountView } from "./bank-views.ts";
import type { MonthTotalsView } from "./money-movement-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { TestBrowser } from "./testing.ts";

// End to end on the demo household (spec 08, Picture menu): each picture on the menu, asked for
// through the web app's own request and the app's HTTP interface on Oct 20, 2026, then drawn. The
// first draft makes October's Budgets, and the Recurring charges are found once.

const APP_URL = "http://nas.local:8080";
// Noon in New York, the demo Household's time zone. Its history runs to Oct 31.
const NOW = new Date("2026-10-20T16:00:00.000Z");
const MONTH = "2026-10";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-pictures-page-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

// A picture's words, as its drawing in src/web/components/Picture.tsx writes them: each card or
// charge, then the caption. No picture has none.
function drawn(picture: PictureView | null): string {
  if (picture === null) return "";
  switch (picture.type) {
    case "days":
      return daysCaption(picture);
    case "trend":
      return trendCaption(picture);
    case "cards":
      return [
        ...cardRows(picture).map((row) => `${row.name} ${row.words}`),
        cardsCaption(picture),
      ].join(" ");
    case "recurring":
      return [
        ...recurringRows(picture).map((row) => `${row.name} ${row.words}`),
        recurringCaption(picture),
      ].join(" ");
  }
}

describe("the pictures on the demo household", () => {
  let test: TestAuth;
  let browser: TestBrowser;
  let app: ReturnType<typeof createApp>;
  let stops: (() => void)[] = [];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await saveHouseholdFacts(
      test.database,
      { zipCode: "10001", ages: [40, 38, 7], rentOrOwn: "rent" },
      member.id,
    );
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await seedDemoHousehold(test.database, fake);
    await runFollowUp();
    await draftFirstBudgets(test.database);
    await findRecurringCharges(test.database, NOW);

    // The web app's requests go to the app as the signed-in browser.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      return browser.send(init?.method ?? "GET", `${url.pathname}${url.search}`);
    });
  });

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
    test.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const read = (choice: PictureChoice, month = MONTH) => readPicture(choice, month);

  it("answers 401 with no session", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    const answer = await signedOut.get(`/api/picture?month=${MONTH}&type=cards`);
    expect(answer.status).toBe(401);
    expect(await answer.text()).not.toContain("Card");
  });

  it("answers 400 for a month not written YYYY-MM or a choice off the menu", async () => {
    for (const query of [
      "month=2026-13&type=cards",
      "type=cards",
      `month=${MONTH}`,
      `month=${MONTH}&type=pie`,
      `month=${MONTH}&type=trend`,
      `month=${MONTH}&type=recurring&category=`,
      `month=${MONTH}&type=days`,
      `month=${MONTH}&type=days&category=Groceries&merchant=Pasta%20Corner`,
      `month=${MONTH}&type=days${"&merchant=Pasta%20Corner".repeat(6)}`,
      // A field the picture does not name is refused.
      `month=${MONTH}&type=cards&category=Groceries`,
      `month=${MONTH}&type=trend&category=Groceries&merchant=Pasta%20Corner`,
    ]) {
      const answer = await browser.get(`/api/picture?${query}`);
      expect(answer.status, query).toBe(400);
      expect(await answer.text(), query).not.toContain('"picture"');
    }
  });

  it("draws days: a calendar of the month with each day of the Category's Spending marked", async () => {
    const picture = await read({ type: "days", category: "Groceries" });

    expect(picture).toEqual({
      type: "days",
      month: MONTH,
      of: { category: "Groceries" },
      days: ["02", "09", "16", "23", "29"].map((day) => ({ date: `${MONTH}-${day}`, count: 1 })),
    });
    if (picture?.type !== "days") throw new Error("No days picture.");
    const cells = calendarWeeks(picture).flat();
    expect(cells.filter((cell) => cell !== null)).toHaveLength(31);
    expect(cells.flatMap((cell) => (cell !== null && cell.count > 0 ? [cell.day] : []))).toEqual([
      2, 9, 16, 23, 29,
    ]);
    expect(drawn(picture)).toBe("Groceries in Oct 2026: 5 days");
  });

  it("draws days at a list of Merchants, by the names the app holds, in any case", async () => {
    const picture = await read({ type: "days", merchants: ["pasta corner", " Noodle  House "] });

    expect(picture).toEqual({
      type: "days",
      month: MONTH,
      of: { merchants: ["Pasta Corner", "Noodle House"] },
      days: ["04", "13", "29"].map((day) => ({ date: `${MONTH}-${day}`, count: 1 })),
    });
    expect(drawn(picture)).toBe("Pasta Corner and Noodle House in Oct 2026: 3 days");
  });

  it("draws trend: 7 months of the Category's Spending against the Budget in effect each month", async () => {
    const picture = await read({ type: "trend", category: "Groceries" });
    const totals = (await (await browser.get("/api/totals")).json()) as {
      months: MonthTotalsView[];
    };
    const spent = (month: string) =>
      totals.months.find((each) => each.month === month)?.byCategory.Groceries ?? 0;
    const months = ["04", "05", "06", "07", "08", "09", "10"].map((each) => `2026-${each}`);

    // The first draft is October's, so only October has a Budget.
    expect(picture).toEqual({
      type: "trend",
      category: "Groceries",
      months: months.map((month) => ({
        month,
        spending: spent(month),
        budget: month === MONTH ? 53_000 : null,
      })),
    });
    expect(months.every((month) => spent(month) > 0)).toBe(true);
    expect(drawn(picture)).toBe(
      `Groceries, Apr 2026 to Oct 2026. Oct 2026: ${wholeDollars(spent(MONTH))} of a $530 Budget. The dashed line is the Budget.`,
    );
  });

  it("draws cards: each open credit card's balance owed and APR, leaving out an Excluded card", async () => {
    const picture = await read({ type: "cards" });

    expect(drawn(picture)).toBe(
      "Rewards Card $814 · 28% APR Chase Card $451 · 21% APR Home Store Card $907 · 27% APR " +
        "Each card's balance owed and APR.",
    );
    const accounts = (await (await browser.get("/api/accounts")).json()) as {
      accounts: AccountView[];
    };
    const owed = (name: string) =>
      -(accounts.accounts.find((account) => account.name === name)?.currentBalance ?? 0);
    expect(picture?.type === "cards" && picture.cards.map((card) => card.owed)).toEqual([
      owed("Rewards Card"),
      owed("Chase Card"),
      owed("Home Store Card"),
    ]);

    const store = accounts.accounts.find((account) => account.name === "Home Store Card");
    const excluded = await browser.send("PUT", `/api/accounts/${store?.id}/exclude`, {
      excluded: true,
    });
    expect(excluded.status).toBe(200);
    expect(drawn(await read({ type: "cards" }))).toBe(
      "Rewards Card $814 · 28% APR Chase Card $451 · 21% APR Each card's balance owed and APR.",
    );
  });

  it("draws no cards picture when no open credit card counts", async () => {
    const { accounts } = (await (await browser.get("/api/accounts")).json()) as {
      accounts: AccountView[];
    };
    for (const card of accounts.filter((account) => account.kind === "credit")) {
      const answer = await browser.send("PUT", `/api/accounts/${card.id}/exclude`, {
        excluded: true,
      });
      expect(answer.status).toBe(200);
    }
    expect(await read({ type: "cards" })).toBeNull();
  });

  it("draws recurring: the Category's active monthly Recurring charges, largest first", async () => {
    const picture = await read({ type: "recurring", category: "Entertainment" });

    expect(picture?.type === "recurring" && picture.charges.map((c) => c.merchantName)).toEqual([
      "Streamflix",
      "Tunebox",
    ]);
    expect(drawn(picture)).toBe(
      "Streamflix $17.99 Tunebox $11.99 Entertainment: 2 monthly Recurring charges, $30 a month",
    );
  });

  // The read filters behind the pictures, each on its own: what the app does not show, no picture
  // shows.
  it("marks no day for a hidden Transaction", async () => {
    const found = await test.database.$client.execute(`
      SELECT t.id FROM transactions t JOIN transaction_parts p ON p.transaction_id = t.id
      WHERE p.category = 'Groceries' AND coalesce(t.authorized_date, t.posted_date) = '2026-10-09'`);
    expect(found.rows).toHaveLength(1);
    await test.database.$client.execute({
      sql: `UPDATE transactions SET hidden_reason = 'removed by provider', hidden_at = ?
            WHERE id = ?`,
      args: [NOW.toISOString(), String(found.rows[0]?.id)],
    });

    const picture = await read({ type: "days", category: "Groceries" });
    expect(picture?.type === "days" && picture.days.map((day) => day.date)).toEqual(
      ["02", "16", "23", "29"].map((day) => `${MONTH}-${day}`),
    );
  });

  it("leaves out a Closed credit card", async () => {
    const { accounts } = (await (await browser.get("/api/accounts")).json()) as {
      accounts: AccountView[];
    };
    const chase = accounts.find((account) => account.name === "Chase Card");
    expect((await browser.send("POST", `/api/accounts/${chase?.id}/close`, {})).status).toBe(200);

    expect(drawn(await read({ type: "cards" }))).toBe(
      "Rewards Card $814 · 28% APR Home Store Card $907 · 27% APR " +
        "Each card's balance owed and APR.",
    );
  });

  it("leaves out a Recurring charge a Member ended", async () => {
    const { charges } = (await (await browser.get("/api/recurring-charges")).json()) as {
      charges: { id: string; merchantName: string }[];
    };
    const tunebox = charges.find((charge) => charge.merchantName === "Tunebox");
    const ended = await browser.send("POST", `/api/recurring-charges/${tunebox?.id}/end`, {});
    expect(ended.status).toBe(200);

    expect(drawn(await read({ type: "recurring", category: "Entertainment" }))).toBe(
      "Streamflix $17.99 Entertainment: 1 monthly Recurring charge, $18 a month",
    );
  });

  it("draws nothing for a choice the data does not bear out", async () => {
    const bad: PictureChoice[] = [
      // Not a Category.
      { type: "days", category: "Dining out" },
      { type: "trend", category: "Dining out" },
      { type: "recurring", category: "Dining out" },
      // A Category with no Spending: none in October, none in the 7 months.
      { type: "days", category: "Travel" },
      { type: "trend", category: "Travel" },
      // A Merchant with no Spending in October, even beside one with some.
      { type: "days", merchants: ["Pasta Corner", "Nowhere Diner"] },
      // Restaurants has only a yearly Recurring charge; Groceries has none.
      { type: "recurring", category: "Restaurants" },
      { type: "recurring", category: "Groceries" },
    ];
    for (const choice of bad) {
      expect(await read(choice), JSON.stringify(choice)).toBeNull();
    }
    // The demo history starts in May 2025 and ends in October 2026.
    expect(await read({ type: "trend", category: "Groceries" }, "2024-10")).toBeNull();
    expect(await read({ type: "days", category: "Groceries" }, "2026-11")).toBeNull();
  });
});
