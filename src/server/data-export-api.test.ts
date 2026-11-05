import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth, type TestMember } from "../auth/testing.ts";
import { seedDemoHousehold } from "../bank/demo.ts";
import { FakeBankAdapter } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { startCategorization } from "../categorization/index.ts";
import {
  AI_SETTINGS_ROW,
  addConnection,
  addGoal,
  markSetupStep,
  PLAID_SETTINGS_ROW,
  replaceVapidKeys,
  SMTP_SETTINGS_ROW,
  storeAiSettings,
  storePlaidKeys,
  storePushDevice,
  storeSmtpSettings,
  VAPID_KEYS_ROW,
} from "../db/index.ts";
import { runFollowUp, startFollowUpPipeline } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { startMoneyMovement } from "../money-movement/index.ts";
import { createApp } from "./app.ts";
import type { TransactionListView } from "./bank-views.ts";
import { csvAmount, csvText } from "./data-export.ts";
import { loadSecurity } from "./security-mode.ts";
import { type App, readZip, TestBrowser } from "./testing.ts";

// "Download my data" (spec 11, Data export), through the app's HTTP interface, on the demo
// Household with a made-up secret of every kind: unzip the file, and check each file, each column,
// and that no secret, hash, token, or session ID is in it. Every secret is made when the test runs.

const APP_URL = "http://nas.local:8080";
const TOTP_STEP_MS = 30_000;
const FILES = [
  "transactions.csv",
  "accounts.csv",
  "budgets.csv",
  "goals.csv",
  "category-rules.csv",
  "data.json",
];
const AMOUNT = /^-?\d+\.\d{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const made = (label: string) => `${label}-${crypto.randomUUID()}`;

// One CSV file's rows, each by its header's names. The test's own reader: it takes quoted cells,
// with "" for a quote, and lines that end in CRLF.
function readCsv(text: string): { header: string[]; rows: Record<string, string>[] } {
  const lines: string[][] = [];
  let cell = "";
  let line: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      line.push(cell);
      cell = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      line.push(cell);
      lines.push(line);
      line = [];
      cell = "";
      i += 1;
    } else cell += char;
  }
  if (cell !== "" || line.length > 0) throw new Error("The last line does not end in CRLF.");
  const [header = [], ...rest] = lines;
  for (const row of rest) expect(row).toHaveLength(header.length);
  return {
    header,
    rows: rest.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i] ?? ""]))),
  };
}

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-data-export-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("Download my data", () => {
  let test: TestAuth;
  let app: App;
  let alice: TestMember;
  let bob: TestMember;
  let lines: string[];
  let stops: (() => void)[];
  let clients = 0;
  // Each made-up secret in plain text, for the byte search.
  const plain: string[] = [];
  // The split and the removed Transaction.
  let splitId: string;
  let splitParts: { amount: number; category: string }[];
  let removedId: string;

  const later = () => vi.setSystemTime(Date.now() + TOTP_STEP_MS);
  const rows = async (sql: string) => (await test.database.$client.execute(sql)).rows;
  const download = (
    tab: TestBrowser,
    body: unknown,
    headers?: Record<string, string | undefined>,
  ) => tab.send("POST", "/api/export", body, headers);

  async function signedIn(member: TestMember): Promise<TestBrowser> {
    clients += 1;
    const tab = new TestBrowser(app, APP_URL, `192.168.1.${clients}`);
    // Each TOTP code works once, so each sign-in and each download takes its own step.
    later();
    await tab.signIn(member);
    later();
    return tab;
  }

  async function exported(): Promise<Map<string, Uint8Array> & { zip: Uint8Array }> {
    const tab = await signedIn(alice);
    const res = await download(tab, { code: await alice.totpCode() });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="family-finance-data-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    const zip = new Uint8Array(await res.arrayBuffer());
    return Object.assign(readZip(zip), { zip });
  }

  const textOf = (files: Map<string, Uint8Array>, name: string) =>
    new TextDecoder("utf-8", { fatal: true }).decode(files.get(name));

  beforeAll(async () => {
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
    const fake = new FakeBankAdapter();
    stops = [
      startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop,
      startFollowUpPipeline({ database: test.database, startJob: () => runFollowUp() }).stop,
      startMoneyMovement({ database: test.database }).stop,
      startCategorization({ database: test.database }).stop,
    ];
    alice = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    bob = await addMember(test.auth, { name: "Bob", email: "bob@example.com" });
    await markSetupStep(test.database, "master key", "done");
    await seedDemoHousehold(test.database, fake);
    await runFollowUp();

    // A made-up secret of every kind the app stores, encrypted as the app stores it.
    const seal = (value: string, rowId: string | number, column: string) => {
      plain.push(value);
      return test.secrets.encrypt(value, { rowId, column });
    };
    const accessToken = made("access-sandbox");
    await addConnection(test.database, {
      provider: "plaid",
      bankId: "ins_fake",
      bankName: "Fake Plaid Bank",
      origin: "linked",
      sealCredential: (rowId) => seal(accessToken, rowId, "connections.credential"),
    });
    const clientId = made("client");
    plain.push(clientId);
    await storePlaidKeys(test.database, {
      clientId,
      secret: seal(made("plaid-secret"), PLAID_SETTINGS_ROW, "plaid_settings.secret"),
    });
    const smtpUser = made("smtp-user");
    plain.push(smtpUser);
    await storeSmtpSettings(test.database, {
      host: "smtp.example.com",
      port: 587,
      username: smtpUser,
      password: seal(made("smtp-password"), SMTP_SETTINGS_ROW, "smtp_settings.password"),
      sender: "alerts@example.com",
    });
    const baseUrl = `https://${made("user")}:${made("pass")}@ai.example.com/v1`;
    plain.push(baseUrl);
    await storeAiSettings(
      test.database,
      {
        provider: "openai-compatible",
        apiKey: seal(made("sk-test"), AI_SETTINGS_ROW, "ai_settings.api_key"),
        baseUrl,
        gatewayToken: seal(made("gateway"), AI_SETTINGS_ROW, "ai_settings.gateway_token"),
        quickModel: "quick-model",
        writerModel: "writer-model",
        keyRejectedAt: null,
      },
      0,
    );
    await replaceVapidKeys(test.database, {
      publicKey: seal(made("vapid-public"), VAPID_KEYS_ROW, "vapid_keys.public_key"),
      privateKey: seal(made("vapid-private"), VAPID_KEYS_ROW, "vapid_keys.private_key"),
    });
    const device = {
      endpoint: `https://push.example.com/${made("endpoint")}`,
      p256dh: made("p256dh"),
      auth: made("auth"),
    };
    plain.push(device.endpoint, device.p256dh, device.auth);
    await storePushDevice(test.database, alice.id, device, new Date());
    for (const member of [alice, bob]) {
      plain.push(member.password, member.totpSecret, ...member.backupCodes);
    }

    // The data spec 11 names, one of each: a Monthly review, an Insight card, a Chat thread, a
    // Proposal, and an Alert, with a Goal and a Category rule.
    const at = new Date().toISOString();
    const insert = (sql: string, args: (string | number | null)[]) =>
      test.database.$client.execute({ sql, args });
    await insert("INSERT INTO monthly_reviews (month, written_at, review) VALUES (?, ?, ?)", [
      "2026-10",
      at,
      JSON.stringify({ summary: "October review words" }),
    ]);
    await insert(
      `INSERT INTO insight_cards (id, position, written_at, month, card_group, about, figure,
        figure_kind, figure_label, title, why, next_step) VALUES (?, 1, ?, '2026-10', 'heads_up',
        'Groceries', 120, 'dollars', 'this month', 'Insight card title', 'Why words', 'Next step')`,
      ["card-1", at],
    );
    await insert(
      "INSERT INTO chat_threads (id, title, created_at, last_message_at) VALUES (?, ?, ?, ?)",
      ["thread-1", "Chat thread title", at, at],
    );
    await insert(
      `INSERT INTO chat_messages (id, thread_id, author, member_id, member_name, text, created_at)
        VALUES ('message-1', 'thread-1', 'Member', ?, 'Alice', 'A Chat question', ?)`,
      [alice.id, at],
    );
    await insert(
      `INSERT INTO proposals (id, kind, source, run_id, reason, words, status, created_at)
        VALUES ('proposal-1', 'new Goal', 'Chat', 'message-1', 'Proposal reason', 'Save more', 'open', ?)`,
      [at],
    );
    await insert(
      `INSERT INTO alerts (id, kind, created_at, facts, text, state)
        VALUES ('alert-1', 'Large purchase', ?, '{}', 'Alert text', 'sent')`,
      [at],
    );
    await addGoal(test.database, {
      words: "=SUM(1,2) less on eating out",
      authorId: alice.id,
      date: "2026-11-01",
      target: { kind: "Category", category: "Restaurants" },
      change: { percent: 20 },
      deadline: null,
    });

    const tab = await signedIn(alice);
    const spending = (await (
      await tab.get("/api/transactions?type=Spending")
    ).json()) as TransactionListView;
    const [one, other] = spending.transactions.filter(
      (txn) => txn.parts.length === 1 && !txn.parts[0]?.linked && txn.amount <= -200,
    );
    if (one === undefined || other === undefined) throw new Error("The demo has no Spending.");
    // A split of one Spending Transaction, and a Category rule from another.
    splitId = one.id;
    splitParts = [
      { amount: -one.amount - 100, category: "Groceries" },
      { amount: 100, category: "Clothing" },
    ];
    expect(
      (await tab.send("PUT", `/api/transactions/${splitId}/split`, { parts: splitParts })).status,
    ).toBe(200);
    expect(
      (
        await tab.send("PUT", `/api/transactions/${other.id}/category`, {
          category: "Hobbies",
          onlyThisTransaction: false,
        })
      ).status,
    ).toBe(200);
    await runFollowUp();

    // The provider removes a third.
    const [removed] = await rows(
      `SELECT t.id, t.provider_transaction_id, c.id AS connection_id, c.bank_id
        FROM transactions t JOIN connections c ON c.id = t.connection_id
        WHERE t.hidden_reason IS NULL AND t.id NOT IN ('${splitId}', '${other.id}') LIMIT 1`,
    );
    removedId = String(removed?.id);
    fake.addPages(String(removed?.bank_id), {
      removed: [{ id: String(removed?.provider_transaction_id) }],
    });
    await syncConnection(String(removed?.connection_id));
    await runFollowUp();
    expect(await rows(`SELECT hidden_reason FROM transactions WHERE id = '${removedId}'`)).toEqual([
      { hidden_reason: "removed by provider" },
    ]);
  }, 60_000);

  afterAll(() => {
    vi.useRealTimers();
    for (const stop of stops) stop();
    test.close();
  });

  it("holds five CSV files and data.json, in that order", async () => {
    const files = await exported();

    expect([...files.keys()]).toEqual(FILES);
  });

  it("writes transactions.csv: one row per part, removed Transactions left out, dates and amounts as spec 11 says", async () => {
    const files = await exported();
    const { header, rows: lines } = readCsv(textOf(files, "transactions.csv"));
    const accounts = readCsv(textOf(files, "accounts.csv")).rows;
    const shown = (await rows(
      "SELECT id, amount, posted_date, authorized_date, pending, description FROM transactions WHERE hidden_reason IS NULL",
    )) as unknown as {
      id: string;
      amount: number;
      posted_date: string;
      authorized_date: string | null;
      pending: number;
      description: string;
    }[];

    expect(header).toEqual([
      "id",
      "date",
      "account",
      "merchant",
      "description",
      "amount",
      "category",
      "category_group",
      "kind",
      "status",
      "linked_ids",
    ]);
    expect(lines.map((row) => row.id)).not.toContain(removedId);
    expect(new Set(lines.map((row) => row.id))).toEqual(new Set(shown.map((txn) => txn.id)));
    const accountNames = new Set(accounts.map((account) => account.name));
    for (const row of lines) {
      expect(row.date).toMatch(DATE);
      expect(row.amount).toMatch(AMOUNT);
      expect(accountNames).toContain(row.account);
      expect(["pending", "posted"]).toContain(row.status);
      expect(["Spending", "Income", "Transfer", "Saving", "Refund", "Reimbursement"]).toContain(
        row.kind,
      );
    }
    // The date is the purchase date when the bank gives one, else the posted date; the
    // description is the bank's; money out is negative.
    for (const txn of shown) {
      const [row] = lines.filter((line) => line.id === txn.id);
      expect(row?.date).toBe(txn.authorized_date ?? txn.posted_date);
      expect(row?.description?.replace(/^'/, "")).toBe(txn.description);
      expect(row?.status).toBe(txn.pending ? "pending" : "posted");
      const sum = lines
        .filter((line) => line.id === txn.id)
        .reduce((total, line) => total + Math.round(Number(line.amount) * 100), 0);
      if (row?.kind !== "Saving" && row?.kind !== "Transfer")
        expect(Math.abs(sum)).toBe(Math.abs(txn.amount));
    }
    expect(
      shown.some((txn) => txn.authorized_date !== null && txn.authorized_date !== txn.posted_date),
    ).toBe(true);

    // The split gives one row per part, each with its own Category and its Category group.
    expect(
      lines
        .filter((row) => row.id === splitId)
        .map(({ amount, category, category_group, kind }) => ({
          amount,
          category,
          category_group,
          kind,
        })),
    ).toEqual([
      {
        amount: csvAmount(-(splitParts[0]?.amount ?? 0)),
        category: "Groceries",
        category_group: "Shopping",
        kind: "Spending",
      },
      { amount: "-1.00", category: "Clothing", category_group: "Shopping", kind: "Spending" },
    ]);

    // Each link shows on both sides.
    const linked = lines.filter((row) => row.linked_ids !== "");
    expect(linked.length).toBeGreaterThan(0);
    for (const row of linked) {
      for (const id of (row.linked_ids ?? "").split(";")) {
        expect(lines.find((line) => line.id === id)?.linked_ids?.split(";")).toContain(row.id);
      }
    }
  });

  it("writes accounts.csv, budgets.csv, goals.csv, and category-rules.csv, one row per record", async () => {
    const files = await exported();
    const accounts = readCsv(textOf(files, "accounts.csv"));
    const budgets = readCsv(textOf(files, "budgets.csv"));
    const goals = readCsv(textOf(files, "goals.csv"));
    const rules = readCsv(textOf(files, "category-rules.csv"));

    expect(accounts.header).toEqual([
      "id",
      "name",
      "kind",
      "subtype",
      "institution",
      "last_4",
      "current_balance",
      "available_balance",
      "credit_limit",
      "estimated",
      "excluded",
      "closed",
    ]);
    const stored = await rows("SELECT id FROM household_accounts");
    expect(accounts.rows.map((row) => row.id).sort()).toEqual(stored.map((row) => row.id).sort());
    for (const row of accounts.rows) {
      for (const amount of [row.current_balance, row.available_balance, row.credit_limit]) {
        if (amount !== "") expect(amount).toMatch(AMOUNT);
      }
    }

    expect(budgets.header).toEqual([
      "category",
      "category_group",
      "amount",
      "period",
      "takes_effect",
      "source",
      "set_by",
      "set_on",
      "pinned",
      "ends_budget",
      "reason",
    ]);
    expect(budgets.rows).toHaveLength((await rows("SELECT id FROM budgets")).length);

    expect(goals.header).toEqual([
      "id",
      "words",
      "author",
      "date",
      "status",
      "ended_on",
      "ended_by",
      "target",
      "change_amount",
      "change_percent",
      "deadline",
      "goal_amount",
      "starts_on",
    ]);
    // A cell that starts like a formula starts with a single quote, so a spreadsheet runs nothing.
    expect(goals.rows).toEqual([
      expect.objectContaining({
        words: "'=SUM(1,2) less on eating out",
        author: "Alice",
        date: "2026-11-01",
        status: "active",
        target: "Restaurants",
        change_percent: "20",
      }),
    ]);

    expect(rules.header).toEqual([
      "id",
      "merchant",
      "category",
      "category_group",
      "made_on",
      "made_by",
    ]);
    expect(rules.rows).toEqual([
      expect.objectContaining({
        category: "Hobbies",
        category_group: expect.any(String),
        made_by: "Alice",
      }),
    ]);
    expect(rules.rows[0]?.made_on).toMatch(DATE);
  });

  it("writes data.json with all data but secrets: the removed Transaction with its reason, Monthly reviews, Insight cards, Chat, Proposals, and Alerts", async () => {
    const files = await exported();
    const data = JSON.parse(textOf(files, "data.json")) as {
      about: { exported_at: string };
      tables: Record<string, Record<string, unknown>[]>;
    };
    const { tables } = data;

    expect(tables.transactions?.find((txn) => txn.id === removedId)).toMatchObject({
      hidden_reason: "removed by provider",
    });
    expect(tables.transactions).toHaveLength((await rows("SELECT id FROM transactions")).length);
    expect(tables.monthly_reviews).toEqual([
      expect.objectContaining({ month: "2026-10", review: { summary: "October review words" } }),
    ]);
    expect(tables.insight_cards).toEqual([
      expect.objectContaining({ title: "Insight card title" }),
    ]);
    expect(tables.chat_threads).toEqual([expect.objectContaining({ title: "Chat thread title" })]);
    expect(tables.chat_messages).toEqual([expect.objectContaining({ text: "A Chat question" })]);
    expect(tables.proposals).toEqual([expect.objectContaining({ reason: "Proposal reason" })]);
    expect(tables.alerts).toEqual([expect.objectContaining({ text: "Alert text" })]);
    expect(tables.ai_settings).toEqual([
      { provider: "openai-compatible", quick_model: "quick-model", writer_model: "writer-model" },
    ]);
    for (const name of [
      "sessions",
      "accounts",
      "two_factors",
      "verifications",
      "data_keys",
      "vapid_keys",
      "push_devices",
    ]) {
      expect(tables[name], name).toBeUndefined();
    }
  });

  it("holds no secret, hash, token, or session ID, in the ZIP's bytes or in any file", async () => {
    // A sign-in waiting at the code step leaves a verification row and its cookie.
    const waiting = new TestBrowser(app, APP_URL, "192.168.3.1");
    const password = { email: bob.email, password: bob.password };
    expect((await waiting.post("/api/auth/sign-in/email", password)).status).toBe(200);
    const tab = await signedIn(bob);
    const res = await download(tab, { code: await bob.totpCode() });
    const zip = new Uint8Array(await res.arrayBuffer());
    const files = readZip(zip);
    const stored = (
      await Promise.all(
        [
          "SELECT encrypted_key AS v FROM data_keys",
          "SELECT id AS v FROM sessions UNION ALL SELECT token FROM sessions",
          "SELECT password AS v FROM accounts",
          "SELECT secret AS v FROM two_factors UNION ALL SELECT backup_codes FROM two_factors",
          "SELECT id AS v FROM verifications UNION ALL SELECT identifier FROM verifications UNION ALL SELECT value FROM verifications",
          "SELECT credential AS v FROM connections WHERE credential IS NOT NULL",
          "SELECT client_id AS v FROM plaid_settings UNION ALL SELECT secret FROM plaid_settings",
          "SELECT username AS v FROM smtp_settings UNION ALL SELECT password FROM smtp_settings",
          "SELECT api_key AS v FROM ai_settings UNION ALL SELECT gateway_token FROM ai_settings UNION ALL SELECT base_url FROM ai_settings",
          "SELECT public_key AS v FROM vapid_keys UNION ALL SELECT private_key FROM vapid_keys",
          "SELECT endpoint AS v FROM push_devices UNION ALL SELECT p256dh FROM push_devices UNION ALL SELECT auth FROM push_devices",
        ].map(rows),
      )
    )
      .flat()
      .map((row) => String(row.v));
    const cookies = [...tab.cookies.values(), ...waiting.cookies.values()].flatMap((value) => [
      value,
      decodeURIComponent(value).split(".")[0] ?? "",
    ]);
    // A waiting sign-in's verification row holds the Member's ID, which the export holds on
    // purpose: it is no secret.
    const memberIds = new Set([alice.id, bob.id]);
    const secrets = [...plain, ...stored, ...cookies, test.masterKey.key.export().toString("hex")]
      .filter((value) => value.length >= 12)
      .filter((value) => !memberIds.has(value));
    expect(stored.length).toBeGreaterThanOrEqual(18);
    expect(await rows("SELECT id FROM verifications")).not.toEqual([]);

    const haystacks = [Buffer.from(zip), ...[...files.values()].map((bytes) => Buffer.from(bytes))];
    const found = secrets.filter((secret) =>
      haystacks.some((bytes) => bytes.includes(Buffer.from(secret))),
    );
    expect(found).toEqual([]);
    // No log line holds a file's content.
    const description = String(
      (await rows("SELECT description FROM transactions LIMIT 1"))[0]?.description,
    );
    expect(lines.join("\n")).not.toContain(description);
  });

  describe("the route", () => {
    it("answers 401 with no session, 403 from another site or with no Origin, and 415 to a body that is not JSON, and uses up no code", async () => {
      const stranger = new TestBrowser(app, APP_URL, "192.168.2.1");
      const tab = await signedIn(alice);
      const [backupCode = ""] = alice.backupCodes.slice(-1);
      const body = { code: backupCode };

      const statuses = [
        (await download(stranger, body)).status,
        (await download(tab, body, { origin: "http://evil.example" })).status,
        (await download(tab, body, { origin: undefined })).status,
        (await download(tab, body, { "content-type": "text/plain" })).status,
        (await download(tab, {})).status,
      ];

      expect(statuses).toEqual([401, 403, 403, 415, 400]);
      // The backup code still works: no refused request used it up.
      const res = await download(tab, body);
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect((await download(tab, body)).status).toBe(401);
    });

    it("refuses a TOTP code used before, and takes the next step's", async () => {
      const tab = new TestBrowser(app, APP_URL, "192.168.2.2");
      const code = await alice.totpCode();
      await tab.signIn(alice);

      expect((await download(tab, { code })).status).toBe(401);
      later();
      const fresh = await alice.totpCode();
      const res = await download(tab, { code: fresh });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect((await download(tab, { code: fresh })).status).toBe(401);
    });

    it("refuses after 5 wrong codes, as sign-in does, without checking the next one", async () => {
      const tab = await signedIn(bob);
      const wrong = (await bob.totpCode()).replace(/\d/g, (digit) =>
        String((Number(digit) + 1) % 10),
      );

      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await download(tab, { code: wrong })).status);
      const refused = await download(tab, { code: await bob.totpCode() });

      expect(statuses).toEqual([401, 401, 401, 401, 401]);
      expect(refused.status).toBe(429);
      expect(refused.headers.get("content-type")).not.toBe("application/zip");
    });
  });
});

describe("a CSV cell", () => {
  it.each([
    ["=1+2", "'=1+2"],
    ["+1", "'+1"],
    ["-5 coffees", "'-5 coffees"],
    ["@SUM(A1)", "'@SUM(A1)"],
    ["\tTAB", "'\tTAB"],
    ["\rCR", '"\'\rCR"'],
    ['=HYPERLINK("x","y")', '"\'=HYPERLINK(""x"",""y"")"'],
    ["Coffee, tea", '"Coffee, tea"'],
    ["Line\nbreak", '"Line\nbreak"'],
    ["Plain", "Plain"],
  ])("writes %j as %j", (value, cell) => {
    expect(csvText(value)).toBe(cell);
  });

  it.each([
    [-1234, "-12.34"],
    [5, "0.05"],
    [-5, "-0.05"],
    [0, "0.00"],
    [123_456_789, "1234567.89"],
  ])("writes %i cents as %s, with no quote before a minus", (cents, cell) => {
    expect(csvAmount(cents)).toBe(cell);
  });
});
