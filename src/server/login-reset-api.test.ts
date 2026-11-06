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
import { markSetupStep, removeMember } from "../db/index.ts";
import { readEveryTable } from "../db/testing.ts";
import { createLogger } from "../log.ts";
import { linkTokenHash } from "../secrets/index.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// Login reset (spec 09, Login reset), through the app's HTTP interface: "Reset login" in Settings,
// Members, and the reset page's routes. Each test gets a new app.db and Master key, and every
// password, TOTP secret, and token is made when the test runs.

const APP_URL = "http://nas.local:8080";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TOTP_STEP_MS = 30_000;
const LINK = /^http:\/\/nas\.local:8080\/reset#token=[A-Za-z0-9_-]{43}$/;

const WRONG_ORIGINS = [
  "http://nas.local:9090",
  "http://evil.example",
  `${APP_URL}.evil.example`,
  "",
  undefined,
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-reset-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Login reset", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let aliceTab: TestBrowser;
  let bobTab: TestBrowser;
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
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(test.database, "master key", "done");
    aliceTab = await signedIn(alice);
    bobTab = await signedIn(bob);
  });

  afterEach(() => {
    test.close();
    vi.useRealTimers();
  });

  // A third Member, who resets Alice's login while Alice resets Bob's.
  async function carolSignedIn(): Promise<{ carol: TestMember; carolTab: TestBrowser }> {
    const carol = await addMember(test.auth, { name: "Carol", email: "carol@example.com" });
    return { carol, carolTab: await signedIn(carol) };
  }

  // The exact request Settings, Members sends.
  const resetLogin = (
    id: string,
    code: string,
    tab = aliceTab,
    headers: Record<string, string | undefined> = {},
  ) => tab.send("POST", `/api/members/${id}/reset-login`, { code }, headers);

  async function newReset(
    id = bob.id,
    tab = aliceTab,
    member = alice,
  ): Promise<{ link: string; token: string; expiresAt: string }> {
    later(TOTP_STEP_MS);
    const res = await resetLogin(id, await member.totpCode(), tab);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { reset } = (await res.json()) as { reset: { link: string; expiresAt: string } };
    const token = new URLSearchParams(new URL(reset.link).hash.slice(1)).get("token") ?? "";
    return { ...reset, token };
  }

  // The reset page's requests, in order: the link's check, then a new TOTP secret, then the login.
  async function openLink(
    token: string,
    tab = browser(),
  ): Promise<{ res: Response; tab: TestBrowser; member: TestMember }> {
    const password = newPassword();
    const member: TestMember = { ...bob, password, backupCodes: [], totpSecret: "" };
    const check = await tab.post("/api/auth/login-reset/check", { token });
    if (check.status !== 200) return { res: check, tab, member };
    const totp = await tab.post("/api/auth/login-reset/new-totp", { token });
    if (totp.status !== 200) return { res: totp, tab, member };
    const { totpURI } = (await totp.json()) as { totpURI: string };
    const res = await tab.post("/api/auth/login-reset/finish", {
      token,
      password,
      totpCode: await totpCodeFromURI(totpURI),
    });
    if (res.status === 200) {
      member.backupCodes = ((await res.clone().json()) as { backupCodes: string[] }).backupCodes;
      member.totpCode = () => totpCodeFromURI(totpURI);
    }
    return { res, tab, member };
  }

  // Signs in with the password, then a backup code in place of a TOTP code.
  async function signInWithBackupCode(member: TestMember, code: string): Promise<number> {
    const tab = browser();
    const password = await tab.post("/api/auth/sign-in/email", {
      email: member.email,
      password: member.password,
    });
    if (password.status !== 200) return password.status;
    return (await tab.post("/api/auth/two-factor/verify-backup-code", { code })).status;
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
      login_resets: tables.login_resets,
      verifications: tables.verifications,
      sessions: (tables.sessions as { id: string }[]).map((session) => session.id),
    };
  }

  describe("Reset login in Settings, Members", () => {
    it("makes a one-use link under APP_URL with the token after #, for 24 hours, and keeps only its hash", async () => {
      const made = await newReset();

      expect(made.link).toMatch(LINK);
      expect(made.expiresAt).toBe(new Date(Date.now() + 24 * HOUR_MS).toISOString());
      const stored = JSON.stringify(await readEveryTable(test.database));
      expect(stored).not.toContain(made.token);
      expect(stored).toContain(linkTokenHash(made.token));
    });

    it("ends the Member's sessions at once, and their old password, TOTP and backup code are refused right after", async () => {
      const otherBobTab = await signedIn(bob);
      const [backupCode = ""] = bob.backupCodes;
      // Two sign-ins that passed the password step before the reset, and wait for a code.
      const waitingForTotp = browser();
      const waitingForBackupCode = browser();
      for (const tab of [waitingForTotp, waitingForBackupCode]) {
        const res = await tab.post("/api/auth/sign-in/email", {
          email: bob.email,
          password: bob.password,
        });
        expect(res.status).toBe(200);
      }

      await newReset();

      expect(await bobTab.isSignedIn()).toBe(false);
      expect(await otherBobTab.isSignedIn()).toBe(false);
      await expect(browser().signIn(bob)).rejects.toThrow("The password step answered 401");
      expect(await signInWithBackupCode(bob, backupCode)).toBe(401);
      later(TOTP_STEP_MS);
      const totp = await waitingForTotp.post("/api/auth/two-factor/verify-totp", {
        code: await bob.totpCode(),
      });
      expect(totp.status).not.toBe(200);
      const backup = await waitingForBackupCode.post("/api/auth/two-factor/verify-backup-code", {
        code: backupCode,
      });
      expect(backup.status).not.toBe(200);
      expect(await waitingForTotp.isSignedIn()).toBe(false);
      expect(await waitingForBackupCode.isSignedIn()).toBe(false);
      const bobsRows = (rows: unknown[] | undefined) =>
        (rows as { member_id: string }[]).filter((row) => row.member_id === bob.id);
      const tables = await readEveryTable(test.database);
      expect(bobsRows(tables.accounts)).toEqual([]);
      expect(bobsRows(tables.two_factors)).toEqual([]);
      expect(bobsRows(tables.sessions)).toEqual([]);
      expect(await aliceTab.isSignedIn()).toBe(true);
    });

    it("runs the credential-removal hook", async () => {
      const removeLogin = vi.spyOn(test.auth, "removeLogin");

      await newReset();

      expect(removeLogin).toHaveBeenCalledExactlyOnceWith(bob.id);
    });

    it("refuses the Member's own login before checking the code, and changes nothing", async () => {
      const before = await lasting();
      const code = await alice.totpCode();

      const res = await resetLogin(alice.id, code);

      expect(res.status).toBe(409);
      expect(await lasting()).toEqual(before);
      // The code was not used up.
      expect((await resetLogin(bob.id, code)).status).toBe(200);
    });

    it("refuses a wrong code and too many tries, and resets no one", async () => {
      const before = await lasting();
      const wrong = (await alice.totpCode()).replace(/\d/g, (d) => String((Number(d) + 1) % 10));

      const answers = [];
      for (let i = 0; i < 6; i++) answers.push((await resetLogin(bob.id, wrong)).status);

      expect(answers).toEqual([401, 401, 401, 401, 401, 429]);
      expect(await lasting()).toEqual(before);
      expect(await bobTab.isSignedIn()).toBe(true);
    });

    it("refuses an ID no Member has, and changes nothing", async () => {
      const before = await lasting();

      for (const id of [`${bob.id}x`, bob.email, "reset-1"]) {
        later(TOTP_STEP_MS);
        expect((await resetLogin(id, await alice.totpCode())).status, id).toBe(404);
      }

      expect(await lasting()).toEqual(before);
    });

    it("answers 401 with no session, 403 from another origin or none, 415 to a body that is not JSON, and 400 to a bad body, and resets no one", async () => {
      const stranger = browser();
      const before = await lasting();

      expect((await resetLogin(bob.id, await alice.totpCode(), stranger)).status).toBe(401);
      for (const origin of WRONG_ORIGINS) {
        const res = await resetLogin(bob.id, await alice.totpCode(), aliceTab, { origin });
        expect(res.status, `${origin}`).toBe(403);
      }
      for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
        const res = await resetLogin(bob.id, await alice.totpCode(), aliceTab, {
          "content-type": type,
        });
        expect(res.status).toBe(415);
      }
      for (const body of [{}, { code: "" }, [], null, "123456"]) {
        const res = await aliceTab.send("POST", `/api/members/${bob.id}/reset-login`, body);
        expect(res.status).toBe(400);
      }

      expect(await lasting()).toEqual(before);
      expect(await bobTab.isSignedIn()).toBe(true);
    });
  });

  describe("the reset link", () => {
    it("sets a new password and new TOTP, gives 10 new backup codes, and signs the Member in", async () => {
      const { token } = await newReset();

      const { res, tab, member } = await openLink(token);

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(member.backupCodes).toHaveLength(10);
      expect(new Set(member.backupCodes).size).toBe(10);
      for (const code of member.backupCodes) expect(bob.backupCodes).not.toContain(code);
      expect(await tab.isSignedIn()).toBe(true);
      later(TOTP_STEP_MS);
      await browser().signIn(member);
      expect(await signInWithBackupCode(member, member.backupCodes[0] ?? "")).toBe(200);
      later(TOTP_STEP_MS);
      await expect(browser().signIn(bob)).rejects.toThrow("The password step answered 401");
      expect((await readEveryTable(test.database)).login_resets).toEqual([]);
    });

    it("names the login it resets", async () => {
      const { token } = await newReset();

      const res = await browser().post("/api/auth/login-reset/check", { token });

      expect(await res.json()).toEqual({ email: "bob@example.com" });
    });

    it("works once: a link used twice sets one login", async () => {
      const { token } = await newReset();
      expect((await openLink(token)).res.status).toBe(200);
      const before = await lasting();

      const again = await openLink(token);

      expect(again.res.status).toBe(403);
      expect(await lasting()).toEqual(before);
    });

    it("of two finishes at once with one link, sets one login", async () => {
      const { token } = await newReset();
      const tab = browser();
      const totp = await tab.post("/api/auth/login-reset/new-totp", { token });
      const { totpURI } = (await totp.json()) as { totpURI: string };
      const code = await totpCodeFromURI(totpURI);

      const answers = await Promise.all(
        [newPassword(), newPassword()].map((password) =>
          tab.post("/api/auth/login-reset/finish", { token, password, totpCode: code }),
        ),
      );

      expect(answers.map((res) => res.status).sort()).toEqual([200, 403]);
      const tables = await readEveryTable(test.database);
      expect(tables.accounts).toHaveLength(2);
      expect(tables.two_factors).toHaveLength(2);
    });

    it("works for 24 hours, and at hour 25 is refused", async () => {
      const { carol, carolTab } = await carolSignedIn();
      const kept = await newReset();
      const expired = await newReset(alice.id, carolTab, carol);

      later(23 * HOUR_MS);
      expect((await openLink(kept.token)).res.status).toBe(200);
      later(2 * HOUR_MS);
      const before = await lasting();
      const res = await browser().post("/api/auth/login-reset/check", { token: expired.token });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("RESET_NOT_OPEN");
      expect(await lasting()).toEqual(before);
    });

    it("stops working once a new reset replaces it", async () => {
      const first = await newReset();
      const second = await newReset();

      expect((await openLink(first.token)).res.status).toBe(403);
      expect((await openLink(second.token)).res.status).toBe(200);
    });

    it("stops working once its Member is removed", async () => {
      const { token } = await newReset();

      expect(await removeMember(test.database, bob.id, new Date())).toBe("removed");

      expect((await openLink(token)).res.status).toBe(403);
      expect((await readEveryTable(test.database)).login_resets).toEqual([]);
    });

    it("refuses a wrong TOTP code, a short password, and a wrong token, each changing nothing and leaving the link open", async () => {
      const { token } = await newReset();
      const tab = browser();
      const started = await tab.post("/api/auth/login-reset/new-totp", { token });
      const { totpURI } = (await started.json()) as { totpURI: string };
      const right = await totpCodeFromURI(totpURI);
      const wrong = right.replace(/\d/g, (digit) => String((Number(digit) + 1) % 10));
      const login = { token, password: newPassword() };
      const before = await lasting();

      const answers = [
        await tab.post("/api/auth/login-reset/finish", { ...login, totpCode: wrong }),
        await tab.post("/api/auth/login-reset/finish", {
          ...login,
          password: "short",
          totpCode: right,
        }),
        await tab.post("/api/auth/login-reset/finish", {
          ...login,
          token: `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`,
          totpCode: right,
        }),
      ];

      expect(answers.map((res) => res.status)).toEqual([401, 400, 403]);
      expect(await lasting()).toEqual(before);
      expect(await tab.isSignedIn()).toBe(false);
      expect(
        (await tab.post("/api/auth/login-reset/finish", { ...login, totpCode: right })).status,
      ).toBe(200);
    });

    it("allows 5 wrong tokens per 15 minutes per IP address, then refuses every token unchecked", async () => {
      const { token } = await newReset();
      const stranger = browser();
      for (let i = 0; i < 5; i++) {
        const res = await stranger.post("/api/auth/login-reset/check", { token: `wrong-${i}` });
        expect(res.status).toBe(403);
      }

      expect((await stranger.post("/api/auth/login-reset/check", { token })).status).toBe(429);
      expect((await openLink(token, stranger)).res.status).toBe(429);
      expect((await browser().post("/api/auth/login-reset/check", { token })).status).toBe(200);

      later(15 * MINUTE_MS + 1);
      expect((await stranger.post("/api/auth/login-reset/check", { token })).status).toBe(200);
    });

    it("answers the reset routes only from the app's own pages and only with JSON, changing nothing", async () => {
      const { token } = await newReset();
      const tab = browser();
      const routes: [string, unknown][] = [
        ["/api/auth/login-reset/check", { token }],
        ["/api/auth/login-reset/new-totp", { token }],
        ["/api/auth/login-reset/finish", { token, password: newPassword(), totpCode: "1" }],
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
      expect((await openLink(token, tab)).res.status).toBe(200);
    });

    it("never writes a token to the log", async () => {
      const { carol, carolTab } = await carolSignedIn();
      const used = await newReset();
      const replaced = await newReset(alice.id, carolTab, carol);
      const expired = await newReset(alice.id, carolTab, carol);
      await openLink(used.token);
      await openLink(used.token);
      await openLink(replaced.token);
      later(25 * HOUR_MS);
      await openLink(expired.token);
      await browser().post("/api/auth/login-reset/finish", { token: used.token });

      const logged = lines.join("\n");
      for (const { token } of [used, replaced, expired]) expect(logged).not.toContain(token);
    });
  });
});
