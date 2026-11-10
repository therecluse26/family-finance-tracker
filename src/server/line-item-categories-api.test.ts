import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { lineItemCategoriesSettled, startLineItemCategories } from "../line-items/index.ts";
import { addTestLineItems } from "../line-items/testing.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { ItemRuleView } from "./line-item-category-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Line item Category routes through the app's HTTP interface (spec 14, Item rules): a change on
// the Transaction's detail view, and Settings > Categories' Item rules. Every Line item is made up.

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-line-item-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Line item Category routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let member: TestMember;
  let stops: (() => void)[];

  const sql = async (text: string) => (await test.database.$client.execute(text)).rows;
  const state = async () => ({
    items: await sql("SELECT id, category, category_source FROM line_items ORDER BY id"),
    rules: await sql("SELECT * FROM item_rules ORDER BY product_key"),
  });
  const change = (id: string, body: unknown, headers?: Record<string, string | undefined>) =>
    browser.send("PUT", `/api/line-items/${id}/category`, body, headers);
  const rules = async () =>
    ((await (await browser.get("/api/item-rules")).json()) as { rules: ItemRuleView[] }).rules;

  beforeEach(async () => {
    const logger = createLogger(() => undefined, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
    );
    stops = [
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startLineItemCategories({ database: test.database }).stop,
    ];
    member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    browser = new TestBrowser(app, APP_URL, "192.168.1.20");
    await browser.signIn(member);
    await addTestLineItems(test.database, [
      { id: "1", name: "Paper towels, 12 rolls", productId: "B000000012", total: 1_000 },
      { id: "2", name: "Paper towels, 12 rolls", productId: "B000000012", total: 1_000 },
      { id: "3", name: "Dish soap", productId: "B000000020", total: 500 },
    ]);
  });

  afterEach(async () => {
    await lineItemCategoriesSettled();
    for (const stop of stops.reverse()) stop();
    test.close();
  });

  it("changes a Line item's Category and makes the product's Item rule, which Settings lists and deletes", async () => {
    const res = await change("1", { category: "Home and garden", onlyThisItem: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ changed: true });
    expect((await state()).items).toMatchObject([
      { id: "1", category: "Home and garden", category_source: "hand-set" },
      { id: "2", category: "Home and garden", category_source: "Item rule" },
      { id: "3", category: null },
    ]);

    const [rule] = await rules();
    expect(rule).toEqual({
      id: expect.any(String),
      name: "Paper towels, 12 rolls",
      category: "Home and garden",
      madeAt: expect.any(String),
    });
    expect(
      (await (await change("3", { category: "Groceries", onlyThisItem: true })).json()) as unknown,
    ).toEqual({ changed: true });
    expect(await rules()).toHaveLength(1);

    const deleted = await browser.send("DELETE", `/api/item-rules/${rule?.id}`);
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true });
    expect(await rules()).toEqual([]);
    expect((await browser.send("DELETE", `/api/item-rules/${rule?.id}`)).status).toBe(404);
  });

  it("refuses a Category a Line item never takes, a bad body, and an unknown Line item", async () => {
    const before = await state();
    for (const body of [
      { category: "Superstores", onlyThisItem: false },
      { category: "Cash", onlyThisItem: false },
      { category: "Payments to people", onlyThisItem: false },
      { category: "Snacks", onlyThisItem: false },
      { category: "Groceries" },
      { category: "Groceries", onlyThisItem: false, madeBy: "someone" },
      "Groceries",
    ]) {
      expect((await change("1", body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await change("missing", { category: "Groceries", onlyThisItem: false })).status).toBe(
      404,
    );
    expect(await state()).toEqual(before);
  });

  it("answers 401 with no session, 403 from another site or with no Origin, and 415 to another type, and changes nothing (K1)", async () => {
    await change("2", { category: "Pets", onlyThisItem: false });
    const [rule] = await rules();
    const before = await state();
    const body = { category: "Groceries", onlyThisItem: false };
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    expect((await signedOut.send("PUT", "/api/line-items/1/category", body)).status).toBe(401);
    expect((await signedOut.send("DELETE", `/api/item-rules/${rule?.id}`)).status).toBe(401);
    expect((await signedOut.send("GET", "/api/item-rules")).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await change("1", body, { origin })).status).toBe(403);
      expect(
        (await browser.send("DELETE", `/api/item-rules/${rule?.id}`, undefined, { origin })).status,
      ).toBe(403);
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      expect((await change("1", body, { "content-type": type })).status, type).toBe(415);
    }
    expect(await state()).toEqual(before);
  });

  it("runs parallel changes one at a time, so the Item rule and the Line items it covers agree (K18)", async () => {
    const categories = ["Groceries", "Pets", "Hobbies", "Clothing", "Home and garden"] as const;
    const sent = await Promise.all(
      categories.map((category) => change("1", { category, onlyThisItem: false })),
    );
    expect(sent.map((res) => res.status)).toEqual(categories.map(() => 200));

    const { items, rules: stored } = await state();
    expect(stored).toHaveLength(1);
    const ruled = stored[0]?.category;
    expect(items).toMatchObject([
      { id: "1", category: ruled, category_source: "hand-set" },
      { id: "2", category: ruled, category_source: "Item rule" },
      { id: "3", category: null },
    ]);

    const id = (await rules())[0]?.id;
    const deletes = await Promise.all(
      [1, 2, 3].map(() => browser.send("DELETE", `/api/item-rules/${id}`)),
    );
    expect(deletes.map((res) => res.status).sort()).toEqual([200, 404, 404]);
    expect(await rules()).toEqual([]);
  });
});
