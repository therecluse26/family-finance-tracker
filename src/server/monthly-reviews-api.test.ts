import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AlertFacts, alertText } from "../anomalies/index.ts";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  type AlertState,
  markSetupStep,
  readMonthlyReview,
  storeAiSettings,
  storeAlerts,
  storeMonthlyReview,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import type { StoredReview } from "../monthly-review/index.ts";
import { fixtureReview } from "../monthly-review/testing.ts";
import { propose } from "../proposals/index.ts";
import { loadAiBox } from "../web/ai-box.ts";
import {
  loadReview,
  loadReviewList,
  markReviewLinkDone,
  tickPlanItem,
} from "../web/monthly-review.ts";
import type { AiBoxView } from "./ai-box-views.ts";
import { createApp } from "./app.ts";
import type { MonthlyReviewView, ReviewListView } from "./monthly-reviews-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The Reviews page and the AI box's review link (spec 07, Reviews page; 1. AI box), through the
// app's HTTP interface, on fixture review objects: the list, one review as it was written, the
// plan's shared ticks stored apart from the review, the held-back Alerts, the open Proposals, and
// the review link's exit. Writing a review is the Monthly review run's.

const APP_URL = "http://nas.local:8080";
// Tuesday, Nov 3, 2026, 3 PM UTC. With no Household time zone, the app's date is UTC's.
const NOW = new Date("2026-11-03T15:00:00.000Z");
const OCTOBER_WRITTEN = new Date("2026-11-01T14:00:00.000Z");
const SEPTEMBER_WRITTEN = new Date("2026-10-01T14:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

const OVER_BUDGET: AlertFacts = {
  kind: "Over Budget",
  budget: {
    category: "Restaurants",
    spent: 60_000,
    budget: 48_000,
    period: "monthly",
    span: "2026-10",
  },
  latest: { merchant: { id: null, name: "Corner Bistro" }, amount: 4_250, date: "2026-10-19" },
};

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-monthly-reviews-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Reviews page and the review link", () => {
  let test: TestAuth;
  let app: App;
  let alice: TestBrowser;
  let bob: TestBrowser;
  let aliceMember: TestMember;

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

  const storeReview = (month: string, writtenAt: Date, review: StoredReview = fixtureReview()) =>
    storeMonthlyReview(test.database, { month, writtenAt, review });

  const storeOctober = () => storeReview("2026-10", OCTOBER_WRITTEN);

  async function addAlert(id: string, createdAt: string, state: AlertState) {
    await storeAlerts(test.database, [
      {
        id,
        kind: "Over Budget",
        createdAt: new Date(createdAt),
        facts: OVER_BUDGET,
        text: alertText(OVER_BUDGET, createdAt.slice(0, 10)),
        category: "Restaurants",
        state,
        transactionIds: [],
      },
    ]);
  }

  // A new Goal Proposal, which needs no Budget, made by a run at `at`.
  async function addProposal(
    words: string,
    at: Date,
    source: "Chat" | "Monthly review" = "Chat",
    runId = `run-${words}`,
  ): Promise<string> {
    const made = await propose(
      test.database,
      { kind: "new Goal", source, runId, reason: "It fits the month.", words },
      at,
    );
    if (made.outcome !== "shown") throw new Error(made.guardrail);
    return made.id;
  }

  const view = async (month = "2026-10", browser = alice) => {
    const res = await browser.get(`/api/monthly-reviews/${month}`);
    expect(res.status).toBe(200);
    return (await res.json()) as MonthlyReviewView;
  };
  const tick = (body: unknown, item = "1", month = "2026-10", browser = alice, headers = {}) =>
    browser.send("PUT", `/api/monthly-reviews/${month}/plan/${item}`, body, headers);
  const tickRows = async () =>
    (
      await test.database.$client.execute(
        "SELECT month, item, member_id FROM review_plan_ticks ORDER BY month, item",
      )
    ).rows;
  const linkDone = (body: unknown, month = "2026-10", browser = alice, headers = {}) =>
    browser.send("PUT", `/api/ai-box/review-links/${month}/done`, body, headers);
  const linkDoneRows = async () =>
    (await test.database.$client.execute("SELECT month, member_id FROM review_links_done")).rows;
  const headsUp = async (browser = alice) => {
    const res = await browser.get("/api/ai-box");
    expect(res.status).toBe(200);
    const box = (await res.json()) as AiBoxView;
    return box.groups.find((group) => group.name === "Heads up")?.notes ?? [];
  };

  it("lists the past reviews newest first, and says with no AI provider that none is written", async () => {
    const list = async () => {
      const res = await alice.get("/api/monthly-reviews");
      expect(res.status).toBe(200);
      return (await res.json()) as ReviewListView;
    };
    expect(await list()).toEqual({ aiProvider: false, reviews: [] });

    await storeAiSettings(
      test.database,
      {
        provider: "openai-compatible",
        apiKey: null,
        baseUrl: "http://127.0.0.1:9/v1",
        gatewayToken: null,
        quickModel: "test-quick",
        writerModel: "test-writer",
        chatModel: "chat-model",
        keyRejectedAt: null,
      },
      0,
    );
    await storeReview("2026-09", SEPTEMBER_WRITTEN, fixtureReview({ writtenOn: "2026-10-01" }));
    await storeOctober();
    expect(await list()).toEqual({
      aiProvider: true,
      reviews: [
        { month: "2026-10", writtenOn: "2026-11-01" },
        { month: "2026-09", writtenOn: "2026-10-01" },
      ],
    });
  });

  it("opens a month's review as it was written, with no write, and answers 404 for a month with none", async () => {
    await storeOctober();
    const before = await readEveryTable(test.database);

    const opened = await view();
    expect(opened.month).toBe("2026-10");
    expect(opened.review).toEqual(fixtureReview());
    expect(opened.ticked).toEqual([]);
    expect(await readEveryTable(test.database)).toEqual(before);

    for (const month of ["2026-08", "2026-13", "x"]) {
      const res = await alice.get(`/api/monthly-reviews/${month}`);
      expect(res.status, month).toBe(404);
      expect(await res.json()).toEqual({ error: "No Monthly review has this month." });
    }
  });

  it("lists the Alerts the weekly cap held back that month, oldest first, and no other Alert", async () => {
    await storeOctober();
    await addAlert("held-late", "2026-10-28T12:00:00.000Z", "held back (weekly cap)");
    await addAlert("held-early", "2026-10-06T12:00:00.000Z", "held back (weekly cap)");
    await addAlert("sent", "2026-10-15T12:00:00.000Z", "sent");
    await addAlert("from-history", "2026-10-16T12:00:00.000Z", "found in history");
    await addAlert("held-september", "2026-09-29T12:00:00.000Z", "held back (weekly cap)");
    await addAlert("held-november", "2026-11-02T12:00:00.000Z", "held back (weekly cap)");

    const { heldBack } = await view();
    expect(heldBack.map((alert) => alert.id)).toEqual(["held-early", "held-late"]);
    expect(heldBack[0]).toEqual({
      id: "held-early",
      createdAt: "2026-10-06T12:00:00.000Z",
      heading: null,
      texts: [alertText(OVER_BUDGET, "2026-10-06")],
    });
  });

  it("shows the open Proposals still open when it was written, and its own run's, with no write", async () => {
    await storeOctober();
    const before = await addProposal("Save for a new bike", new Date("2026-10-20T12:00:00.000Z"));
    const own = await addProposal(
      "Cook at home four nights",
      new Date(OCTOBER_WRITTEN.getTime() + 60_000),
      "Monthly review",
      "2026-10",
    );
    // A Proposal from a Chat answer after the review was written goes in the next review.
    await addProposal("Pay off the car early", new Date("2026-11-02T12:00:00.000Z"));
    // Another month's review run.
    await addProposal(
      "Walk to work twice",
      new Date("2026-11-02T13:00:00.000Z"),
      "Monthly review",
      "2026-11",
    );
    // A skipped Proposal is not open.
    const skipped = await addProposal("Start a rainy day fund", new Date("2026-10-21T12:00:00Z"));
    expect((await alice.post(`/api/proposals/${skipped}/skip`, {})).status).toBe(200);
    // One past its 60 days shows nowhere, and opening the review does not close it.
    await addProposal("Read more books", new Date(NOW.getTime() - 61 * DAY_MS));
    const rows = await readEveryTable(test.database);

    expect((await view()).proposals.map((proposal) => proposal.id)).toEqual([own, before]);
    expect(await readEveryTable(test.database)).toEqual(rows);
  });

  it("shares a plan tick with every Member, and stores it apart from the review, which never changes", async () => {
    await storeOctober();
    const written = await readMonthlyReview(test.database, "2026-10");

    expect((await tick({ done: true })).status).toBe(200);
    expect((await view("2026-10", bob)).ticked).toEqual([1]);
    expect((await tick({ done: true }, "0", "2026-10", bob)).status).toBe(200);
    expect((await view()).ticked).toEqual([0, 1]);
    // Ticking again keeps the first tick.
    expect((await tick({ done: true }, "1", "2026-10", bob)).status).toBe(200);
    expect(await tickRows()).toEqual([
      expect.objectContaining({ item: 0, member_id: expect.any(String) }),
      expect.objectContaining({ item: 1, member_id: aliceMember.id }),
    ]);

    expect((await tick({ done: false }, "1", "2026-10", bob)).status).toBe(200);
    expect((await view()).ticked).toEqual([0]);
    expect(await readMonthlyReview(test.database, "2026-10")).toEqual(written);
  });

  it("ticks only the month's own review, and answers 404 for a month with none", async () => {
    await storeOctober();
    await storeReview("2026-09", SEPTEMBER_WRITTEN);

    expect((await tick({ done: true }, "2", "2026-09")).status).toBe(200);
    expect((await view("2026-10")).ticked).toEqual([]);
    expect((await view("2026-09")).ticked).toEqual([2]);

    // Clearing a tick clears that month's only: September keeps the same item's tick.
    expect((await tick({ done: true }, "2", "2026-10")).status).toBe(200);
    expect((await tick({ done: false }, "2", "2026-10")).status).toBe(200);
    expect((await view("2026-10")).ticked).toEqual([]);
    expect((await view("2026-09")).ticked).toEqual([2]);

    const res = await tick({ done: true }, "1", "2026-08");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "No Monthly review has this month." });
    expect(await tickRows()).toEqual([expect.objectContaining({ month: "2026-09", item: 2 })]);
  });

  it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad tick, and changes nothing", async () => {
    await storeOctober();
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.22");

    expect((await signedOut.get("/api/monthly-reviews")).status).toBe(401);
    expect((await signedOut.get("/api/monthly-reviews/2026-10")).status).toBe(401);
    expect((await tick({ done: true }, "1", "2026-10", signedOut)).status).toBe(401);
    for (const origin of WRONG_ORIGINS) {
      expect((await tick({ done: true }, "1", "2026-10", alice, { origin })).status).toBe(403);
    }
    expect(
      (await tick({ done: true }, "1", "2026-10", alice, { "content-type": "text/plain" })).status,
    ).toBe(415);
    for (const body of [{}, { done: "yes" }, { done: true, more: 1 }, []]) {
      expect((await tick(body)).status).toBe(400);
    }
    // The plan has exactly 3 items, and the path writes each place as 0, 1, or 2.
    for (const item of ["3", "-1", "01", "1.0", "%201", "one"]) {
      expect((await tick({ done: true }, item)).status, item).toBe(400);
    }
    expect(await tickRows()).toEqual([]);
  });

  it("links to the review in Heads up from when it is written until 7 days pass", async () => {
    await storeReview("2026-09", SEPTEMBER_WRITTEN);
    await storeOctober();
    // A review stamped after the box's clock shows from then on.
    await storeReview("2026-11", new Date(NOW.getTime() + DAY_MS));

    expect(await headsUp()).toEqual([
      { kind: "Review link", id: "2026-10", createdAt: OCTOBER_WRITTEN.toISOString() },
    ]);
    // The link counts in no "worth acting on" heading.
    expect(((await (await alice.get("/api/ai-box")).json()) as AiBoxView).worthActingOn).toBe(0);

    vi.setSystemTime(new Date(OCTOBER_WRITTEN.getTime() + 7 * DAY_MS - 1));
    expect((await headsUp()).map((note) => note.id)).toEqual(["2026-11", "2026-10"]);
    vi.setSystemTime(new Date(OCTOBER_WRITTEN.getTime() + 7 * DAY_MS));
    expect((await headsUp()).map((note) => note.id)).toEqual(["2026-11"]);
  });

  it("takes the review link out of the box for every Member once one marks it Done, with no AI call", async () => {
    await storeOctober();
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);

    expect((await linkDone({ done: true })).status).toBe(200);
    expect(await headsUp(bob)).toEqual([]);
    expect(await linkDoneRows()).toEqual([{ month: "2026-10", member_id: aliceMember.id }]);
    expect(fetched).not.toHaveBeenCalled();
    // The review itself still opens.
    expect((await view("2026-10", bob)).review).toEqual(fixtureReview());

    expect((await linkDone({ done: false }, "2026-10", bob)).status).toBe(200);
    expect((await headsUp()).map((note) => note.id)).toEqual(["2026-10"]);
  });

  it("clears the Done mark of one review link only, and the other stays Done and out of the box", async () => {
    await storeOctober();
    // A second link inside the 7 days, written after October's.
    await storeReview("2026-09", new Date(OCTOBER_WRITTEN.getTime() + 60_000));
    expect((await linkDone({ done: true })).status).toBe(200);
    expect((await linkDone({ done: true }, "2026-09")).status).toBe(200);
    expect(await headsUp()).toEqual([]);

    expect((await linkDone({ done: false }, "2026-10", bob)).status).toBe(200);
    expect((await headsUp(bob)).map((note) => note.id)).toEqual(["2026-10"]);
    expect(await linkDoneRows()).toEqual([{ month: "2026-09", member_id: aliceMember.id }]);
  });

  it("answers 404 to a review link not in the box, 401, 403, 415 and 400 as the other notes, and changes nothing", async () => {
    await storeReview("2026-09", SEPTEMBER_WRITTEN);
    await storeOctober();
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.22");

    for (const month of ["2026-09", "2026-08", "x"]) {
      const res = await linkDone({ done: true }, month);
      expect(res.status, month).toBe(404);
      expect(await res.json()).toEqual({ error: "No review link in the AI box has this month." });
    }
    expect((await linkDone({ done: true }, "2026-10", signedOut)).status).toBe(401);
    for (const origin of WRONG_ORIGINS) {
      expect((await linkDone({ done: true }, "2026-10", alice, { origin })).status).toBe(403);
    }
    expect(
      (await linkDone({ done: true }, "2026-10", alice, { "content-type": "text/plain" })).status,
    ).toBe(415);
    for (const body of [{}, { done: "yes" }, { done: true, more: 1 }]) {
      expect((await linkDone(body)).status).toBe(400);
    }
    expect(await linkDoneRows()).toEqual([]);
  });

  it("keeps ticks and Done marks when the Member who made them leaves, and drops them with their review", async () => {
    await storeOctober();
    await storeReview("2026-09", SEPTEMBER_WRITTEN);
    await tick({ done: true }, "0");
    await tick({ done: true }, "0", "2026-09");
    await linkDone({ done: true });

    await test.database.$client.execute({
      sql: "DELETE FROM members WHERE id = ?",
      args: [aliceMember.id],
    });
    await test.database.$client.execute({
      sql: "DELETE FROM monthly_reviews WHERE month = ?",
      args: ["2026-09"],
    });

    expect(await tickRows()).toEqual([{ month: "2026-10", item: 0, member_id: null }]);
    expect(await linkDoneRows()).toEqual([{ month: "2026-10", member_id: null }]);
  });

  it("loads, ticks and marks Done through the page's own requests", async () => {
    await storeOctober();
    // The page's requests go to the app as Alice's browser, with the page's own content type.
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input), APP_URL);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const type = new Headers(init?.headers).get("content-type") ?? undefined;
      return alice.send(init?.method ?? "GET", `${url.pathname}${url.search}`, body, {
        "content-type": type,
      });
    });

    expect((await loadReviewList()).reviews.map((review) => review.month)).toEqual(["2026-10"]);
    expect(await tickPlanItem("2026-10", 2, true)).toBeUndefined();
    expect((await loadReview("2026-10"))?.ticked).toEqual([2]);
    expect(await loadReview("2026-08")).toBeNull();
    expect(await tickPlanItem("2026-08", 2, true)).toBe("No Monthly review has this month.");
    expect(await markReviewLinkDone("2026-10", true)).toBeUndefined();
    expect((await loadAiBox()).groups).toEqual([]);
  });
});
