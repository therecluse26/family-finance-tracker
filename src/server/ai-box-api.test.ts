import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiSettings, AiView } from "../ai/index.ts";
import { type AlertFacts, alertText, decideAlerts } from "../anomalies/index.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  type AlertKind,
  type AlertState,
  markSetupStep,
  type NewInsightCard,
  replaceInsightCards,
  storeAlerts,
  storeMonthlyReview,
} from "../db/index.ts";
import { createLogger } from "../log.ts";
import { fixtureReview } from "../monthly-review/testing.ts";
import { loadAiBox, markAlertNoteDone, markInsightCardDone } from "../web/ai-box.ts";
import type { AiBoxGroupName, AiBoxNoteView, AiBoxView } from "./ai-box-views.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The dashboard's AI box, "This week" (spec 07, 1. AI box), through the app's HTTP interface:
// Alert notes from the Alerts in app.db, their groups and order, the 7-day exit, Done for every
// Member, and the no-AI note; then the Insight cards after them.

const APP_URL = "http://nas.local:8080";
// Oct 20, 2026, 4 PM UTC. With no Household time zone, the app's date is UTC's.
const NOW = new Date("2026-10-20T16:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

const merchant = (name: string) => ({ id: null, name });
const budget = (category: string, spent: number, amount: number) => ({
  category,
  spent,
  budget: amount,
  period: "monthly" as const,
  span: "2026-10",
});

// Template facts for each kind.
const FACTS: Record<AlertKind, AlertFacts> = {
  "Over Budget": {
    kind: "Over Budget",
    budget: budget("Restaurants", 60_000, 48_000),
    latest: { merchant: merchant("Corner Bistro"), amount: 4_250, date: "2026-10-19" },
  },
  "Duplicate charge": {
    kind: "Duplicate charge",
    merchant: merchant("Shell"),
    account: "Rewards Card ··4821",
    amount: 4_250,
    dates: ["2026-10-17", "2026-10-18"],
  },
  "Card interest or fee": {
    kind: "Card interest or fee",
    cardInterest: true,
    merchant: null,
    account: "Rewards Card ··4821",
    amount: 3_612,
    date: "2026-10-09",
  },
  "Price increase": {
    kind: "Price increase",
    merchant: merchant("Streamflix"),
    base: 1_599,
    amount: 1_799,
    date: "2026-10-14",
    recurringCharge: "rc-1",
  },
  "On pace": { kind: "On pace", budget: budget("Groceries", 40_000, 60_000), projected: 75_000 },
  "New Recurring charge": {
    kind: "New Recurring charge",
    merchant: merchant("Ironworks Fitness"),
    amount: 4_500,
    dates: ["2026-09-12", "2026-10-12"],
    nextDate: "2026-11-12",
  },
  "Large purchase": {
    kind: "Large purchase",
    merchant: merchant("Bluebird Books"),
    amount: 84_000,
    date: "2026-10-16",
    budget: null,
  },
};

// The box with Alert notes only: these tests store no Proposal (src/server/proposals-api.test.ts).
type AlertNotesView = Omit<AiBoxView, "groups"> & {
  groups: { name: AiBoxGroupName; notes: AiBoxNoteView[] }[];
};

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-ai-box-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe('the AI box, "This week"', () => {
  let test: TestAuth;
  let app: App;
  let alice: TestBrowser;
  let bob: TestBrowser;
  let aliceMember: TestMember;
  // What the AI settings show: undefined with no AI provider.
  let aiView: AiView | undefined;

  const aiOn = (status: AiView["status"] = { state: "on" }): AiView => ({
    provider: "openai",
    keySet: true,
    baseUrl: null,
    gatewayTokenSet: false,
    quickModel: "gpt-6-luna",
    writerModel: "gpt-6.1-terra",
    prices: { quick: { source: "table" }, writer: { source: "table" } },
    status,
  });

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    aiView = aiOn();
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    const ai = { view: async () => aiView } as unknown as AiSettings;
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
      { ai },
    );
    aliceMember = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    const bobMember = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(test.database, "master key", "done");
    alice = new TestBrowser(app, APP_URL, "192.168.1.20");
    await alice.signIn(aliceMember);
    bob = new TestBrowser(app, APP_URL, "192.168.1.21");
    await bob.signIn(bobMember);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    test.close();
  });

  // Stores one Alert of `kind`, created `hoursAgo` before NOW.
  async function addAlert(
    id: string,
    kind: AlertKind,
    hoursAgo: number,
    state: AlertState | null = "sent",
  ) {
    const facts = FACTS[kind];
    await storeAlerts(test.database, [
      {
        id,
        kind,
        createdAt: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000),
        facts,
        text: alertText(facts, "2026-10-20"),
        category: null,
        state,
        transactionIds: [],
      },
    ]);
  }

  const view = async (browser = alice) => {
    const res = await browser.get("/api/ai-box");
    expect(res.status).toBe(200);
    return (await res.json()) as AlertNotesView;
  };
  const shape = (box: AlertNotesView) =>
    box.groups.map((group) => ({ name: group.name, notes: group.notes.map((note) => note.id) }));
  const done = (id: string, body: unknown, browser = alice, headers = {}) =>
    browser.send("PUT", `/api/ai-box/alert-notes/${encodeURIComponent(id)}/done`, body, headers);
  const doneRows = async () =>
    (await test.database.$client.execute("SELECT alert_id, member_id FROM alert_notes_done")).rows;

  it("puts each Alert note in its group, newest first, and leaves out an Alert found in history", async () => {
    await addAlert("over-budget", "Over Budget", 30);
    await addAlert("duplicate", "Duplicate charge", 5);
    await addAlert("interest", "Card interest or fee", 50);
    await addAlert("price", "Price increase", 10, "held back (weekly cap)");
    await addAlert("on-pace", "On pace", 20);
    await addAlert("new-recurring", "New Recurring charge", 2);
    await addAlert("large", "Large purchase", 40);
    // An Alert the Alerts step has not decided yet shows at once.
    await addAlert("undecided", "Over Budget", 1, null);
    await addAlert("from-history", "Over Budget", 3, "found in history");

    const box = await view();

    expect(shape(box)).toEqual([
      {
        name: "Worth acting on",
        notes: ["undecided", "duplicate", "price", "over-budget", "interest"],
      },
      { name: "Heads up", notes: ["new-recurring", "on-pace", "large"] },
    ]);
    expect(box.worthActingOn).toBe(5);
    expect(box.setUpAi).toBe(false);
    expect(box.paused).toBeNull();
  });

  it("builds each Alert note's number, label, title, and reason from the Alert's template facts", async () => {
    for (const [index, kind] of Object.keys(FACTS).entries()) {
      await addAlert(`alert-${index}`, kind as AlertKind, index + 1);
    }

    const notes = (await view()).groups.flatMap((group) => group.notes);
    const words = Object.fromEntries(
      notes.map((note) => [note.title, [note.figure, note.figureLabel, note.about]]),
    );

    expect(words).toEqual({
      "Restaurants is over Budget for Oct 2026": ["$120", "over Budget", "Restaurants"],
      "Possible duplicate charge at Shell": ["$42.50", "charged twice by Oct 18", "Shell"],
      "Card interest on Rewards Card ··4821": [
        "$36.12",
        "interest on Oct 9",
        "Rewards Card ··4821",
      ],
      "Streamflix went up to $17.99": ["+$2.00", "price rise on Oct 14", "Streamflix"],
      "Groceries is on pace to go over Budget": ["$150", "on pace over Budget", "Groceries"],
      "New Recurring charge at Ironworks Fitness?": [
        "$45.00",
        "next on Nov 12",
        "Ironworks Fitness",
      ],
      "Large purchase at Bluebird Books": ["$840.00", "on Oct 16", "Bluebird Books"],
    });
    const kinds = Object.keys(FACTS) as AlertKind[];
    for (const note of notes) {
      const kind = kinds[Number(note.id.slice("alert-".length))] ?? "Over Budget";
      expect(note.kind).toBe("Alert note");
      // The reason is the template text.
      expect(note.why).toEqual([alertText(FACTS[kind], "2026-10-20")]);
      // Without advice, a note has no Next step.
      expect(note.nextStep).toBeNull();
      expect(note.done).toBe(false);
    }
  });

  it("shows the AI's advice as the Next step, and a merged Alert as one note with each part's reason", async () => {
    await addAlert("first", "Over Budget", 3, null);
    await addAlert("second", "On pace", 2, null);
    await addAlert("third", "Over Budget", 1, null);
    await decideAlerts(test.database);
    await test.database.$client.execute({
      sql: "UPDATE alerts SET advice = ? WHERE id = ?",
      args: ["Skip one takeout night this week.", "third"],
    });

    const [merged] = (await view()).groups[0]?.notes ?? [];

    expect(merged).toMatchObject({
      id: "first",
      figure: "2",
      figureLabel: "Alerts on Oct 20",
      about: "Over Budget",
      title: "2 Categories are over Budget",
      nextStep: "Skip one takeout night this week.",
    });
    expect(merged?.why).toHaveLength(2);
    expect(shape(await view())).toEqual([
      { name: "Worth acting on", notes: ["first"] },
      { name: "Heads up", notes: ["second"] },
    ]);
  });

  it("drops an Alert note 7 days after its Alert", async () => {
    await addAlert("week-old", "Duplicate charge", 0);

    vi.setSystemTime(NOW.getTime() + 7 * DAY_MS - 1);
    expect(shape(await view())).toEqual([{ name: "Worth acting on", notes: ["week-old"] }]);

    vi.setSystemTime(NOW.getTime() + 7 * DAY_MS);
    const box = await view();
    expect(box.groups).toEqual([]);
    expect(box.worthActingOn).toBe(0);
  });

  it("marks a note Done for every Member with no AI call, and clears it when tapped again", async () => {
    await addAlert("over-budget", "Over Budget", 2);
    await addAlert("duplicate", "Duplicate charge", 1);
    await addAlert("large", "Large purchase", 3);

    const res = await done("over-budget", { done: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: true });

    // Bob sees it done; it stays in place, and the heading no longer counts it.
    const box = await view(bob);
    expect(shape(box)[0]?.notes).toEqual(["duplicate", "over-budget"]);
    expect(box.groups[0]?.notes.map((note) => note.done)).toEqual([false, true]);
    expect(box.worthActingOn).toBe(1);
    expect(await doneRows()).toEqual([
      expect.objectContaining({ alert_id: "over-budget", member_id: aliceMember.id }),
    ]);

    // A second Done keeps the first mark. Bob's "Done ✓" clears it for Alice too.
    expect((await done("over-budget", { done: true }, bob)).status).toBe(200);
    expect(await doneRows()).toEqual([
      expect.objectContaining({ alert_id: "over-budget", member_id: aliceMember.id }),
    ]);
    expect(await (await done("over-budget", { done: false }, bob)).json()).toEqual({
      done: false,
    });
    expect((await view()).worthActingOn).toBe(2);
    expect(await doneRows()).toEqual([]);

    // A done Heads up note does not change the heading.
    await done("large", { done: true });
    expect((await view()).worthActingOn).toBe(2);

    const calls = await test.database.$client.execute("SELECT count(*) AS n FROM ai_calls");
    expect(calls.rows[0]?.n).toBe(0);
  });

  it("clears only the note tapped, and leaves every other note Done", async () => {
    await addAlert("over-budget", "Over Budget", 2);
    await addAlert("duplicate", "Duplicate charge", 1);
    await done("over-budget", { done: true });
    await done("duplicate", { done: true });

    expect((await done("over-budget", { done: false }, bob)).status).toBe(200);

    expect((await view()).groups[0]?.notes.map((note) => [note.id, note.done])).toEqual([
      ["duplicate", true],
      ["over-budget", false],
    ]);
    expect(await doneRows()).toEqual([expect.objectContaining({ alert_id: "duplicate" })]);
  });

  it("answers 404 to an Alert not in the box, and changes nothing", async () => {
    await addAlert("from-history", "Over Budget", 1, "found in history");
    await addAlert("week-old", "Duplicate charge", 7 * 24);
    await addAlert("first", "Over Budget", 3, null);
    await addAlert("later", "Over Budget", 2, null);
    await decideAlerts(test.database);

    for (const id of ["no-such-alert", "from-history", "week-old", "later"]) {
      const res = await done(id, { done: true });
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: "No Alert note in the AI box has this ID." });
    }
    expect(await doneRows()).toEqual([]);
  });

  it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and changes nothing", async () => {
    await addAlert("over-budget", "Over Budget", 1);
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.22");

    expect((await signedOut.get("/api/ai-box")).status).toBe(401);
    expect((await done("over-budget", { done: true }, signedOut)).status).toBe(401);
    for (const origin of WRONG_ORIGINS) {
      expect((await done("over-budget", { done: true }, alice, { origin })).status).toBe(403);
    }
    expect(
      (await done("over-budget", { done: true }, alice, { "content-type": "text/plain" })).status,
    ).toBe(415);
    for (const body of [{}, { done: "yes" }, { done: true, more: 1 }, []]) {
      expect((await done("over-budget", body)).status).toBe(400);
    }
    expect(await doneRows()).toEqual([]);
  });

  it('shows "Set up AI for insights" with no AI provider, and the paused line while AI is paused', async () => {
    await addAlert("over-budget", "Over Budget", 1);

    aiView = undefined;
    expect(await view()).toMatchObject({ setUpAi: true, paused: null, worthActingOn: 1 });

    aiView = aiOn({ state: "cost cap", until: "2026-11-01" });
    expect(await view()).toMatchObject({
      setUpAi: false,
      paused: { reason: "cost cap", until: "2026-11-01" },
    });

    aiView = aiOn({ state: "key rejected" });
    expect((await view()).paused).toEqual({ reason: "key rejected" });

    // History still loading is not a pause the box shows.
    aiView = aiOn({ state: "waits for history" });
    expect((await view()).paused).toBeNull();
  });

  it("has no notes with no current Alert", async () => {
    expect(await view()).toEqual({ worthActingOn: 0, groups: [], setUpAi: false, paused: null });
  });

  it("loads and marks through the page's own requests", async () => {
    await addAlert("over-budget", "Over Budget", 1);
    // The page's requests go to the app as Alice's browser, with the page's own content type.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const type = new Headers(init?.headers).get("content-type") ?? undefined;
      return alice.send(init?.method ?? "GET", `${url.pathname}${url.search}`, body, {
        "content-type": type,
      });
    });

    expect(await markAlertNoteDone("over-budget", true)).toBeUndefined();
    expect(((await loadAiBox()) as AlertNotesView).groups[0]?.notes[0]?.done).toBe(true);
    expect(await markAlertNoteDone("no-such-alert", true)).toBe(
      "No Alert note in the AI box has this ID.",
    );
  });

  it("forgets a Done mark with its Alert, and keeps it when the Member who marked it leaves", async () => {
    await addAlert("over-budget", "Over Budget", 1);
    await addAlert("duplicate", "Duplicate charge", 1);
    await done("over-budget", { done: true });
    await done("duplicate", { done: true });

    await test.database.$client.execute({
      sql: "DELETE FROM alerts WHERE id = ?",
      args: ["over-budget"],
    });
    await test.database.$client.execute({
      sql: "DELETE FROM members WHERE id = ?",
      args: [aliceMember.id],
    });

    expect(await doneRows()).toEqual([
      expect.objectContaining({ alert_id: "duplicate", member_id: null }),
    ]);
  });

  describe("Insight cards", () => {
    // A run's card, as the insights module stores it.
    const card = (id: string, fields: Partial<NewInsightCard> = {}): NewInsightCard => ({
      id,
      position: 0,
      writtenAt: new Date(NOW.getTime() - 60 * 60 * 1000),
      month: "2026-10",
      group: "worth_acting_on",
      about: "Restaurants",
      figure: 84,
      figureKind: "dollars",
      figureLabel: "on delivery fees",
      title: "Delivery fees add up",
      why: "Six delivery orders this month each paid a fee.",
      nextStep: "Pick up two orders a week instead.",
      picture: { type: "days", category: "Restaurants" },
      ...fields,
    });
    const cardDone = (id: string, body: unknown, browser = alice, headers = {}) =>
      browser.send(
        "PUT",
        `/api/ai-box/insight-cards/${encodeURIComponent(id)}/done`,
        body,
        headers,
      );
    const cardRows = async () =>
      (
        await test.database.$client.execute(
          "SELECT id, done_at, done_by FROM insight_cards ORDER BY position",
        )
      ).rows;

    beforeEach(async () => {
      await replaceInsightCards(test.database, [
        card("save-delivery"),
        card("good-groceries", {
          position: 1,
          group: "good_news",
          about: "Groceries",
          figure: 3,
          figureKind: "count",
          figureLabel: "months under Budget",
          title: "Groceries stayed under Budget",
          picture: null,
        }),
        card("heads-insurance", {
          position: 2,
          group: "heads_up",
          about: "Insurance",
          figure: null,
          figureLabel: "a label with no figure",
          title: "Car insurance renews next month",
          picture: { type: "recurring", category: "Insurance" },
        }),
        card("save-subscriptions", {
          position: 3,
          figure: 12.5,
          figureKind: "percent",
          figureLabel: "of Spending",
          about: "Subscriptions",
          title: "Subscriptions grew",
          picture: { type: "cards" },
        }),
      ]);
    });

    it("go after the Alert notes and the review link in each group, in the AI's order, and count toward the heading", async () => {
      await addAlert("over-budget", "Over Budget", 2);
      await addAlert("large", "Large purchase", 3);
      await storeMonthlyReview(test.database, {
        month: "2026-09",
        writtenAt: new Date(NOW.getTime() - DAY_MS),
        review: fixtureReview({ writtenOn: "2026-10-19" }),
      });
      const box = await view();

      expect(
        box.groups.map((group) => ({
          name: group.name,
          notes: group.notes.map((note) => note.id),
        })),
      ).toEqual([
        { name: "Worth acting on", notes: ["over-budget", "save-delivery", "save-subscriptions"] },
        { name: "Heads up", notes: ["large", "2026-09", "heads-insurance"] },
        { name: "Good news", notes: ["good-groceries"] },
      ]);
      expect(box.worthActingOn).toBe(3);
      const byId = new Map(
        box.groups.flatMap((group) => group.notes).map((note) => [note.id, note as unknown]),
      );
      expect(byId.get("save-delivery")).toEqual({
        kind: "Insight card",
        id: "save-delivery",
        figure: "$84",
        figureLabel: "on delivery fees",
        about: "Restaurants",
        title: "Delivery fees add up",
        why: "Six delivery orders this month each paid a fee.",
        picture: { type: "days", category: "Restaurants" },
        month: "2026-10",
        nextStep: "Pick up two orders a week instead.",
        done: false,
      });
      expect(byId.get("save-subscriptions")).toMatchObject({
        figure: "13%",
        picture: { type: "cards" },
      });
      // No figure shows no label either.
      expect(byId.get("heads-insurance")).toMatchObject({ figure: "", figureLabel: "" });
      expect(byId.get("good-groceries")).toMatchObject({ figure: "3", picture: null });
    });

    it("stay while AI is paused, and with no AI provider", async () => {
      aiView = aiOn({ state: "cost cap", until: "2026-11-01" });
      expect((await view()).groups.flatMap((group) => group.notes)).toHaveLength(4);
      aiView = undefined;
      expect((await view()).groups.flatMap((group) => group.notes)).toHaveLength(4);
    });

    it("are marked Done for every Member with no AI call, and cleared when tapped again", async () => {
      const res = await cardDone("save-delivery", { done: true });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ done: true });

      const box = await view(bob);
      expect(box.groups[0]?.notes.map((note) => [note.id, note.done])).toEqual([
        ["save-delivery", true],
        ["save-subscriptions", false],
      ]);
      expect(box.worthActingOn).toBe(1);
      const [marked] = await cardRows();
      expect(marked?.done_by).toBe(aliceMember.id);

      // A second Done keeps the first mark; Bob's "Done ✓" clears it for Alice too.
      expect((await cardDone("save-delivery", { done: true }, bob)).status).toBe(200);
      expect((await cardRows())[0]?.done_by).toBe(aliceMember.id);
      expect((await cardDone("save-delivery", { done: false }, bob)).status).toBe(200);
      expect((await view()).worthActingOn).toBe(2);
      expect((await cardRows()).every((row) => row.done_at === null)).toBe(true);

      const calls = await test.database.$client.execute("SELECT count(*) AS n FROM ai_calls");
      expect(calls.rows[0]?.n).toBe(0);
    });

    it("answer 404 to a card no longer in the box, or an Alert's ID, and change nothing", async () => {
      await addAlert("over-budget", "Over Budget", 1);
      // A new run replaces every card: the old IDs are gone.
      await replaceInsightCards(test.database, [card("next-run")]);

      for (const id of ["save-delivery", "over-budget", "no-such-card"]) {
        const res = await cardDone(id, { done: true });
        expect(res.status, id).toBe(404);
        expect(await res.json()).toEqual({ error: "No Insight card in the AI box has this ID." });
      }
      expect(await cardRows()).toEqual([
        expect.objectContaining({ id: "next-run", done_at: null }),
      ]);
      // And an Insight card's ID marks no Alert note.
      expect((await done("next-run", { done: true })).status).toBe(404);
    });

    it("answer 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and change nothing", async () => {
      const signedOut = new TestBrowser(app, APP_URL, "192.168.1.22");

      expect((await cardDone("save-delivery", { done: true }, signedOut)).status).toBe(401);
      for (const origin of WRONG_ORIGINS) {
        expect((await cardDone("save-delivery", { done: true }, alice, { origin })).status).toBe(
          403,
        );
      }
      expect(
        (await cardDone("save-delivery", { done: true }, alice, { "content-type": "text/plain" }))
          .status,
      ).toBe(415);
      for (const body of [{}, { done: "yes" }, { done: true, more: 1 }, []]) {
        expect((await cardDone("save-delivery", body)).status).toBe(400);
      }
      expect((await cardRows()).every((row) => row.done_at === null && row.done_by === null)).toBe(
        true,
      );
    });

    it("mark through the page's own request, and keep the mark when the Member who made it leaves", async () => {
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        const type = new Headers(init?.headers).get("content-type") ?? undefined;
        return alice.send(init?.method ?? "GET", `${url.pathname}${url.search}`, body, {
          "content-type": type,
        });
      });
      expect(await markInsightCardDone("save-delivery", true)).toBeUndefined();
      expect(await markInsightCardDone("no-such-card", true)).toBe(
        "No Insight card in the AI box has this ID.",
      );

      await test.database.$client.execute({
        sql: "DELETE FROM members WHERE id = ?",
        args: [aliceMember.id],
      });
      const [kept] = await cardRows();
      expect(kept).toMatchObject({ id: "save-delivery", done_by: null });
      expect(kept?.done_at).not.toBeNull();
    });
  });
});
