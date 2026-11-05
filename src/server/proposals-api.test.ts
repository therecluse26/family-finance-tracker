import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { addGoal, markSetupStep, type NewBudget, storeFirstDraft } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { type ProposalInput, propose } from "../proposals/index.ts";
import { loadAiBox } from "../web/ai-box.ts";
import {
  acceptProposal,
  loadUndoable,
  saveAndAccept,
  skipProposal,
  undoProposal,
} from "../web/proposals.ts";
import type { AiBoxView } from "./ai-box-views.ts";
import { createApp } from "./app.ts";
import type { ProposalView } from "./proposals-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Proposals through the app's HTTP interface (spec 08, Proposals; Lifecycle; spec 07, 1. AI box):
// open ones first in "Worth acting on", and Accept, "Save and accept", Skip, and Undo. Every
// Proposal is written by code, and the app has no AI provider: no route makes an AI call.

const APP_URL = "http://nas.local:8080";
// Oct 20, 2026, 4 PM UTC. With no Household time zone, the app's date is UTC's.
const NOW = new Date("2026-10-20T16:00:00.000Z");
const $ = (dollars: number) => Math.round(dollars * 100);

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-proposals-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Proposal routes", () => {
  let test: TestAuth;
  let app: App;
  let alice: TestBrowser;
  let aliceId: string;
  let runs = 0;

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
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    aliceId = member.id;
    await markSetupStep(test.database, "master key", "done");
    alice = new TestBrowser(app, APP_URL, "192.168.1.20");
    await alice.signIn(member);

    const budget = (category: string, amount: number): NewBudget => ({
      category,
      amount,
      period: "monthly",
      takesEffect: "2026-10",
      source: "formula",
      setBy: null,
      pinned: null,
      setAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await storeFirstDraft(test.database, {
      inputs: {
        steadyIncome: $(6000),
        ceDataYear: 2024,
        sampleBenchmarks: false,
        firstDraftMonth: "2026-10",
        fixedCostsPassIncome: false,
        recordedAt: new Date("2026-10-01T00:00:00.000Z"),
      },
      budgets: [budget("Restaurants", $(600)), budget("Clothing", $(200))],
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    test.close();
  });

  const run = () => {
    runs += 1;
    return `run-${runs}`;
  };

  const shown = async (input: ProposalInput) => {
    const result = await propose(test.database, input, NOW);
    if (result.outcome !== "shown") throw new Error(`Refused: ${result.guardrail}`);
    return result.id;
  };

  const budgetChange = (category: string, amount: number) =>
    shown({
      kind: "Budget change",
      source: "Budget tailoring",
      runId: run(),
      reason: "Takeout has been steady, so a lower Budget fits.",
      budgets: [{ category, amount }],
    });

  const newGoal = () =>
    shown({
      kind: "new Goal",
      source: "Monthly review",
      runId: run(),
      reason: "A cushion would cover a surprise bill.",
      words: "Save $1,000 for emergencies",
    });

  const box = async () => (await (await alice.get("/api/ai-box")).json()) as AiBoxView;
  const undoable = async () =>
    ((await (await alice.get("/api/proposals/undoable")).json()) as { proposals: ProposalView[] })
      .proposals;
  const budgetsNow = async () =>
    (
      (await (await alice.get("/api/budgets?month=2026-10")).json()) as {
        budgets: { category: string; amount: number; source: string }[];
      }
    ).budgets
      .filter((row) => ["Restaurants", "Clothing"].includes(row.category))
      .map((row) => [row.category, row.amount, row.source])
      .sort(([a], [b]) => String(a).localeCompare(String(b)));

  it("shows open Proposals first in Worth acting on, newest first, each counted, with its change and reason", async () => {
    const restaurants = await budgetChange("Restaurants", $(480));
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const goal = await newGoal();

    const view = await box();
    const worth = view.groups.find((group) => group.name === "Worth acting on");
    expect(worth?.notes.map((note) => [note.kind, note.id])).toEqual([
      ["Proposal", goal],
      ["Proposal", restaurants],
    ]);
    expect(view.worthActingOn).toBe(2);
    const card = worth?.notes[1];
    expect(card?.kind === "Proposal" ? card.proposal : undefined).toEqual({
      id: restaurants,
      kind: "Budget change",
      source: "Budget tailoring",
      createdAt: NOW.toISOString(),
      reason: "Takeout has been steady, so a lower Budget fits.",
      changes: ["Restaurants Budget: $600 → $480"],
      budgets: [{ category: "Restaurants", from: $(600), to: $(480), period: "monthly" }],
      goal: null,
      words: null,
    });
    // A Proposal has no Done mark.
    expect(card).not.toHaveProperty("done");
  });

  it("accepts a Budget change: it takes effect this month with the source Proposal, leaves the box, and offers Undo", async () => {
    const id = await budgetChange("Restaurants", $(480));

    const res = await alice.post(`/api/proposals/${id}/accept`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: true });

    expect(await budgetsNow()).toEqual([
      ["Clothing", $(200), "formula"],
      ["Restaurants", $(480), "Proposal"],
    ]);
    expect((await box()).groups).toEqual([]);
    expect((await undoable()).map((proposal) => proposal.id)).toEqual([id]);

    // A second Accept finds it closed, and changes nothing.
    const before = await readEveryTable(test.database);
    expect((await alice.post(`/api/proposals/${id}/accept`)).status).toBe(409);
    expect(await readEveryTable(test.database)).toEqual(before);

    expect((await alice.post(`/api/proposals/${id}/undo`)).status).toBe(200);
    expect(await budgetsNow()).toEqual([
      ["Clothing", $(200), "formula"],
      ["Restaurants", $(600), "formula"],
    ]);
    expect(await undoable()).toEqual([]);
    const again = await alice.post(`/api/proposals/${id}/undo`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "This change is already undone." });
  });

  it("saves and accepts a Member's Edit outside the 50% range, and accepts a new Goal with the Member as author", async () => {
    const id = await budgetChange("Restaurants", $(480));
    const res = await alice.post(`/api/proposals/${id}/edit`, { budgets: { Restaurants: $(100) } });
    expect(res.status).toBe(200);
    expect(await budgetsNow()).toEqual([
      ["Clothing", $(200), "formula"],
      ["Restaurants", $(100), "Proposal"],
    ]);

    const goal = await newGoal();
    expect(
      (await alice.post(`/api/proposals/${goal}/edit`, { words: "Save $2,000 for emergencies" }))
        .status,
    ).toBe(200);
    const goals = (await (await alice.get("/api/goals")).json()) as {
      goals: { words: string; status: string; authorId: string }[];
    };
    expect(goals.goals).toEqual([
      expect.objectContaining({
        words: "Save $2,000 for emergencies",
        status: "active",
        authorId: aliceId,
      }),
    ]);
  });

  it("skips a Proposal and changes nothing else", async () => {
    const id = await budgetChange("Restaurants", $(480));
    const budgets = await budgetsNow();

    const res = await alice.post(`/api/proposals/${id}/skip`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true });
    expect(await budgetsNow()).toEqual(budgets);
    expect((await box()).groups).toEqual([]);
    expect((await alice.post(`/api/proposals/${id}/skip`)).status).toBe(404);
    expect((await alice.post(`/api/proposals/${id}/accept`)).status).toBe(409);
  });

  it("refuses a body it does not know, an Edit that does not fit, and an unknown ID, and changes nothing", async () => {
    const budget = await budgetChange("Restaurants", $(480));
    const goal = await newGoal();
    const before = await readEveryTable(test.database);

    const cases: [string, unknown, number][] = [
      [`/api/proposals/${budget}/accept`, { amount: 1 }, 400],
      [`/api/proposals/${budget}/skip`, { reason: "x" }, 400],
      [`/api/proposals/${budget}/undo`, { now: true }, 400],
      [`/api/proposals/${budget}/edit`, {}, 400],
      [`/api/proposals/${budget}/edit`, { budgets: { Restaurants: -1 } }, 400],
      [`/api/proposals/${budget}/edit`, { budgets: { Restaurants: 1.5 } }, 400],
      [`/api/proposals/${budget}/edit`, { budgets: { "Not a Category": 100 } }, 400],
      [`/api/proposals/${budget}/edit`, { budgets: { Restaurants: 100 }, extra: 1 }, 400],
      // K2: an Edit through the wrong kind of Proposal, or of a Category it does not change.
      [`/api/proposals/${budget}/edit`, { words: "Something else" }, 400],
      [`/api/proposals/${budget}/edit`, { budgets: { Clothing: 100 } }, 400],
      [`/api/proposals/${goal}/edit`, { budgets: { Restaurants: 100 } }, 400],
      [`/api/proposals/${goal}/edit`, { goalAmount: 100 }, 400],
      ["/api/proposals/no-such-proposal/accept", {}, 404],
      ["/api/proposals/no-such-proposal/edit", { words: "Save" }, 404],
      ["/api/proposals/no-such-proposal/skip", {}, 404],
      ["/api/proposals/no-such-proposal/undo", {}, 404],
      // An open Proposal has no Undo yet.
      [`/api/proposals/${budget}/undo`, {}, 409],
    ];
    for (const [path, body, status] of cases) {
      expect([path, body, (await alice.post(path, body)).status]).toEqual([path, body, status]);
    }

    expect(await readEveryTable(test.database)).toEqual(before);
  });

  it("does not accept a Goal amount for a Goal that ended, and leaves the Proposal open", async () => {
    const goalId = await addGoal(test.database, {
      authorId: aliceId,
      date: "2026-10-01",
      deadline: null,
      words: "Spend less on takeout",
      target: { kind: "Category Spending", category: "Restaurants" },
      change: null,
    });
    const id = await shown({
      kind: "Goal amount",
      source: "Monthly review",
      runId: run(),
      reason: "Takeout ran $520 a month lately.",
      goalId,
      goalAmount: $(480),
    });
    await alice.post(`/api/goals/${goalId}/status`, { status: "dropped" });
    const before = await readEveryTable(test.database);

    const res = await alice.post(`/api/proposals/${id}/accept`);
    expect(res.status).toBe(400);
    expect(await readEveryTable(test.database)).toEqual(before);
  });

  it("answers 401 with no session, 403 from another site or none, and 415 to a body that is not JSON, and changes nothing", async () => {
    const budget = await budgetChange("Restaurants", $(480));
    const accepted = await budgetChange("Clothing", $(150));
    await alice.post(`/api/proposals/${accepted}/accept`);
    const before = await readEveryTable(test.database);
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    const writes: [string, unknown][] = [
      [`/api/proposals/${budget}/accept`, {}],
      [`/api/proposals/${budget}/edit`, { budgets: { Restaurants: $(500) } }],
      [`/api/proposals/${budget}/skip`, {}],
      [`/api/proposals/${accepted}/undo`, {}],
    ];

    expect((await signedOut.get("/api/proposals/undoable")).status).toBe(401);
    for (const [path, body] of writes) {
      expect([path, (await signedOut.send("POST", path, body)).status]).toEqual([path, 401]);
      for (const origin of ["http://evil.example", undefined]) {
        expect([path, origin, (await alice.send("POST", path, body, { origin })).status]).toEqual([
          path,
          origin,
          403,
        ]);
      }
      expect([
        path,
        (await alice.send("POST", path, body, { "content-type": "text/plain" })).status,
      ]).toEqual([path, 415]);
    }

    expect(await readEveryTable(test.database)).toEqual(before);
  });

  it("acts through the page's own requests", async () => {
    // The page's requests go to the app as Alice's browser, with the page's own content type and
    // body.
    const sent: { method: string; path: string; type: string | undefined; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const type = new Headers(init?.headers).get("content-type") ?? undefined;
      const method = init?.method ?? "GET";
      sent.push({ method, path: url.pathname, type, body });
      return alice.send(method, `${url.pathname}${url.search}`, body, { "content-type": type });
    });
    const restaurants = await budgetChange("Restaurants", $(480));
    const clothing = await budgetChange("Clothing", $(150));
    const goal = await newGoal();

    const card = (await loadAiBox()).groups[0]?.notes.find((note) => note.id === goal);
    expect(card?.kind).toBe("Proposal");
    if (card?.kind !== "Proposal") return;

    expect(await acceptProposal(restaurants)).toBeUndefined();
    expect(await skipProposal(clothing)).toBeUndefined();
    expect(
      await saveAndAccept(card.proposal.id, { words: "Save $1,500 for emergencies" }),
    ).toBeUndefined();
    expect((await loadUndoable()).map((proposal) => proposal.id)).toEqual([goal, restaurants]);
    expect(await undoProposal(restaurants)).toBeUndefined();
    expect(await undoProposal(restaurants)).toBe("This change is already undone.");
    expect(await skipProposal("no-such-proposal")).toBe("No open Proposal has this ID.");

    const json = "application/json";
    expect(sent.filter((request) => request.method === "POST")).toEqual([
      { method: "POST", path: `/api/proposals/${restaurants}/accept`, type: json, body: {} },
      { method: "POST", path: `/api/proposals/${clothing}/skip`, type: json, body: {} },
      {
        method: "POST",
        path: `/api/proposals/${goal}/edit`,
        type: json,
        body: { words: "Save $1,500 for emergencies" },
      },
      { method: "POST", path: `/api/proposals/${restaurants}/undo`, type: json, body: {} },
      { method: "POST", path: `/api/proposals/${restaurants}/undo`, type: json, body: {} },
      { method: "POST", path: "/api/proposals/no-such-proposal/skip", type: json, body: {} },
    ]);
  });
});
