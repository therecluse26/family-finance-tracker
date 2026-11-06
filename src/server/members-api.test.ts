import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMember,
  newPassword,
  newTestAuth,
  type TestAuth,
  type TestMember,
  totpCodeFromURI,
} from "../auth/testing.ts";
import {
  addGoal,
  listChatMessages,
  listMembers,
  markSetupStep,
  storeChatThread,
  storePushDevice,
} from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { linkTokenHash } from "../secrets/index.ts";
import { createApp } from "./app.ts";
import type { InviteView, MemberView } from "./members-views.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Settings, Members (spec 09, Members; Invites), through the app's HTTP interface: invite links,
// joining by one, Cancel, and removing a Member. Each test gets a new app.db and Master key, and
// every password, TOTP secret, and token is made when the test runs.

const APP_URL = "http://nas.local:8080";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const TOTP_STEP_MS = 30_000;
const LINK = /^http:\/\/nas\.local:8080\/join#token=[A-Za-z0-9_-]{43}$/;

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

const NOT_OPEN = "INVITE_NOT_OPEN";

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-members-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Settings, Members", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let alice: TestMember;
  let aliceTab: TestBrowser;
  let clients = 0;

  const later = (ms: number) => vi.setSystemTime(Date.now() + ms);
  const browser = () => {
    clients += 1;
    return new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
  };

  // Each TOTP code works once, so each sign-in and each fresh code takes its own step.
  async function signedIn(member: TestMember): Promise<TestBrowser> {
    later(TOTP_STEP_MS);
    const tab = browser();
    await tab.signIn(member);
    later(TOTP_STEP_MS);
    return tab;
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    lines = [];
    const logger = createLogger((line) => lines.push(line), { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, logger);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger }),
      test.auth,
      test.database,
      test.secrets,
    );
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
    aliceTab = await signedIn(alice);
  });

  afterEach(() => {
    test.close();
    vi.useRealTimers();
  });

  // The exact requests the page sends: each with a JSON body, even an empty one.
  const makeInvite = (tab = aliceTab, headers: Record<string, string | undefined> = {}) =>
    tab.send("POST", "/api/invites", {}, headers);
  const cancel = (id: string, tab = aliceTab, headers: Record<string, string | undefined> = {}) =>
    tab.send("POST", `/api/invites/${id}/cancel`, {}, headers);
  const remove = (
    id: string,
    code: string,
    tab = aliceTab,
    headers: Record<string, string | undefined> = {},
  ) => tab.send("POST", `/api/members/${id}/remove`, { code }, headers);

  async function newLink(
    tab = aliceTab,
  ): Promise<{ link: string; token: string; expiresAt: string }> {
    const res = await makeInvite(tab);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { invite } = (await res.json()) as { invite: { link: string; expiresAt: string } };
    const token = new URLSearchParams(new URL(invite.link).hash.slice(1)).get("token") ?? "";
    return { ...invite, token };
  }

  async function settings(
    tab = aliceTab,
  ): Promise<{ members: MemberView[]; invites: InviteView[] }> {
    const res = await tab.get("/api/members");
    expect(res.status).toBe(200);
    return (await res.json()) as { members: MemberView[]; invites: InviteView[] };
  }

  // The join page's requests, in order: the link's check, then a new TOTP secret, then the login.
  async function join(
    token: string,
    login: { name: string; email: string } = { name: "Bob", email: "bob@example.com" },
    tab = browser(),
  ): Promise<{ res: Response; tab: TestBrowser; password: string }> {
    const password = newPassword();
    const totp = await tab.post("/api/auth/invite/new-totp", { token, email: login.email });
    if (totp.status !== 200) return { res: totp, tab, password };
    const { totpURI } = (await totp.json()) as { totpURI: string };
    const res = await tab.post("/api/auth/invite/accept", {
      token,
      name: login.name,
      email: login.email,
      password,
      totpCode: await totpCodeFromURI(totpURI),
    });
    return { res, tab, password };
  }

  // The rows a refused request must leave as they were. Sessions renew on each use, so they are
  // compared by ID, and a fresh code claims its TOTP step.
  async function lasting() {
    const tables = await readEveryTable(test.database);
    return {
      members: tables.members,
      accounts: tables.accounts,
      two_factors: (tables.two_factors as { last_totp_step?: unknown }[]).map(
        ({ last_totp_step: _, ...row }) => row,
      ),
      invites: tables.invites,
      verifications: tables.verifications,
      push_devices: tables.push_devices,
      goals: tables.goals,
      sessions: (tables.sessions as { id: string }[]).map((session) => session.id),
    };
  }

  const codeOf = async (res: Response) => ((await res.json()) as { code?: string }).code;

  describe("invite links", () => {
    it("makes a link under APP_URL with the token after #, keeps only its hash, and lists it open", async () => {
      const made = await newLink();

      expect(made.link).toMatch(LINK);
      expect(made.expiresAt).toBe(
        new Date(NOW.getTime() + 2 * TOTP_STEP_MS + 7 * DAY_MS).toISOString(),
      );
      expect((await settings()).invites).toEqual([
        {
          id: expect.any(String),
          madeBy: "Alice",
          createdAt: new Date(NOW.getTime() + 2 * TOTP_STEP_MS).toISOString(),
          expiresAt: made.expiresAt,
        },
      ]);
      const stored = JSON.stringify(await readEveryTable(test.database));
      expect(stored).not.toContain(made.token);
      expect(stored).toContain(linkTokenHash(made.token));
    });

    it("makes a different token each time", async () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 5; i++) tokens.add((await newLink()).token);

      expect(tokens.size).toBe(5);
      expect((await settings()).invites).toHaveLength(5);
    });

    it("lets a new Member make their own login: name, email, password, TOTP, and 10 backup codes, with no wizard", async () => {
      const { token } = await newLink();
      const page = browser();

      expect((await page.post("/api/auth/invite/check", { token })).status).toBe(200);
      const { res, tab, password } = await join(
        token,
        { name: "Bob", email: "Bob@Example.com" },
        page,
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const { backupCodes } = (await res.json()) as { backupCodes: string[] };
      expect(backupCodes).toHaveLength(10);
      expect(await tab.isSignedIn()).toBe(true);
      expect(await (await tab.get("/api/setup")).json()).toEqual({ next: null, wizard: false });
      expect((await settings(tab)).members).toEqual([
        expect.objectContaining({ name: "Alice", email: "alice@example.com", you: false }),
        expect.objectContaining({ name: "Bob", email: "bob@example.com", you: true }),
      ]);
      expect((await settings()).invites).toEqual([]);

      // The new login works: the password plus a later TOTP code, or a backup code.
      later(TOTP_STEP_MS);
      const again = browser();
      const signIn = await again.post("/api/auth/sign-in/email", {
        email: "bob@example.com",
        password,
      });
      expect(signIn.status).toBe(200);
      const backup = await again.post("/api/auth/two-factor/verify-backup-code", {
        code: backupCodes[0],
      });
      expect(backup.status).toBe(200);
      expect(await again.isSignedIn()).toBe(true);
    });

    it("works once: a link used twice makes one Member", async () => {
      const { token } = await newLink();
      expect((await join(token)).res.status).toBe(200);
      const before = await lasting();

      const second = await join(token, { name: "Carol", email: "carol@example.com" });

      expect(second.res.status).toBe(403);
      expect(await codeOf(second.res)).toBe(NOT_OPEN);
      expect(await second.tab.isSignedIn()).toBe(false);
      expect(await lasting()).toEqual(before);
      expect((await listMembers(test.database)).map((member) => member.name)).toEqual([
        "Alice",
        "Bob",
      ]);
    });

    it("of two joins at once with one link, makes one Member", async () => {
      const { token } = await newLink();
      const tab = browser();
      const totp = await tab.post("/api/auth/invite/new-totp", { token, email: "bob@example.com" });
      const { totpURI } = (await totp.json()) as { totpURI: string };
      const totpCode = await totpCodeFromURI(totpURI);
      const body = (email: string) => ({
        token,
        name: "Bob",
        email,
        password: newPassword(),
        totpCode,
      });

      const answers = await Promise.all([
        browser().post("/api/auth/invite/accept", body("bob@example.com")),
        browser().post("/api/auth/invite/accept", body("bob2@example.com")),
      ]);

      expect(answers.map((res) => res.status).sort()).toEqual([200, 403]);
      expect(await listMembers(test.database)).toHaveLength(2);
    });

    it("works for 7 days, and on day 8 is refused and no longer listed", async () => {
      const { token } = await newLink();
      later(7 * DAY_MS - MINUTE_MS);
      expect((await browser().post("/api/auth/invite/check", { token })).status).toBe(200);
      expect((await settings()).invites).toHaveLength(1);

      later(DAY_MS);
      const before = await lasting();
      const { res } = await join(token);

      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe(NOT_OPEN);
      expect(await lasting()).toEqual(before);
      expect((await settings()).invites).toEqual([]);
    });

    it("stops working once cancelled, and leaves the other links open", async () => {
      const first = await newLink();
      later(MINUTE_MS);
      const second = await newLink();
      const [listed] = (await settings()).invites;

      const res = await cancel(listed?.id ?? "");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ cancelled: true });
      expect((await settings()).invites).toHaveLength(1);
      const before = await lasting();
      const { res: refused } = await join(first.token);
      expect(refused.status).toBe(403);
      expect(await lasting()).toEqual(before);
      expect((await join(second.token)).res.status).toBe(200);
    });

    it("refuses Cancel through an ID no open link has, and changes nothing", async () => {
      await newLink();
      const used = await newLink();
      await join(used.token);
      const [open] = (await settings()).invites;
      const before = await lasting();

      for (const id of ["nothing", alice.id, used.token, `${open?.id}x`]) {
        expect((await cancel(id)).status, id).toBe(404);
      }

      expect(await lasting()).toEqual(before);
      // Cancelled once, a link cannot be cancelled again.
      expect((await cancel(open?.id ?? "")).status).toBe(200);
      expect((await cancel(open?.id ?? "")).status).toBe(404);
    });

    it("refuses an email address another Member has, in any letter case, and leaves the link open", async () => {
      const { token } = await newLink();
      const before = await lasting();

      const totp = await browser().post("/api/auth/invite/new-totp", {
        token,
        email: "ALICE@example.com",
      });
      expect(totp.status).toBe(400);
      expect(await codeOf(totp)).toBe("EMAIL_IN_USE");
      expect(await lasting()).toEqual(before);

      // A page that sends another address at the end is refused too.
      const tab = browser();
      const started = await tab.post("/api/auth/invite/new-totp", {
        token,
        email: "new@example.com",
      });
      const { totpURI } = (await started.json()) as { totpURI: string };
      const before2 = await lasting();
      const accept = await tab.post("/api/auth/invite/accept", {
        token,
        name: "Mallory",
        email: "Alice@Example.com",
        password: newPassword(),
        totpCode: await totpCodeFromURI(totpURI),
      });
      expect(accept.status).toBe(400);
      expect(await codeOf(accept)).toBe("EMAIL_IN_USE");
      expect(await lasting()).toEqual(before2);
      expect((await settings()).invites).toHaveLength(1);
    });

    it("refuses a wrong TOTP code, a short password, and a wrong token, each changing nothing", async () => {
      const { token } = await newLink();
      const tab = browser();
      const started = await tab.post("/api/auth/invite/new-totp", {
        token,
        email: "bob@example.com",
      });
      const { totpURI } = (await started.json()) as { totpURI: string };
      const right = await totpCodeFromURI(totpURI);
      const wrong = right.replace(/\d/g, (digit) => String((Number(digit) + 1) % 10));
      const login = { token, name: "Bob", email: "bob@example.com", password: newPassword() };
      const before = await lasting();

      const answers = [
        await tab.post("/api/auth/invite/accept", { ...login, totpCode: wrong }),
        await tab.post("/api/auth/invite/accept", { ...login, password: "short", totpCode: right }),
        await tab.post("/api/auth/invite/accept", {
          ...login,
          token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
          totpCode: right,
        }),
      ];

      expect(answers.map((res) => res.status)).toEqual([401, 400, 403]);
      expect(await lasting()).toEqual(before);
      expect(await tab.isSignedIn()).toBe(false);
      expect(
        (await tab.post("/api/auth/invite/accept", { ...login, totpCode: right })).status,
      ).toBe(200);
    });

    it("allows 5 wrong tokens per 15 minutes per IP address, then refuses every token unchecked", async () => {
      const { token } = await newLink();
      const stranger = browser();
      for (let i = 0; i < 5; i++) {
        const res = await stranger.post("/api/auth/invite/check", { token: `wrong-${i}` });
        expect(res.status).toBe(403);
      }

      const refused = await stranger.post("/api/auth/invite/check", { token });
      expect(refused.status).toBe(429);
      expect((await join(token, undefined, stranger)).res.status).toBe(429);
      expect((await browser().post("/api/auth/invite/check", { token })).status).toBe(200);

      later(15 * MINUTE_MS + 1);
      expect((await stranger.post("/api/auth/invite/check", { token })).status).toBe(200);
    });

    it("answers the join routes only from the app's own pages and only with JSON, changing nothing", async () => {
      const { token } = await newLink();
      const tab = browser();
      const routes: [string, unknown][] = [
        ["/api/auth/invite/check", { token }],
        ["/api/auth/invite/new-totp", { token, email: "bob@example.com" }],
        [
          "/api/auth/invite/accept",
          { token, name: "Bob", email: "bob@example.com", password: newPassword(), totpCode: "1" },
        ],
      ];
      const before = await lasting();

      for (const [path, body] of routes) {
        for (const origin of WRONG_ORIGINS) {
          expect((await tab.send("POST", path, body, { origin })).status, `${path} ${origin}`).toBe(
            403,
          );
        }
        for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
          expect(
            (await tab.send("POST", path, body, { "content-type": type })).status,
            `${path} ${type}`,
          ).toBe(415);
        }
      }

      expect(await lasting()).toEqual(before);
      expect((await settings()).invites).toHaveLength(1);
    });

    it("refuses to make a link until the first-run wizard's required steps are done", async () => {
      const fresh = await newTestAuth(APP_URL);
      try {
        const early = createApp(
          webRoot,
          await loadSecurity({ APP_URL }, {}),
          fresh.auth,
          fresh.database,
          fresh.secrets,
        );
        const first = await addMember(fresh.auth, { name: "Alice", email: "alice@example.com" });
        await markSetupStep(fresh.database, "master key", "done");
        const tab = new TestBrowser(early, APP_URL, "192.168.2.1");
        later(TOTP_STEP_MS);
        await tab.signIn(first);

        const res = await tab.post("/api/invites", {});

        expect(res.status).toBe(409);
        expect((await readEveryTable(fresh.database)).invites).toEqual([]);
      } finally {
        fresh.close();
      }
    });

    it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and changes nothing", async () => {
      await newLink();
      const [open] = (await settings()).invites;
      const id = open?.id ?? "";
      const stranger = browser();
      const before = await lasting();

      expect((await stranger.get("/api/members")).status).toBe(401);
      expect((await makeInvite(stranger)).status).toBe(401);
      expect((await cancel(id, stranger)).status).toBe(401);
      for (const origin of WRONG_ORIGINS) {
        expect((await makeInvite(aliceTab, { origin })).status, `${origin}`).toBe(403);
        expect((await cancel(id, aliceTab, { origin })).status, `${origin}`).toBe(403);
      }
      for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
        expect((await makeInvite(aliceTab, { "content-type": type })).status).toBe(415);
        expect((await cancel(id, aliceTab, { "content-type": type })).status).toBe(415);
      }
      for (const body of [{ days: 30 }, [], null, "now"]) {
        expect((await aliceTab.send("POST", "/api/invites", body)).status).toBe(400);
        expect((await aliceTab.send("POST", `/api/invites/${id}/cancel`, body)).status).toBe(400);
      }

      expect(await lasting()).toEqual(before);
    });

    it("never writes a token to the log", async () => {
      const used = await newLink();
      later(MINUTE_MS);
      const cancelled = await newLink();
      later(MINUTE_MS);
      const expired = await newLink();
      await join(used.token);
      await join(used.token, { name: "Carol", email: "carol@example.com" });
      const [, toCancel] = (await settings()).invites;
      await cancel(toCancel?.id ?? "");
      await join(cancelled.token);
      later(8 * DAY_MS);
      await join(expired.token);
      await browser().post("/api/auth/invite/accept", { token: used.token });

      const logged = lines.join("\n");
      for (const { token } of [used, cancelled, expired]) expect(logged).not.toContain(token);
    });
  });

  describe("removing a Member", () => {
    let bob: TestMember;
    let bobTab: TestBrowser;

    beforeEach(async () => {
      bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
      bobTab = await signedIn(bob);
    });

    it("ends their sessions at once, removes their devices from web push, and keeps their name on their Goals and Chat messages", async () => {
      const otherBobTab = await signedIn(bob);
      await storePushDevice(
        test.database,
        bob.id,
        { endpoint: "https://push.example/bob", p256dh: "key", auth: "auth" },
        new Date(),
      );
      await addGoal(test.database, {
        words: "Save for a bike",
        authorId: bob.id,
        date: "2026-11-01",
        target: null,
        change: null,
        deadline: null,
      });
      const { threadId } = await storeChatThread(
        test.database,
        { title: "Bikes", note: null },
        { author: "Member", memberId: bob.id, memberName: "Bob", text: "What did bikes cost?" },
        new Date(),
      );

      const res = await remove(bob.id, await alice.totpCode());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: true, you: false });
      expect(await bobTab.isSignedIn()).toBe(false);
      expect(await otherBobTab.isSignedIn()).toBe(false);
      await expect(browser().signIn(bob)).rejects.toThrow("The password step answered 401");
      const tables = await readEveryTable(test.database);
      expect(tables.push_devices).toEqual([]);
      expect(tables.accounts).toHaveLength(1);
      expect(tables.two_factors).toHaveLength(1);
      expect((await settings()).members.map((member) => member.name)).toEqual(["Alice"]);
      const goals = (await (await aliceTab.get("/api/goals")).json()) as {
        goals: { author: string | null }[];
      };
      expect(goals.goals.map((goal) => goal.author)).toEqual(["Bob"]);
      expect((await listChatMessages(test.database, threadId))[0]?.memberName).toBe("Bob");
      expect(await aliceTab.isSignedIn()).toBe(true);
    });

    it("calls one credential-removal hook, which alone ends every session and the login", async () => {
      const otherBobTab = await signedIn(bob);

      await test.auth.removeLogin(bob.id);

      expect(await bobTab.isSignedIn()).toBe(false);
      expect(await otherBobTab.isSignedIn()).toBe(false);
      await expect(browser().signIn(bob)).rejects.toThrow("The password step answered 401");
      const tables = await readEveryTable(test.database);
      expect(tables.accounts).toHaveLength(1);
      expect(tables.two_factors).toHaveLength(1);
      expect(tables.members).toHaveLength(2);
      expect(await aliceTab.isSignedIn()).toBe(true);
    });

    it("lets a Member remove themselves, which signs them out", async () => {
      const res = await remove(bob.id, await bob.totpCode(), bobTab);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ removed: true, you: true });
      expect(await bobTab.isSignedIn()).toBe(false);
      expect((await settings()).members.map((member) => member.name)).toEqual(["Alice"]);
    });

    it("cancels the invite links they made, and leaves the other Members' links open", async () => {
      const bobs = await newLink(bobTab);
      later(MINUTE_MS);
      const alices = await newLink();

      expect((await remove(bob.id, await alice.totpCode())).status).toBe(200);

      expect((await settings()).invites.map((invite) => invite.madeBy)).toEqual(["Alice"]);
      expect((await join(bobs.token, { name: "Cy", email: "cy@example.com" })).res.status).toBe(
        403,
      );
      expect((await join(alices.token, { name: "Di", email: "di@example.com" })).res.status).toBe(
        200,
      );
    });

    it("refuses to remove the last Member, themselves included, and changes nothing", async () => {
      expect((await remove(bob.id, await alice.totpCode())).status).toBe(200);
      later(TOTP_STEP_MS);
      const before = await lasting();

      const res = await remove(alice.id, await alice.totpCode());

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "The app cannot remove the last Member." });
      expect(await lasting()).toEqual(before);
      expect(await aliceTab.isSignedIn()).toBe(true);
    });

    it("of two Members who remove each other at once, removes one", async () => {
      const answers = await Promise.all([
        remove(bob.id, await alice.totpCode(), aliceTab),
        remove(alice.id, await bob.totpCode(), bobTab),
      ]);

      expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
      expect(await listMembers(test.database)).toHaveLength(1);
    });

    it("refuses a wrong code and too many tries, and removes no one", async () => {
      const before = await lasting();
      const wrong = (await alice.totpCode()).replace(/\d/g, (d) => String((Number(d) + 1) % 10));

      const answers = [];
      for (let i = 0; i < 6; i++) answers.push((await remove(bob.id, wrong)).status);

      expect(answers).toEqual([401, 401, 401, 401, 401, 429]);
      expect(await lasting()).toEqual(before);
      expect(await bobTab.isSignedIn()).toBe(true);
    });

    it("refuses an ID no Member has, such as an invite's or a Goal's, and changes nothing", async () => {
      await newLink();
      const [invite] = (await settings()).invites;
      const goalId = await addGoal(test.database, {
        words: "Save",
        authorId: bob.id,
        date: "2026-11-01",
        target: null,
        change: null,
        deadline: null,
      });
      const before = await lasting();

      for (const id of [invite?.id ?? "", goalId, `${bob.id}x`, bob.email]) {
        later(TOTP_STEP_MS);
        expect((await remove(id, await alice.totpCode())).status, id).toBe(404);
      }

      expect(await lasting()).toEqual(before);
    });

    it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and removes no one", async () => {
      const stranger = browser();
      const before = await lasting();

      expect((await remove(bob.id, await alice.totpCode(), stranger)).status).toBe(401);
      for (const origin of WRONG_ORIGINS) {
        expect((await remove(bob.id, await alice.totpCode(), aliceTab, { origin })).status).toBe(
          403,
        );
      }
      for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
        const res = await remove(bob.id, await alice.totpCode(), aliceTab, {
          "content-type": type,
        });
        expect(res.status).toBe(415);
      }
      for (const body of [{}, { code: "" }, [], null, "123456"]) {
        expect((await aliceTab.send("POST", `/api/members/${bob.id}/remove`, body)).status).toBe(
          400,
        );
      }

      expect(await lasting()).toEqual(before);
    });
  });
});
