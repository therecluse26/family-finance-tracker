import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { markSetupStep } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "../server/app.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { type App, TestBrowser } from "../server/testing.ts";
import type { ChannelsView, SmtpView } from "./email-view.ts";
import { smtpSettings, smtpTransport } from "./index.ts";
import { StubSmtp, smtpError } from "./testing.ts";

// Settings → Alerts (spec 06, Recipients and channels; spec 09, Signing in): the Household's SMTP
// server, "Send a test email", and each Member's channels, through the app's HTTP interface, with a
// stubbed SMTP server. Members use example.test addresses.

const APP_URL = "http://nas.local:8080";
const TOTP_STEP_MS = 30_000;

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-email-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Settings → Alerts", () => {
  let test: TestAuth;
  let app: App;
  let stub: StubSmtp;
  let lines: string[];
  let alice: TestMember;
  let bob: TestMember;
  let clients = 0;
  // Made when the test runs.
  let password: string;

  const server = (fields: Partial<SmtpView & { password: string }> = {}) => ({
    host: "smtp.example.test",
    port: 587,
    username: "household@example.test",
    password,
    sender: "alerts@example.test",
    ...fields,
  });
  const storedRow = async () =>
    (await test.database.$client.execute("SELECT * FROM smtp_settings")).rows;
  const smtpOf = async (tab: TestBrowser) =>
    ((await (await tab.get("/api/smtp/settings")).json()) as { smtp: SmtpView | null }).smtp;
  const channelsOf = async (tab: TestBrowser) =>
    ((await (await tab.get("/api/alert-channels")).json()) as { channels: ChannelsView }).channels;

  // Signed in, with the clock moved on one TOTP step, so the next code is fresh.
  async function signedIn(member: TestMember): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    await tab.signIn(member);
    vi.setSystemTime(Date.now() + TOTP_STEP_MS);
    return tab;
  }

  async function finishWizard(): Promise<void> {
    await markSetupStep(test.database, "master key", "done");
    await markSetupStep(test.database, "household facts", "done");
  }

  // Saves the SMTP server. TOTP is asked only at sign-in (spec 09, Sensitive actions).
  const save = (tab: TestBrowser, fields = server()) => tab.post("/api/smtp/settings", fields);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
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
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.test" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.test" });
  });

  afterEach(() => {
    vi.useRealTimers();
    test.close();
  });

  it("saves the SMTP server with no code, and never shows or logs the password", async () => {
    await finishWizard();
    const tab = await signedIn(alice);
    expect(await smtpOf(tab)).toBeNull();

    const res = await save(tab);
    expect(res.status).toBe(200);
    const shown = {
      host: "smtp.example.test",
      port: 587,
      username: "household@example.test",
      sender: "alerts@example.test",
    };
    expect(await res.json()).toEqual({ smtp: shown });
    expect(await smtpOf(tab)).toEqual(shown);
    expect(await smtpOf(await signedIn(bob))).toEqual(shown);

    const [row] = await storedRow();
    expect(String(row?.password)).not.toContain(password);
    expect(lines.join("")).not.toContain(password);
  });

  it("sends the stored password to no new server or sign-in name, and keeps it for a new sender", async () => {
    await finishWizard();
    const tab = await signedIn(alice);
    expect((await save(tab)).status).toBe(200);
    const before = await storedRow();

    // A new host, port, or sign-in name with no password changes nothing.
    for (const change of [
      { host: "mail.example.test" },
      { port: 465 },
      { username: "other@example.test" },
    ]) {
      const { password: _, ...noPassword } = server(change);
      const res = await tab.post("/api/smtp/settings", noPassword);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Enter the SMTP password." });
    }
    expect(await storedRow()).toEqual(before);

    // The sender changes with no password, and keeps the stored password.
    const { password: __, ...sameServer } = server({ sender: "family@example.test" });
    expect((await tab.post("/api/smtp/settings", sameServer)).status).toBe(200);
    expect(await smtpOf(tab)).toMatchObject({ sender: "family@example.test" });
    expect((await tab.post("/api/smtp/test")).status).toBe(200);
    expect(stub.servers.at(-1)?.password).toBe(password);

    // A new server with its password saves, with no code.
    const moved = server({ host: "mail.example.test", port: 465, password: "a-new-password" });
    expect((await save(tab, moved)).status).toBe(200);
    expect(await smtpOf(tab)).toMatchObject({ host: "mail.example.test", port: 465 });
  });

  it("refuses fields that are not an SMTP server's", async () => {
    await finishWizard();
    const tab = await signedIn(alice);
    for (const fields of [
      server({ host: "smtp.example.test/path" }),
      server({ host: "smtp://smtp.example.test" }),
      server({ port: 0 }),
      server({ port: 70_000 }),
      server({ sender: "not an address" }),
      server({ username: "" }),
      server({ password: "line\nbreak" }),
      { ...server(), extra: true },
    ]) {
      const res = await tab.post("/api/smtp/settings", fields);
      expect(res.status).toBe(400);
    }
    expect(await storedRow()).toEqual([]);
  });

  it("sends a test email to the signed-in Member, and shows the result", async () => {
    await finishWizard();
    const tab = await signedIn(alice);
    const notSetUp = await tab.post("/api/smtp/test");
    expect(notSetUp.status).toBe(409);
    expect(await notSetUp.json()).toEqual({ sent: false, error: "Save the SMTP server first." });

    expect((await save(tab)).status).toBe(200);
    // With no body, as a page that sends none, the write has no JSON content type: 415.
    const noBody = await tab.send("POST", "/api/smtp/test");
    expect(noBody.status).toBe(415);
    expect((await tab.send("POST", "/api/smtp/test", { to: "bob@example.test" })).status).toBe(400);
    expect(stub.emails).toEqual([]);
    // The page sends an empty JSON body (AlertEmail.test.tsx).
    const sent = await tab.send("POST", "/api/smtp/test", {});
    expect(sent.status).toBe(200);
    expect(await sent.json()).toEqual({ sent: true });
    const bobsTab = await signedIn(bob);
    expect((await bobsTab.send("POST", "/api/smtp/test", {})).status).toBe(200);
    expect(
      stub.emails.map((email) => [email.from, email.to, email.bcc, email.envelope, email.subject]),
    ).toEqual([
      [
        "alerts@example.test",
        ["alerts@example.test"],
        ["alice@example.test"],
        ["alerts@example.test", "alice@example.test"],
        "Test email",
      ],
      [
        "alerts@example.test",
        ["alerts@example.test"],
        ["bob@example.test"],
        ["alerts@example.test", "bob@example.test"],
        "Test email",
      ],
    ]);
    expect(stub.emails[0]?.text).toContain("http://nas.local:8080/settings/alerts");

    // The server refuses the sign-in. Its reply names the sign-in name, which no log line holds.
    stub.failWith = smtpError("EAUTH", 535, "Invalid login: 535 household@example.test");
    const refused = await tab.post("/api/smtp/test");
    expect(refused.status).toBe(502);
    expect(await refused.json()).toEqual({
      sent: false,
      error: "The SMTP server refused the sign-in name or password.",
    });
    stub.failWith = smtpError("ETIMEDOUT", 0, "Connection timeout");
    expect(await (await tab.post("/api/smtp/test")).json()).toMatchObject({
      error: "The app could not reach the SMTP server over TLS. Check the host and port.",
    });
    const logged = lines.join("");
    expect(logged).toContain('"errorCode":"EAUTH"');
    expect(logged).not.toContain("Invalid login");
    expect(logged).not.toContain("household@example.test");
    expect(logged).not.toContain(password);
  });

  it("asks for the SMTP password again when the saved one cannot be read", async () => {
    await finishWizard();
    const tab = await signedIn(alice);
    expect((await save(tab)).status).toBe(200);
    // As after a restore under another Master key.
    await test.database.$client.execute("UPDATE smtp_settings SET password = 'unreadable'");

    const res = await tab.send("POST", "/api/smtp/test", {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      sent: false,
      error: "The app cannot read the saved SMTP password. Enter the password again, and save.",
    });
    expect(stub.emails).toEqual([]);
    expect((await save(tab)).status).toBe(200);
    expect((await tab.send("POST", "/api/smtp/test", {})).status).toBe(200);
  });

  it("refuses to store the SMTP password until the wizard's required steps are done", async () => {
    const tab = await signedIn(alice);
    expect((await save(tab)).status).toBe(409);
    expect((await tab.post("/api/smtp/test")).status).toBe(409);
    expect(await storedRow()).toEqual([]);
    expect(stub.emails).toEqual([]);
  });

  it("answers 401 with no session, 403 to another site or no Origin, and 415 to a body that is not JSON, and changes nothing", async () => {
    await finishWizard();
    const tab = await signedIn(alice);
    expect((await save(tab)).status).toBe(200);
    const before = await storedRow();
    const writes = [
      ["POST", "/api/smtp/settings", server({ host: "evil.example.test" })],
      ["POST", "/api/smtp/test", {}],
      ["PUT", "/api/alert-channels", { push: false, email: false }],
    ] as const;

    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.250");
    for (const [method, path, body] of writes) {
      expect((await signedOut.send(method, path, body)).status).toBe(401);
      expect(
        (await tab.send(method, path, body, { origin: "http://evil.example.test" })).status,
      ).toBe(403);
      expect((await tab.send(method, path, body, { origin: undefined })).status).toBe(403);
      expect((await tab.send(method, path, body, { "content-type": "text/plain" })).status).toBe(
        415,
      );
    }

    expect(await storedRow()).toEqual(before);
    expect(stub.emails).toEqual([]);
    expect(await channelsOf(tab)).toEqual({ push: true, email: true, emailSetUp: true });
    expect((await signedOut.get("/api/smtp/settings")).status).toBe(401);
    expect((await signedOut.get("/api/alert-channels")).status).toBe(401);
  });

  it("starts each Member with both channels, and keeps each Member's own pick", async () => {
    await finishWizard();
    const alicesTab = await signedIn(alice);
    const bobsTab = await signedIn(bob);
    // Email is not set up until an SMTP server is saved, so the app skips it.
    expect(await channelsOf(alicesTab)).toEqual({ push: true, email: true, emailSetUp: false });

    for (const pick of [
      { push: true, email: false },
      { push: false, email: true },
      { push: false, email: false },
      { push: true, email: true },
      { push: false, email: false },
    ]) {
      const res = await alicesTab.send("PUT", "/api/alert-channels", pick);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ channels: { ...pick, emailSetUp: false } });
    }
    expect(await channelsOf(alicesTab)).toEqual({ push: false, email: false, emailSetUp: false });
    expect(await channelsOf(bobsTab)).toEqual({ push: true, email: true, emailSetUp: false });

    for (const body of [
      { push: true },
      { push: "yes", email: true },
      { ...{ push: true, email: true }, memberId: bob.id },
    ]) {
      expect((await alicesTab.send("PUT", "/api/alert-channels", body)).status).toBe(400);
    }
    expect(await channelsOf(bobsTab)).toEqual({ push: true, email: true, emailSetUp: false });

    expect((await save(alicesTab)).status).toBe(200);
    expect(await channelsOf(bobsTab)).toEqual({ push: true, email: true, emailSetUp: true });
  });
});

describe("the SMTP transport", () => {
  // nodemailer's options for the SMTP connection. Making a transport opens no connection.
  const optionsOf = (port: number) => {
    const transport = smtpTransport({
      host: "smtp.example.test",
      port,
      username: "household@example.test",
      password: "made-up",
      sender: "alerts@example.test",
    }) as unknown as { transporter: { options: Record<string, unknown> } };
    return transport.transporter.options;
  };

  it("never sends the password in plain text: TLS from the start on port 465, STARTTLS required elsewhere", () => {
    expect(optionsOf(465)).toMatchObject({ port: 465, secure: true, requireTLS: false });
    expect(optionsOf(587)).toMatchObject({ port: 587, secure: false, requireTLS: true });
    expect(optionsOf(25)).toMatchObject({ secure: false, requireTLS: true });
  });

  it("never reads a file or a URL into a message", () => {
    expect(optionsOf(587)).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
  });
});
