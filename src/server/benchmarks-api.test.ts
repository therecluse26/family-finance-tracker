import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { BENCHMARK_ROLES, categoryBenchmarks } from "../benchmarks/index.ts";
import { CATEGORIES } from "../categories/index.ts";
import { markSetupStep } from "../db/index.ts";
import { saveHouseholdFacts } from "../household/index.ts";
import { createLogger } from "../log.ts";
import { typeSteadyIncome } from "../recurring/index.ts";
import { createApp } from "./app.ts";
import type { BenchmarksView } from "./benchmarks-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Each Category's Benchmark through the app's HTTP interface, on the shipped sample snapshot.

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-benchmarks-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Benchmark route", () => {
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

  const benchmarks = async () =>
    (await (await browser.get("/api/benchmarks")).json()) as BenchmarksView;

  it("has no Benchmark until the wizard records the Household facts, and carries the sample label", async () => {
    expect(await benchmarks()).toEqual({
      notice: "Sample numbers, not real data",
      steadyIncome: null,
      ceColumn: null,
      categories: [],
    });
  });

  it("returns each Category's Benchmark and role, and never the Household facts", async () => {
    await typeSteadyIncome(test.database, 600_000, memberId);
    await saveHouseholdFacts(
      test.database,
      { zipCode: "99501", ages: [41, 39, 8, 0], rentOrOwn: "own" },
      memberId,
    );
    const view = await benchmarks();
    const computed = await categoryBenchmarks(test.database);

    expect(view.notice).toBe("Sample numbers, not real data");
    expect(view.steadyIncome).toBe(600_000);
    expect(view.ceColumn).toEqual(computed?.ceColumn);
    expect(view.categories.map(({ category, role }) => [category, role])).toEqual(
      CATEGORIES.map(({ name }) => [name, BENCHMARK_ROLES[name]]),
    );
    expect(view.categories).toEqual(
      computed?.categories.map(({ category, role, amount, share }) => ({
        category,
        role,
        amount,
        share,
      })),
    );
    const amountOf = (name: string) => view.categories.find((c) => c.category === name)?.amount;
    expect(amountOf("Restaurants")).toBeGreaterThan(0);
    expect(amountOf("Groceries")).toBe(amountOf("Superstores"));
    expect(amountOf("Travel")).toBeNull();
    const text = JSON.stringify(view);
    for (const fact of ["99501", "AK", "ages", "zipCode", "rentOrOwn"]) {
      expect(text).not.toContain(fact);
    }
  });

  it("gives a Household that rents no Housing Benchmark, and changes no other Category", async () => {
    await typeSteadyIncome(test.database, 600_000, memberId);
    const facts = { zipCode: "99501", ages: [41, 39, 8, 0] };
    await saveHouseholdFacts(test.database, { ...facts, rentOrOwn: "own" }, memberId);
    const owned = await benchmarks();
    await saveHouseholdFacts(test.database, { ...facts, rentOrOwn: "rent" }, memberId);
    const rented = await benchmarks();

    const housingOf = (view: BenchmarksView) =>
      view.categories.find(({ category }) => category === "Housing");
    expect(housingOf(owned)?.amount).toBeGreaterThan(0);
    expect(housingOf(owned)?.share).toBeGreaterThan(0);
    expect(housingOf(rented)).toEqual({
      category: "Housing",
      role: "context",
      amount: null,
      share: null,
    });
    const others = (view: BenchmarksView) =>
      view.categories.filter(({ category }) => category !== "Housing");
    expect(others(rented)).toEqual(others(owned));
  });

  it("answers 401 with no session", async () => {
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.get("/api/benchmarks")).status).toBe(401);
  });
});
