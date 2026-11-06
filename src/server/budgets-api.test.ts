import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { benchmarkSnapshot } from "../benchmarks/index.ts";
import { draftFirstBudgets } from "../budgets/index.ts";
import { markSetupStep, type NewBudget, storeFirstDraft } from "../db/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { typeSteadyIncome } from "../recurring/index.ts";
import { createApp } from "./app.ts";
import type { BenchmarksView } from "./benchmarks-views.ts";
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
  let memberId: string;

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
    memberId = member.id;
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

    expect(view).toMatchObject({ month: "2026-11", notice, drafted: false, budgets: [] });
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
      drafted: true,
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
          // Interest and fees has no projection.
          spending: 0,
          projected: null,
          status: "on track",
          shareOfYear: null,
          // Interest and fees has no Benchmark.
          context: null,
        },
      ],
      unbudgeted: [],
    });
    expect((await budgets("2026-11")).groups[0]).toEqual({
      categoryGroup: "Bills",
      monthly: 0,
      yearly: 0,
      spending: 0,
      projected: 0,
      overBudget: 0,
      onPace: 0,
      status: "on track",
    });
    expect((await budgets("2027-03")).budgets).toHaveLength(1);
    expect((await budgets("2026-10")).budgets).toEqual([]);
  });

  describe("the Benchmark context of a Bills Budget", () => {
    const at = new Date("2026-11-04T14:00:00.000Z");
    const budget = (category: string, amount: number, fields: Partial<NewBudget> = {}) => ({
      category,
      amount,
      period: "monthly" as const,
      takesEffect: "2026-11",
      source: "formula" as const,
      setBy: null,
      pinned: null,
      setAt: at,
      ...fields,
    });

    beforeEach(async () => {
      await typeSteadyIncome(test.database, 600_000, memberId, at);
      await storeFirstDraft(test.database, {
        inputs: {
          steadyIncome: 600_000,
          ceDataYear: benchmarkSnapshot().ce.dataYear,
          sampleBenchmarks: benchmarkSnapshot().sample,
          firstDraftMonth: "2026-11",
          fixedCostsPassIncome: false,
          recordedAt: at,
        },
        budgets: [
          budget("Housing", 246_000, { pinned: false }),
          budget("Interest and fees", 0, { pinned: false }),
          budget("Restaurants", 30_000),
          budget("Travel", 480_000, { period: "yearly", takesEffect: "2026" }),
        ],
      });
    });

    const contexts = async () =>
      Object.fromEntries(
        (await budgets("2026-11")).budgets.map(({ category, context }) => [category, context]),
      );

    const saveFacts = (rentOrOwn: "rent" | "own") =>
      saveHouseholdFacts(
        test.database,
        { zipCode: "10001", ages: [40, 38, 7], rentOrOwn },
        memberId,
        at,
      );
    const housingShare = async () => {
      const { categories } = (await (
        await browser.get("/api/benchmarks")
      ).json()) as BenchmarksView;
      return categories.find((each) => each.category === "Housing")?.share;
    };

    it('shows "<Category> is X% of Income; typical is Y%" on a Bills Budget with a Benchmark only', async () => {
      await saveFacts("own");
      const share = await housingShare();
      if (share == null) throw new Error("Housing has no Benchmark");

      expect(await contexts()).toEqual({
        Housing: `Housing is 41% of Income; typical is ${Math.round(share * 100)}%`,
        "Interest and fees": null,
        Restaurants: null,
        Travel: null,
      });
    });

    it("shows no typical Housing figure to a Household that rents", async () => {
      await saveFacts("rent");

      expect(await housingShare()).toBeNull();
      expect(await contexts()).toEqual({
        Housing: "Housing is 41% of Income",
        "Interest and fees": null,
        Restaurants: null,
        Travel: null,
      });
    });

    it("changes the Housing line at once when the facts change from rent to own and back", async () => {
      await saveFacts("rent");
      expect((await contexts()).Housing).toBe("Housing is 41% of Income");

      await saveFacts("own");
      expect((await contexts()).Housing).toMatch(/^Housing is 41% of Income; typical is \d+%$/);

      await saveFacts("rent");
      expect((await contexts()).Housing).toBe("Housing is 41% of Income");
    });

    it("shows none before the Household facts are recorded", async () => {
      expect((await contexts()).Housing).toBeNull();
    });
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

  // The routes change the current month: the Household time zone is unset, so it is UTC's.
  const thisMonth = () => new Date().toISOString().slice(0, 7);
  const stored = async () =>
    (await test.database.$client.execute("SELECT * FROM budgets ORDER BY id")).rows;
  const acceptance = async () =>
    (await test.database.$client.execute("SELECT * FROM budget_draft_acceptance")).rows;

  describe("a Member's changes", () => {
    beforeEach(async () => {
      await draftFirstBudgets(test.database, new Date());
    });

    it("edits a Budget from this month and pins a Bills Budget, until Follow the bill", async () => {
      const edited = await browser.send("PUT", "/api/budgets/Interest%20and%20fees", {
        amount: 12_345,
      });

      expect(edited.status).toBe(200);
      expect(await edited.json()).toEqual({
        budget: {
          category: "Interest and fees",
          categoryGroup: "Bills",
          amount: 12_345,
          period: "monthly",
          takesEffect: thisMonth(),
          source: "Member edit",
          setBy: memberId,
          pinned: true,
          reason: null,
        },
      });
      expect((await budgets(thisMonth())).budgets[0]).toMatchObject({ amount: 12_345 });

      const follow = await browser.send(
        "POST",
        "/api/budgets/Interest%20and%20fees/follow-the-bill",
        {},
      );
      expect(follow.status).toBe(200);
      expect(await follow.json()).toMatchObject({
        budget: { amount: 12_345, pinned: false, setBy: memberId },
      });
      expect(
        (await browser.send("POST", "/api/budgets/Interest%20and%20fees/follow-the-bill", {}))
          .status,
      ).toBe(409);
    });

    it("answers 404 to a Category with no Budget and 400 to a bad amount, and changes nothing", async () => {
      const before = await stored();

      for (const category of ["Pets", "Not%20a%20Category"]) {
        expect(
          (await browser.send("PUT", `/api/budgets/${category}`, { amount: 100 })).status,
        ).toBe(404);
        expect(
          (await browser.send("POST", `/api/budgets/${category}/follow-the-bill`, {})).status,
        ).toBe(404);
      }
      for (const body of [
        { amount: -1 },
        { amount: 1.5 },
        { amount: "100" },
        {},
        { amount: 1, extra: 1 },
      ]) {
        expect((await browser.send("PUT", "/api/budgets/Interest%20and%20fees", body)).status).toBe(
          400,
        );
      }

      expect(await stored()).toEqual(before);
    });

    it("accepts the whole draft once, by the signed-in Member", async () => {
      const first = await browser.send("POST", "/api/budgets/accept-all", {});
      expect(first.status).toBe(200);
      const { accepted } = (await first.json()) as { accepted: { acceptedBy: string } };
      expect(accepted.acceptedBy).toBe(memberId);
      expect((await budgets(thisMonth())).draftAccepted).toBe(true);

      const again = await browser.send("POST", "/api/budgets/accept-all", {});
      expect(await again.json()).toEqual({ accepted });
      expect(await acceptance()).toHaveLength(1);
    });

    it("answers 401 with no session, 403 from another site, and 415 to a body that is not JSON, and changes nothing", async () => {
      // A pinned Budget, so that Follow the bill would change it.
      await browser.send("PUT", "/api/budgets/Interest%20and%20fees", { amount: 500 });
      const before = await stored();
      const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
      const writes: [string, string, unknown][] = [
        ["PUT", "/api/budgets/Interest%20and%20fees", { amount: 100 }],
        ["POST", "/api/budgets/Interest%20and%20fees/follow-the-bill", {}],
        ["POST", "/api/budgets/accept-all", {}],
      ];

      for (const [method, path, body] of writes) {
        expect((await signedOut.send(method, path, body)).status).toBe(401);
        for (const origin of ["http://evil.example", undefined]) {
          expect((await browser.send(method, path, body, { origin })).status).toBe(403);
        }
        expect(
          (await browser.send(method, path, body, { "content-type": "text/plain" })).status,
        ).toBe(415);
      }

      expect(await stored()).toEqual(before);
      expect(await acceptance()).toEqual([]);
    });
  });

  it("answers 404 to Accept all before the first draft", async () => {
    expect((await browser.send("POST", "/api/budgets/accept-all", {})).status).toBe(404);
    expect(await acceptance()).toEqual([]);
  });
});
