import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import {
  addConnection,
  markConnectionRemoved,
  markSetupStep,
  removeMember,
  storeAiSettings,
} from "../db/index.ts";
import { createLogger } from "../log.ts";
import { smtpSettings } from "../notify/index.ts";
import { StubSmtp, smtpError } from "../notify/testing.ts";
import { skippedWizardSteps } from "../web/setup-gate.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import type { SetupProgressView } from "./setup-views.ts";
import { type App, TestBrowser } from "./testing.ts";

// The first-run wizard's steps 5 and 6 and the dashboard's "Finish setup" list (spec 12, The
// first-run wizard; spec 07, Header and status lines), through the app's HTTP interface. Each
// test gets a new app.db and Master key. SMTP is stubbed, the bank is the fake adapter's, and
// every password, TOTP secret, and token is made when the test runs.

const APP_URL = "http://nas.local:8080";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const TOTP_STEP_MS = 30_000;

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

const NOTHING_YET: SetupProgressView["steps"] = {
  banks: null,
  ai: null,
  alerts: null,
  "invite members": null,
};

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-setup-steps-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the first-run wizard, steps 5 and 6", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubSmtp;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let aliceTab: TestBrowser;
  let clients = 0;
  // Made when the test runs.
  let password: string;

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);

  async function signedIn(member: TestMember): Promise<TestBrowser> {
    later(TOTP_STEP_MS);
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(member);
    later(TOTP_STEP_MS);
    return tab;
  }

  // Making an invite link takes an empty JSON body.
  const makeInvite = (tab: TestBrowser) => tab.post("/api/invites", {});

  async function finishRequiredSteps(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  }

  async function progressOf(tab = aliceTab): Promise<SetupProgressView> {
    const res = await tab.get("/api/setup/progress");
    expect(res.status).toBe(200);
    return ((await res.json()) as { progress: SetupProgressView }).progress;
  }

  // The exact requests the wizard sends: each with an empty JSON body.
  const skip = (step: string, tab = aliceTab, headers: Record<string, string | undefined> = {}) =>
    tab.send("POST", `/api/setup/steps/${encodeURIComponent(step)}/skip`, {}, headers);
  const finish = (tab = aliceTab, headers: Record<string, string | undefined> = {}) =>
    tab.send("POST", "/api/setup/finish", {}, headers);

  const steps = async () =>
    (await test.database.$client.execute("SELECT step, status FROM setup_steps ORDER BY step"))
      .rows;

  async function saveSmtp(tab = aliceTab) {
    const res = await tab.post("/api/smtp/settings", {
      host: "smtp.example.test",
      port: 587,
      username: "household@example.test",
      password,
      sender: "alerts@example.test",
    });
    expect(res.status).toBe(200);
  }

  const addUnconnectedAccount = (tab = aliceTab) =>
    tab.post("/api/unconnected-accounts", { name: "Credit union savings", kind: "savings" });

  async function addAiProvider(): Promise<void> {
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
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    lines = [];
    password = `pw-${crypto.randomUUID()}`;
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    stub = new StubSmtp();
    const security = await loadSecurity({ APP_URL }, { logger });
    app = createApp(webRoot, security, test.auth, test.database, test.secrets, {
      smtp: smtpSettings({
        database: test.database,
        secrets: test.secrets,
        address: (path) => security.appUrl.address(path),
        makeTransport: stub.makeTransport,
        logger,
      }),
    });
    // Alice made her login in step 2. Bob joins later, by invite.
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.test" });
    later(60_000);
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.test" });
    aliceTab = await signedIn(alice);
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  it("opens no step until steps 1 to 4 are done, and refuses Skip for now and Finish", async () => {
    await markSetupStep(test.database, "master key", "done");

    expect(await progressOf()).toEqual({
      next: null,
      steps: NOTHING_YET,
      finishSetup: [],
      connections: 0,
    });
    const skipped = await skip("banks");
    expect(skipped.status).toBe(409);
    expect((await finish()).status).toBe(409);
    expect(await steps()).toEqual([{ step: "master key", status: "done" }]);
  });

  it("opens step 5, Banks, for the first Member once steps 1 to 4 are done", async () => {
    await finishRequiredSteps();

    expect(await progressOf()).toEqual({
      next: "banks",
      steps: NOTHING_YET,
      finishSetup: ["banks", "ai", "alerts", "invite members"],
      connections: 0,
    });
  });

  it("opens Banks on the next visit until it is done or skipped, then Finish", async () => {
    await finishRequiredSteps();
    // The optional extras never hold the wizard up, done or not.
    expect((await makeInvite(aliceTab)).status).toBe(200);

    const tab = await signedIn(alice);
    expect(await progressOf(tab)).toMatchObject({
      next: "banks",
      steps: { banks: null, ai: null, alerts: null, "invite members": "done" },
    });
    expect((await skip("banks", tab)).status).toBe(200);
    expect(await progressOf(await signedIn(alice))).toMatchObject({
      next: "finish",
      steps: { banks: "skipped", ai: null, alerts: null },
    });
  });

  it("makes Banks done only with a Connection, not with an Unconnected account", async () => {
    await finishRequiredSteps();
    expect((await progressOf()).steps.banks).toBeNull();

    expect((await addUnconnectedAccount()).status).toBe(200);
    expect(await progressOf()).toMatchObject({ next: "banks", steps: { banks: null } });

    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: "ins_fake_1",
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    expect(await progressOf()).toMatchObject({
      next: "finish",
      steps: { banks: "done" },
      connections: 1,
    });

    expect((await progressOf()).finishSetup).not.toContain("banks");

    // A done step stays done once its Connection is removed, but the "Finish setup" list asks for a
    // bank again.
    expect(await markConnectionRemoved(test.database, connectionId, new Date())).toMatchObject({
      removed: true,
    });
    expect(await progressOf()).toMatchObject({
      next: "finish",
      steps: { banks: "done" },
      finishSetup: ["banks", "ai", "alerts", "invite members"],
      connections: 0,
    });
  });

  it("lists Banks under Finish setup on an install that recorded Banks done with no Connection", async () => {
    // The old wizard marked Banks done for an Unconnected account alone.
    await finishRequiredSteps();
    expect((await addUnconnectedAccount()).status).toBe(200);
    await markSetupStep(test.database, "banks", "done");
    await markSetupStep(test.database, "finish", "done");
    const bobTab = await signedIn(bob);

    for (const tab of [aliceTab, bobTab]) {
      expect(await progressOf(tab)).toMatchObject({
        next: null,
        steps: { banks: "done" },
        finishSetup: ["banks", "ai", "alerts", "invite members"],
      });
    }

    await addConnection(test.database, {
      provider: "fake",
      bankId: "ins_fake_1",
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    expect((await progressOf(bobTab)).finishSetup).toEqual(["ai", "alerts", "invite members"]);
  });

  it("records a skipped Banks step, which the step bar shows as not done, also after a reload", async () => {
    await finishRequiredSteps();
    const res = await skip("banks");
    expect(res.status).toBe(200);
    const answer = ((await res.json()) as { progress: SetupProgressView }).progress;
    expect(answer.next).toBe("finish");
    expect(skippedWizardSteps(answer)).toEqual(["banks"]);

    // A reload on Finish reads progress again, in a new tab.
    const reloaded = await progressOf(await signedIn(alice));
    expect(reloaded.next).toBe("finish");
    expect(skippedWizardSteps(reloaded)).toEqual(["banks"]);

    await addConnection(test.database, {
      provider: "fake",
      bankId: "ins_fake_1",
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    expect(skippedWizardSteps(await progressOf())).toEqual([]);
  });

  it("does not count a removed Connection for Banks", async () => {
    await finishRequiredSteps();
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: "ins_fake_1",
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await markConnectionRemoved(test.database, connectionId, new Date());

    expect(await progressOf()).toMatchObject({ next: "banks", steps: { banks: null } });
  });

  it("makes AI done once an AI provider is set", async () => {
    await finishRequiredSteps();
    expect((await progressOf()).steps.ai).toBeNull();

    await addAiProvider();
    expect(await progressOf()).toMatchObject({ next: "banks", steps: { ai: "done" } });
  });

  it("makes Alerts done only after a test email goes out", async () => {
    await finishRequiredSteps();
    await saveSmtp();
    expect((await progressOf()).steps.alerts).toBeNull();

    stub.failWith = smtpError("EAUTH", 535, "Authentication failed");
    expect((await aliceTab.post("/api/smtp/test", {})).status).toBe(502);
    expect((await progressOf()).steps.alerts).toBeNull();

    stub.failWith = undefined;
    expect((await aliceTab.post("/api/smtp/test", {})).status).toBe(200);
    expect(stub.emails.map((email) => email.subject)).toEqual(["Test email"]);
    expect((await progressOf()).steps.alerts).toBe("done");
  });

  it("makes Invite Members done once an invite link is made", async () => {
    await finishRequiredSteps();
    expect((await makeInvite(aliceTab)).status).toBe(200);

    expect((await progressOf()).steps["invite members"]).toBe("done");
  });

  it("lists Banks and each extra under Finish setup, for every Member, until each is done", async () => {
    await finishRequiredSteps();
    expect((await skip("banks")).status).toBe(200);
    const bobTab = await signedIn(bob);
    const all = ["banks", "ai", "alerts", "invite members"];
    expect((await progressOf()).finishSetup).toEqual(all);
    expect((await progressOf(bobTab)).finishSetup).toEqual(all);

    await addConnection(test.database, {
      provider: "fake",
      bankId: "ins_fake_1",
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    expect((await progressOf(bobTab)).finishSetup).toEqual(["ai", "alerts", "invite members"]);
    await addAiProvider();
    expect((await progressOf()).finishSetup).toEqual(["alerts", "invite members"]);
    // Bob's test email counts too: the item is the Household's.
    await saveSmtp(bobTab);
    expect((await bobTab.post("/api/smtp/test", {})).status).toBe(200);
    expect((await progressOf()).finishSetup).toEqual(["invite members"]);
    expect((await makeInvite(bobTab)).status).toBe(200);
    expect(await progressOf()).toMatchObject({
      finishSetup: [],
      steps: { banks: "done", ai: "done", alerts: "done", "invite members": "done" },
    });
  });

  it("keeps Banks done when Skip for now is pressed on it", async () => {
    await finishRequiredSteps();
    await addConnection(test.database, {
      provider: "fake",
      bankId: "ins_fake_1",
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });

    const res = await skip("banks");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { progress: SetupProgressView }).progress.steps.banks).toBe(
      "done",
    );
    expect((await progressOf()).finishSetup).toEqual(["ai", "alerts", "invite members"]);
  });

  it("opens Finish once Banks is done or skipped, and then nothing more", async () => {
    await finishRequiredSteps();
    const early = await finish();
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({
      error: "Link a bank, or skip the Banks step for now, first.",
    });
    expect((await progressOf()).next).toBe("banks");

    expect((await skip("banks")).status).toBe(200);
    expect(await progressOf()).toMatchObject({ next: "finish", connections: 0 });
    const done = await finish();
    expect(done.status).toBe(200);
    expect(((await done.json()) as { progress: SetupProgressView }).progress.next).toBeNull();
    // Banks and the extras still wait in the "Finish setup" list.
    expect(await progressOf()).toMatchObject({
      next: null,
      finishSetup: ["banks", "ai", "alerts", "invite members"],
    });
    expect((await finish()).status).toBe(200);
  });

  it("leads only the first Member through the wizard, even once they are removed", async () => {
    await finishRequiredSteps();
    const bobTab = await signedIn(bob);

    expect((await progressOf(bobTab)).next).toBeNull();
    const refused = await skip("banks", bobTab);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "Only the first Member goes through the first-run wizard.",
    });
    expect((await finish(bobTab)).status).toBe(403);
    expect((await progressOf()).steps.banks).toBeNull();

    expect(await removeMember(test.database, alice.id, new Date())).toBe("removed");
    expect((await progressOf(bobTab)).next).toBeNull();
    expect((await skip("banks", bobTab)).status).toBe(403);
    expect(await steps()).toEqual([
      { step: "household facts", status: "done" },
      { step: "master key", status: "done" },
    ]);
  });

  it("answers 404 to a step that has no Skip for now, the optional extras included", async () => {
    await finishRequiredSteps();
    for (const step of [
      "master key",
      "household facts",
      "finish",
      "ai",
      "alerts",
      "invite members",
      "Banks",
      "nope",
    ]) {
      expect((await skip(step)).status).toBe(404);
    }
    expect((await progressOf()).next).toBe("banks");
    expect(await steps()).toEqual([
      { step: "household facts", status: "done" },
      { step: "master key", status: "done" },
    ]);
  });

  it("refuses Skip for now and Finish without a session, from another site, and without JSON", async () => {
    await finishRequiredSteps();
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.250");
    for (const send of [() => skip("banks", signedOut), () => finish(signedOut)]) {
      expect((await send()).status).toBe(401);
    }
    expect((await signedOut.get("/api/setup/progress")).status).toBe(401);

    for (const origin of WRONG_ORIGINS) {
      expect((await skip("banks", aliceTab, { origin })).status).toBe(403);
      expect((await finish(aliceTab, { origin })).status).toBe(403);
    }
    for (const type of ["text/plain", "application/x-www-form-urlencoded", undefined]) {
      expect((await skip("banks", aliceTab, { "content-type": type })).status).toBe(415);
      expect((await finish(aliceTab, { "content-type": type })).status).toBe(415);
    }
    const withBody = await aliceTab.send("POST", "/api/setup/steps/banks/skip", { step: "ai" });
    expect(withBody.status).toBe(400);

    expect(await steps()).toEqual([
      { step: "household facts", status: "done" },
      { step: "master key", status: "done" },
    ]);
    expect((await progressOf()).next).toBe("banks");
  });
});
