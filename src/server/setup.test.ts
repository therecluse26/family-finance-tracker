import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newPassword, newTestAuth, type TestAuth, totpCodeFromURI } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "./app.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, TestBrowser } from "./testing.ts";

// The first-run wizard's steps 1 and 2 through the app's HTTP interface, as a browser takes them
// (spec 12, The first-run wizard). Each test gets a new app.db and Master key.

const APP_URL = "http://nas.local:8080";
const MINUTE_MS = 60 * 1000;

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-setup-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

// A browser that takes the wizard's steps.
class Browser extends TestBrowser {
  checkCode = (setupCode: string) => this.post("/api/auth/first-member/check-code", { setupCode });

  newTotp = (setupCode: string, email = "alice@example.com") =>
    this.post("/api/auth/first-member/new-totp", { setupCode, email });

  create = (setupCode: string, totpCode: string, email = "Alice@Example.com") =>
    this.post("/api/auth/first-member/create", {
      setupCode,
      name: "Alice",
      email,
      password: newPassword(),
      totpCode,
    });

  async setupState(): Promise<unknown> {
    const res = await this.get("/api/setup");
    expect(res.status).toBe(200);
    return res.json();
  }
}

// A code that is not this one: its last character changed.
const wrongCode = (code: string) => `${code.slice(0, -1)}${code.endsWith("0") ? "1" : "0"}`;

describe("the first-run wizard, steps 1 and 2", () => {
  let test: TestAuth;
  let app: App;
  let lines: string[];
  let code: string;
  let clients = 0;

  const browser = (client?: string) => {
    clients += 1;
    return new Browser(app, APP_URL, client ?? `192.168.1.${clients}`);
  };

  const query = async (sql: string) => (await test.database.$client.execute(sql)).rows;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
    code = test.secrets.setupCode();
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  // Steps 1 and 2: the setup code, a TOTP for the first Member, then the first Member.
  async function makeFirstMember(tab: Browser): Promise<string[]> {
    const started = await tab.newTotp(code);
    expect(started.status).toBe(200);
    const { totpURI } = (await started.json()) as { totpURI: string };
    const made = await tab.create(code, await totpCodeFromURI(totpURI));
    expect(made.status).toBe(200);
    return ((await made.json()) as { backupCodes: string[] }).backupCodes;
  }

  it("opens on the setup link before a Member exists, with no session", async () => {
    const tab = browser();

    expect(await tab.setupState()).toEqual({ next: "setup link", wizard: true });
    expect(await tab.isSignedIn()).toBe(false);
  });

  it("takes the setup code whatever its letter case and dashes", async () => {
    const tab = browser();

    expect((await tab.checkCode(code)).status).toBe(200);
    expect((await tab.checkCode(code.toLowerCase().replace(/-/g, ""))).status).toBe(200);
    const wrong = await tab.checkCode(wrongCode(code));
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual(expect.objectContaining({ code: "WRONG_SETUP_CODE" }));
  });

  it("makes the first Member, signs them in, and gives 10 backup codes", async () => {
    const tab = browser();

    const backupCodes = await makeFirstMember(tab);

    expect(backupCodes).toHaveLength(10);
    expect(await tab.isSignedIn()).toBe(true);
    expect(await query("SELECT name, email, two_factor_enabled FROM members")).toEqual([
      expect.objectContaining({ name: "Alice", email: "alice@example.com", two_factor_enabled: 1 }),
    ]);
    // The wizard goes on to step 3.
    expect(await tab.setupState()).toEqual({ next: "master key", wizard: true });
  });

  it("refuses the setup code on every route once the first Member exists", async () => {
    await makeFirstMember(browser());
    const other = browser();

    for (const res of [
      await other.checkCode(code),
      await other.newTotp(code),
      await other.create(code, "123456"),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(expect.objectContaining({ code: "SETUP_DONE" }));
    }
    expect(await other.isSignedIn()).toBe(false);
    expect(await query("SELECT id FROM members")).toHaveLength(1);
  });

  it("makes exactly one first Member from two requests at once with the right code", async () => {
    const first = browser();
    const second = browser();
    const started = await first.newTotp(code);
    const { totpURI } = (await started.json()) as { totpURI: string };
    const totpCode = await totpCodeFromURI(totpURI);

    const answers = await Promise.all([
      first.create(code, totpCode, "alice@example.com"),
      second.create(code, totpCode, "mallory@example.com"),
    ]);

    expect(answers.map((res) => res.status).sort()).toEqual([200, 403]);
    expect(await query("SELECT id FROM members")).toHaveLength(1);
    expect(await query("SELECT id FROM two_factors")).toHaveLength(1);
    expect(await query("SELECT id FROM sessions")).toHaveLength(1);
  });

  // Each write that makes the first Member fails in turn, through a trigger that aborts it.
  it.each([
    ["the Member", "INSERT ON members"],
    ["the password", "INSERT ON accounts"],
    ["the TOTP, backup codes and used time step", "INSERT ON two_factors"],
    ["using up the waiting TOTP secret", "DELETE ON verifications"],
    ["the session", "INSERT ON sessions"],
  ])(
    "leaves no part of the Member when the write of %s fails, and the same setup code makes them next",
    async (_what, write) => {
      const tab = browser();
      const { totpURI } = (await (await tab.newTotp(code)).json()) as { totpURI: string };
      const madeUp = `made-up-${crypto.randomUUID()}`;
      await query(
        `CREATE TRIGGER fail_first_member BEFORE ${write} BEGIN SELECT RAISE(ABORT, '${madeUp}'); END`,
      );
      const stdout: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation(
        (chunk) => stdout.push(String(chunk)) > 0,
      );

      let failed: Response;
      try {
        failed = await tab.create(code, await totpCodeFromURI(totpURI));
      } finally {
        vi.mocked(process.stdout.write).mockRestore();
      }

      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual(
        expect.objectContaining({ code: "FIRST_MEMBER_NOT_MADE" }),
      );
      expect(await tab.isSignedIn()).toBe(false);
      for (const table of ["members", "accounts", "two_factors", "sessions"]) {
        expect(await query(`SELECT id FROM ${table}`)).toEqual([]);
      }
      const waiting = "SELECT id FROM verifications WHERE identifier = 'first-member-new-totp'";
      expect(await query(waiting)).toHaveLength(1);
      // The auth module's log says what failed by the error's name only, never the rows it was
      // writing: no password hash, session token or email.
      const failures = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === "The first Member was not made");
      expect(failures).toEqual([
        { time: expect.any(String), level: "error", msg: failures[0]?.msg, errorName: "Error" },
      ]);
      expect([...lines, ...stdout].join("")).not.toContain(madeUp);
      expect([...lines, ...stdout].join("")).not.toContain("alice@example.com");

      await query("DROP TRIGGER fail_first_member");
      // Another short-lived value, which making the Member leaves alone.
      const at = new Date().toISOString();
      await query(
        `INSERT INTO verifications VALUES ('other-row', 'other-value-for', 'x', '${at}', '${at}', '${at}')`,
      );
      const made = await tab.create(code, await totpCodeFromURI(totpURI));

      expect(made.status).toBe(200);
      expect(await tab.isSignedIn()).toBe(true);
      expect(await query("SELECT id FROM members")).toHaveLength(1);
      expect(await query("SELECT id FROM accounts")).toHaveLength(1);
      // The code that made the Member is used.
      expect(await query("SELECT last_totp_step FROM two_factors")).toEqual([
        expect.objectContaining({ last_totp_step: Math.floor(Date.now() / 30_000) }),
      ]);
      expect(await query("SELECT id FROM sessions")).toHaveLength(1);
      expect(await query(waiting)).toEqual([]);
      expect(await query("SELECT id FROM verifications")).toEqual([
        expect.objectContaining({ id: "other-row" }),
      ]);
    },
  );

  it("refuses a wrong TOTP code, and makes no Member", async () => {
    const tab = browser();
    await tab.newTotp(code);

    const res = await tab.create(code, "000000");

    expect(res.status).toBe(401);
    expect(await query("SELECT id FROM members")).toHaveLength(0);
    expect(await tab.isSignedIn()).toBe(false);
  });

  it("forgets a TOTP secret that waits more than 10 minutes", async () => {
    const tab = browser();
    const { totpURI } = (await (await tab.newTotp(code)).json()) as { totpURI: string };
    vi.setSystemTime(Date.now() + 11 * MINUTE_MS);

    const res = await tab.create(code, await totpCodeFromURI(totpURI));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(expect.objectContaining({ code: "NO_NEW_TOTP" }));
    expect(await query("SELECT id FROM members")).toHaveLength(0);
  });

  it("refuses the 6th wrong code in 15 minutes, even the right one, for the whole app", async () => {
    const attacker = browser("192.168.1.66");
    for (let i = 0; i < 5; i += 1) {
      expect((await attacker.checkCode(wrongCode(code))).status).toBe(401);
    }

    // The 6th try, from another address with the right code, is refused unchecked.
    const owner = browser("192.168.1.10");
    const refused = await owner.checkCode(code);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual(
      expect.objectContaining({ code: "TOO_MANY_WRONG_SETUP_CODES" }),
    );
    expect((await owner.newTotp(code)).status).toBe(429);

    // After 15 minutes the code works again.
    vi.setSystemTime(Date.now() + 15 * MINUTE_MS + 1000);
    expect((await owner.checkCode(code)).status).toBe(200);
  });

  it("counts each wrong or refused code per IP address and for the whole app", async () => {
    const attacker = browser("192.168.1.66");
    for (let i = 0; i < 7; i += 1) await attacker.checkCode(wrongCode(code));

    const keys = await query("SELECT key, count(*) AS tries FROM sign_in_tries GROUP BY key");
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "setup-code", tries: 7 }),
        expect.objectContaining({ key: "setup-code-ip:192.168.1.66", tries: 7 }),
      ]),
    );
  });

  it("counts every IPv6 address in one /64 network as one address", async () => {
    for (let i = 0; i < 6; i += 1)
      await browser(`2001:db8:7:8::${i + 1}`).checkCode(wrongCode(code));

    const keys = await query("SELECT key, count(*) AS tries FROM sign_in_tries GROUP BY key");
    expect(keys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "setup-code-ip:2001:db8:7:8::/64", tries: 6 }),
      ]),
    );
  });

  it("counts a right code as no try", async () => {
    const tab = browser();
    for (let i = 0; i < 4; i += 1) await tab.checkCode(wrongCode(code));
    for (let i = 0; i < 3; i += 1) expect((await tab.checkCode(code)).status).toBe(200);

    expect((await tab.checkCode(wrongCode(code))).status).toBe(401);
    expect((await tab.checkCode(code)).status).toBe(429);
  });

  describe("a request from another site, or not as JSON", () => {
    const ROUTES = [
      ["check-code", { setupCode: "WRONG-CODE" }],
      ["new-totp", { setupCode: "WRONG-CODE", email: "alice@example.com" }],
      ["create", { setupCode: "WRONG-CODE", name: "A", email: "a@example.com", totpCode: "1" }],
    ] as const;

    const tries = async () => (await query("SELECT count(*) AS n FROM sign_in_tries"))[0]?.n;

    it.each(ROUTES)(
      "refuses %s with a cross-site or a missing Origin, and counts no try",
      async (route, body) => {
        const tab = browser();
        for (const origin of ["https://evil.example", undefined, "null"]) {
          const res = await tab.send("POST", `/api/auth/first-member/${route}`, body, { origin });
          expect(res.status).toBe(403);
        }

        expect(await tries()).toBe(0);
      },
    );

    it.each(ROUTES)("refuses %s sent as a form with 415, and counts no try", async (route) => {
      const tab = browser();
      const res = await tab.send("POST", `/api/auth/first-member/${route}`, undefined, {
        "content-type": "application/x-www-form-urlencoded",
      });

      expect(res.status).toBe(415);
      expect(await tries()).toBe(0);
    });

    it("still takes the right code from the app's own page afterwards", async () => {
      const tab = browser();
      await tab.send(
        "POST",
        "/api/auth/first-member/check-code",
        { setupCode: code },
        {
          origin: "https://evil.example",
        },
      );

      expect((await tab.checkCode(code)).status).toBe(200);
    });
  });

  it("never writes the setup code to its log", async () => {
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => stdout.push(String(chunk)) > 0);
    try {
      const tab = browser();
      await tab.checkCode(wrongCode(code));
      await tab.checkCode(code.toLowerCase());
      await makeFirstMember(tab);
      await tab.checkCode(code);
    } finally {
      vi.restoreAllMocks();
    }

    const written = [...lines, ...stdout].join("\n");
    const bare = code.replace(/-/g, "");
    for (const form of [code, bare, code.toLowerCase(), bare.toLowerCase()]) {
      expect(written).not.toContain(form);
    }
  });

  describe("page gating", () => {
    it("leads to the wizard until steps 1 to 4 are done, then opens the app", async () => {
      const tab = browser();
      await makeFirstMember(tab);

      await markSetupStep(test.database, "master key", "done");
      expect(await tab.setupState()).toEqual({ next: "household facts", wizard: true });

      await markSetupStep(test.database, "household facts", "done");
      expect(await tab.setupState()).toEqual({ next: null, wizard: false });
    });

    it("opens the first step that is neither done nor skipped", async () => {
      const tab = browser();
      await makeFirstMember(tab);

      await markSetupStep(test.database, "household facts", "done");
      expect(await tab.setupState()).toEqual({ next: "master key", wizard: true });
    });
  });
});
