import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "../server/app.ts";
import type { NoticeView } from "../server/notice-views.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { type App, TestBrowser } from "../server/testing.ts";
import { endCondition, raiseNotice, startNotify } from "./index.ts";

// System notices: raised through the notify module, and read and closed by Members through the
// app's HTTP interface (spec 06, System notices; spec 07, Header and status lines).

const APP_URL = "http://nas.local:8080";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-notices-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("System notices", () => {
  let test: TestAuth;
  let app: App;
  let stopNotify: () => void;
  let alice: TestBrowser;
  let bob: TestBrowser;

  const query = async (sql: string) => (await test.database.$client.execute(sql)).rows;

  const openNotices = async (tab: TestBrowser) => {
    const res = await tab.get("/api/notices");
    expect(res.status).toBe(200);
    return ((await res.json()) as { notices: NoticeView[] }).notices;
  };

  const signedIn = async (member: TestMember, client: string) => {
    const tab = new TestBrowser(app, APP_URL, client);
    await tab.signIn(member);
    return tab;
  };

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
    stopNotify = startNotify({ database: test.database }).stop;
    await markSetupStep(test.database, "master key", "done");
    const members = [
      await addMember(test.auth, { name: "Alice", email: "alice@example.com" }),
      await addMember(test.auth, { name: "Bob", email: "bob@example.com" }),
    ] as const;
    alice = await signedIn(members[0], "192.168.1.10");
    bob = await signedIn(members[1], "192.168.1.11");
  });

  afterEach(() => {
    stopNotify();
    test.close();
  });

  it("lists an event notice for every Member, with a close button", async () => {
    const id = await raiseNotice({ kind: "event", text: "Your history is ready" });

    const expected = [
      expect.objectContaining({ id, text: "Your history is ready", closable: true }),
    ];
    expect(await openNotices(alice)).toEqual(expected);
    expect(await openNotices(bob)).toEqual(expected);
  });

  it("closes an event notice for every Member when one Member closes it", async () => {
    const id = await raiseNotice({ kind: "event", text: "Your history is ready" });

    const res = await alice.post(`/api/notices/${id}/close`);

    expect(res.status).toBe(200);
    expect(await openNotices(alice)).toEqual([]);
    expect(await openNotices(bob)).toEqual([]);
    expect((await bob.post(`/api/notices/${id}/close`)).status).toBe(404);
  });

  it("keeps a condition notice, with no close button, until endCondition runs", async () => {
    const id = await raiseNotice({
      kind: "condition",
      text: "First Fake Bank needs you to sign in again",
      condition: "connection needs a member:c1",
    });
    expect(await openNotices(bob)).toEqual([expect.objectContaining({ id, closable: false })]);

    expect((await alice.post(`/api/notices/${id}/close`)).status).toBe(409);
    expect(await openNotices(bob)).toHaveLength(1);

    await endCondition("connection needs a member:c1");
    expect(await openNotices(bob)).toEqual([]);
  });

  it("keeps one notice for a condition raised twice, and a new one after it ends", async () => {
    const condition = {
      kind: "condition",
      text: "Backups are failing",
      condition: "backup",
    } as const;

    const first = await raiseNotice(condition);
    const again = await Promise.all([raiseNotice(condition), raiseNotice(condition)]);

    expect(again).toEqual([first, first]);
    expect(await openNotices(alice)).toHaveLength(1);
    expect(await query("SELECT notice_id FROM notice_deliveries")).toEqual([
      expect.objectContaining({ notice_id: first }),
    ]);

    await endCondition("backup");
    const later = await raiseNotice(condition);
    expect(later).not.toBe(first);
    expect(await openNotices(alice)).toEqual([expect.objectContaining({ id: later })]);
  });

  it("ends only the named condition, and does nothing for one with no open notice", async () => {
    await raiseNotice({ kind: "condition", text: "Bank A is broken", condition: "broken:a" });
    await raiseNotice({ kind: "condition", text: "Bank B is broken", condition: "broken:b" });

    await endCondition("broken:a");
    await endCondition("broken:nothing");

    expect((await openNotices(alice)).map((notice) => notice.text)).toEqual(["Bank B is broken"]);
  });

  it("makes one delivery record for each new notice, for the email and push Delivery jobs", async () => {
    const event = await raiseNotice({ kind: "event", text: "Your history is ready" });
    const condition = await raiseNotice({
      kind: "condition",
      text: "AI is paused",
      condition: "ai",
    });

    expect(await query("SELECT notice_id FROM notice_deliveries ORDER BY id")).toEqual([
      expect.objectContaining({ notice_id: event }),
      expect.objectContaining({ notice_id: condition }),
    ]);
  });

  it("lists open notices newest first", async () => {
    await raiseNotice({ kind: "event", text: "First" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await raiseNotice({ kind: "event", text: "Second" });

    expect((await openNotices(alice)).map((notice) => notice.text)).toEqual(["Second", "First"]);
  });

  it("refuses a notice with no text", async () => {
    await expect(raiseNotice({ kind: "event", text: "  " })).rejects.toThrow("needs its text");
    expect(await openNotices(alice)).toEqual([]);
  });

  it("needs a session to list or close notices", async () => {
    const id = await raiseNotice({ kind: "event", text: "Your history is ready" });
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.12");

    expect((await signedOut.get("/api/notices")).status).toBe(401);
    expect((await signedOut.post(`/api/notices/${id}/close`)).status).toBe(401);
    expect(await openNotices(alice)).toHaveLength(1);
  });
});
