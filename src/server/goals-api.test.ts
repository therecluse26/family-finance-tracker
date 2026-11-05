import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { addGoal, listGoals, markSetupStep } from "../db/index.ts";
import { startGoal } from "../goals/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import type { GoalView } from "./goals-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Goals and their progress through the app's HTTP interface (spec 05, Goals). Each reading is
// written directly, with no AI.

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-goals-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Goal routes", () => {
  let test: TestAuth;
  let app: App;
  let browser: TestBrowser;
  let memberId: string;
  let saving: string;
  let noTarget: string;

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

    const reading = { authorId: memberId, date: "2026-10-01", deadline: null };
    saving = await addGoal(test.database, {
      ...reading,
      words: "Save $1,000",
      target: { kind: "Saving" },
      change: { amount: 100_000 },
    });
    await startGoal(test.database, saving);
    noTarget = await addGoal(test.database, {
      ...reading,
      words: "Be careful with money",
      target: null,
      change: null,
    });
  });

  afterEach(() => {
    test.close();
  });

  const goals = async () =>
    ((await (await browser.get("/api/goals")).json()) as { goals: GoalView[] }).goals;

  it("returns each Goal with its progress", async () => {
    expect(await goals()).toEqual([
      expect.objectContaining({
        id: saving,
        words: "Save $1,000",
        authorId: memberId,
        date: "2026-10-01",
        status: "active",
        reading: { target: { kind: "Saving" }, change: { amount: 100_000 }, deadline: null },
        goalAmount: 100_000,
        list: "active",
        progress: {
          kind: "save toward an amount",
          percentage: 0,
          state: null,
          detail: "$0 of $1,000",
          estimated: false,
        },
      }),
      expect.objectContaining({ id: noTarget, list: "active", progress: null }),
    ]);
  });

  it("marks an active Goal done or dropped, by the signed-in Member", async () => {
    const res = await browser.send("POST", `/api/goals/${noTarget}/status`, { status: "dropped" });
    expect(res.status).toBe(200);
    const { goal } = (await res.json()) as { goal: GoalView };
    expect(goal).toMatchObject({ id: noTarget, status: "dropped", endedBy: memberId });
    expect(goal.list).toBe("dropped");

    const done = await browser.send("POST", `/api/goals/${saving}/status`, { status: "done" });
    expect(await done.json()).toEqual({
      goal: expect.objectContaining({
        status: "done",
        list: "active",
        progress: expect.objectContaining({ state: "Done", percentage: 100 }),
      }),
    });
    expect((await goals()).map((each) => each.id)).toEqual([saving, noTarget]);
  });

  it("answers 409 to a Goal that is not active, 404 to an unknown one, and 400 to a bad mark, and changes nothing", async () => {
    await browser.send("POST", `/api/goals/${noTarget}/status`, { status: "dropped" });
    const before = await listGoals(test.database);

    const again = await browser.send("POST", `/api/goals/${noTarget}/status`, { status: "done" });
    expect(again.status).toBe(409);
    expect(
      (await browser.send("POST", "/api/goals/no-such-goal/status", { status: "done" })).status,
    ).toBe(404);
    for (const body of [{ status: "active" }, { status: "done", by: "x" }, {}]) {
      expect((await browser.send("POST", `/api/goals/${saving}/status`, body)).status).toBe(400);
    }

    expect(await listGoals(test.database)).toEqual(before);
  });

  it("answers 401 with no session, 403 from another site, and 415 to a body that is not JSON, and changes nothing", async () => {
    const before = await listGoals(test.database);
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");
    const path = `/api/goals/${saving}/status`;
    const body = { status: "dropped" };

    expect((await signedOut.get("/api/goals")).status).toBe(401);
    expect((await signedOut.send("POST", path, body)).status).toBe(401);
    for (const origin of ["http://evil.example", undefined]) {
      expect((await browser.send("POST", path, body, { origin })).status).toBe(403);
    }
    expect((await browser.send("POST", path, body, { "content-type": "text/plain" })).status).toBe(
      415,
    );

    expect(await listGoals(test.database)).toEqual(before);
  });
});
