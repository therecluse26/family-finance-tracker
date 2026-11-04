import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
import { draftFirstBudgets } from "../budgets/index.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { BudgetsView } from "./budgets-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Each Category's Budget for a month through the app's HTTP interface (spec 05, Stored Budgets).

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-budgets-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Budget route", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;

  beforeEach(async () => {
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await markSetupStep(test.database, "master key", "done");
  });

  afterEach(() => {
    test.close();
  });

  const budgets = async (month: string) =>
    (await (await browser.get(`/api/budgets?month=${month}`)).json()) as BudgetsView;
  const notice = benchmarkSnapshot().sample ? "Sample numbers, not real data" : null;

  it("has no Budget before the first draft", async () => {
    const view = await budgets("2026-11");

    expect(view).toMatchObject({ month: "2026-11", notice, budgets: [] });
    expect(view.groups.map(({ categoryGroup }) => categoryGroup)).toEqual([
      "Bills",
      "Shopping",
      "Transportation",
      "Health and care",
      "Leisure",
      "Other",
    ]);
  });

  it("returns each Category's Budget for the month, from the first draft's month on", async () => {
    await draftFirstBudgets(test.database, new Date("2026-11-04T14:00:00.000Z"));

    expect(await budgets("2026-11")).toMatchObject({
      month: "2026-11",
      notice,
      budgets: [
        {
          category: "Interest and fees",
          categoryGroup: "Bills",
          amount: 0,
          period: "monthly",
          takesEffect: "2026-11",
          source: "formula",
          setBy: null,
          pinned: false,
        },
      ],
    });
    expect((await budgets("2027-03")).budgets).toHaveLength(1);
    expect((await budgets("2026-10")).budgets).toEqual([]);
  });

  it("answers 400 to a missing or badly written month", async () => {
    for (const path of [
      "/api/budgets",
      "/api/budgets?month=2026-13",
      "/api/budgets?month=2026-1",
      "/api/budgets?month=2026-11-01",
    ]) {
      expect((await browser.get(path)).status).toBe(400);
    }
  });

  it("answers 401 with no session", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.get("/api/budgets?month=2026-11")).status).toBe(401);
  });
});
