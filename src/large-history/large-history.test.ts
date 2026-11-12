import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FakeBankAdapter } from "../bank/fake.ts";
import { PLAID_V2_CODES, type TxnRecord } from "../bank/index.ts";
import { newTestDatabase } from "../db/testing.ts";
import { FOLLOW_UP_STEPS, registerFollowUpStep } from "../follow-up/index.ts";
import { createLogger } from "../log.ts";
import { unlockSecrets } from "../secrets/index.ts";
import { newMasterKey } from "../secrets/testing.ts";
import { CACHE_FOLDER } from "./build.ts";
import { realNow, useHistoryClock } from "./clock.ts";
import { HISTORY_NOW } from "./history.ts";
import {
  generateHistory,
  HISTORY_FIRST_DAY,
  HISTORY_LAST_DAY,
  K7_LINES,
  LATER_DAY,
  overLimit,
  timeWork,
} from "./index.ts";
import { APP_MODULES, startModules } from "./modules.ts";
import { timingTable } from "./reporter.ts";

// The large-history generator and the timing table, without a build. `pnpm bench:history` runs the
// build and the timed cases.

const history = generateHistory();
const added = history.banks.flatMap((bank) => bank.pages.flatMap((page) => page.added ?? []));
const accounts = history.banks.flatMap((bank) => bank.accounts);
const onAccount = (id: string) => added.filter((txn) => txn.accountId === id);

describe("the large history", () => {
  it("is the same on every run", () => {
    expect(JSON.stringify(generateHistory())).toBe(JSON.stringify(history));
  });

  it("holds about 20,000 Transactions over 5 years, each with its own ID", () => {
    expect(added.length).toBeGreaterThan(19_000);
    expect(added.length).toBeLessThan(21_000);
    expect(new Set(added.map((txn) => txn.id)).size).toBe(added.length);
    const dates = added.map((txn) => txn.postedDate).sort();
    expect(dates[0]).toBe(HISTORY_FIRST_DAY);
    expect(dates.at(-1)).toBe(HISTORY_LAST_DAY);
  });

  it("has checking, savings, two credit cards, a connected loan, and an investment Account", () => {
    expect(accounts.map((snapshot) => `${snapshot.type} ${snapshot.subtype}`).sort()).toEqual([
      "credit credit card",
      "credit credit card",
      "depository checking",
      "depository savings",
      "investment brokerage",
      "loan auto",
    ]);
    for (const snapshot of accounts) expect(onAccount(snapshot.id).length).toBeGreaterThan(0);
  });

  it("holds each K7 Merchant line as the bank sends it", () => {
    const descriptions = new Set(added.map((txn) => txn.description));
    expect(K7_LINES.filter((line) => !descriptions.has(line))).toEqual([]);
  });

  it("has card payments with and without the card's last 4 digits, on both sides", () => {
    const payments = added.filter(
      (txn) => txn.category?.name === "LOAN_PAYMENTS_CREDIT_CARD_PAYMENT",
    );
    const cards = accounts.filter((snapshot) => snapshot.type === "credit");
    for (const card of cards) {
      expect(payments.some((txn) => txn.accountId === card.id && txn.amount > 0)).toBe(true);
    }
    const out = payments.filter((txn) => txn.amount < 0);
    const named = (txn: TxnRecord) =>
      cards.some((card) => txn.description.includes(`${card.mask}`));
    expect(out.some(named)).toBe(true);
    expect(out.some((txn) => !named(txn))).toBe(true);
  });

  it("has payroll Income, Transfers, ATM cash, Refunds, and monthly Recurring charges", () => {
    const count = (test: (txn: TxnRecord) => boolean) => added.filter(test).length;
    expect(count((txn) => txn.category?.name === "INCOME_SALARY")).toBeGreaterThan(200);
    expect(count((txn) => txn.description.startsWith("ONLINE TRANSFER TO SAVINGS"))).toBe(
      count((txn) => txn.description.startsWith("ONLINE TRANSFER FROM CHECKING")),
    );
    expect(count((txn) => txn.description.includes("NORTHGATE BANK"))).toBeGreaterThan(60);
    expect(count((txn) => txn.description.startsWith("ATM WITHDRAWAL"))).toBeGreaterThan(50);
    expect(count((txn) => txn.description.endsWith(" RETURN") && txn.amount > 0)).toBeGreaterThan(
      50,
    );
    expect(count((txn) => txn.description.startsWith("STREAMFLIX"))).toBe(60);
  });

  it("uses only Plaid v2 category codes", () => {
    const codes = new Set(added.flatMap((txn) => (txn.category ? [txn.category.name] : [])));
    expect([...codes].filter((code) => !PLAID_V2_CODES.includes(code))).toEqual([]);
  });

  it("changes and removes a few Transactions in the first sync's last page", () => {
    expect(history.changedIds.length).toBeGreaterThan(0);
    expect(history.removedIds.length).toBeGreaterThan(0);
    const last = history.banks.flatMap((bank) => bank.pages.at(-1) ?? {});
    expect(last.flatMap((page) => page.changed ?? []).map((txn) => txn.id)).toEqual(
      expect.arrayContaining(history.changedIds),
    );
    expect(last.flatMap((page) => (page.removed ?? []).map(({ id }) => id)).sort()).toEqual(
      [...history.removedIds].sort(),
    );

    expect(history.shown).toHaveLength(added.length - history.removedIds.length);
    for (const id of history.changedIds) {
      const before = added.find((txn) => txn.id === id);
      const after = history.shown.find((txn) => txn.id === id);
      expect(after?.amount).not.toBe(before?.amount);
    }
  });

  it("has Transfers that pairing asks about: no signal, and two equally good pairings", () => {
    const count = (description: string) =>
      added.filter((txn) => txn.description === description).length;
    expect(count("WEB XFER OUT")).toBe(10);
    expect(count("INCOMING FUNDS")).toBe(10);
    const ties = new Map<string, number>();
    for (const txn of added) {
      if (!txn.description.startsWith("ONLINE TRANSFER TO SAVINGS")) continue;
      const key = `${txn.postedDate} ${txn.amount}`;
      ties.set(key, (ties.get(key) ?? 0) + 1);
    }
    expect([...ties.values()].filter((n) => n === 2)).toHaveLength(10);
  });

  it("has one more day for a later sync", () => {
    const later = history.banks.flatMap((bank) => bank.laterPage.added ?? []);
    expect(later.length).toBeGreaterThan(0);
    expect(later.every((txn) => txn.postedDate === LATER_DAY)).toBe(true);
  });
});

describe("the timing table", () => {
  const rows = [
    { path: "GET /api/totals", ms: 211, wallMs: 1_250, limitMs: 1_000 },
    { path: "Follow-up after one more day", ms: 5_400, wallMs: 5_600, limitMs: 5_000 },
    { path: "Sync of an older build", ms: 300, limitMs: 1_000 },
  ];

  it("names each row whose CPU time is over its limit, whatever its wall time", () => {
    expect(overLimit(rows)).toEqual([
      "Follow-up after one more day: 5400 ms of CPU time, over its 5000 ms limit",
    ]);
  });

  it("prints each row's path, CPU time, wall time, and limit, and marks a row over its limit", () => {
    expect(timingTable(rows)).toBe(
      [
        "| Path | CPU time | Wall time | Limit |",
        "| --- | --: | --: | --: |",
        "| GET /api/totals | 211 ms | 1,250 ms | 1,000 ms |",
        "| Follow-up after one more day | **5,400 ms (over)** | 5,600 ms | 5,000 ms |",
        "| Sync of an older build | 300 ms | — | 1,000 ms |",
      ].join("\n"),
    );
  });

  it("times work by its CPU time, so waiting does not count, and by the wall clock too", async () => {
    const waited = await timeWork(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return "waited";
    });
    expect(waited.result).toBe("waited");
    expect(waited.wallMs).toBeGreaterThanOrEqual(190);
    expect(waited.ms).toBeLessThan(100);

    // Busy until this process has spent 200 ms of CPU time, however long a busy host takes.
    const busy = await timeWork(async () => {
      const started = process.cpuUsage();
      const spent = () => {
        const used = process.cpuUsage(started);
        return (used.user + used.system) / 1_000;
      };
      while (spent() < 200) {
        // Busy on purpose.
      }
    });
    expect(busy.ms).toBeGreaterThanOrEqual(200);
    expect(busy.wallMs).toBeGreaterThanOrEqual(busy.ms - 50);
  });

  it("marks the rows of a build made before this run", () => {
    const sync = { path: "Sync of the full history", ms: 20_000, wallMs: 21_000, limitMs: 40_000 };
    const runStarted = Date.parse("2026-11-04T18:00:00.000Z");

    const table = (timedAt: string) => timingTable([{ ...sync, timedAt }], runStarted);

    expect(table("2026-11-04T17:59:00.000Z")).toContain(
      "| Sync of the full history (cached build) | 20,000 ms | 21,000 ms | 40,000 ms |",
    );
    expect(table("2026-11-04T18:01:00.000Z")).toContain(
      "| Sync of the full history | 20,000 ms | 21,000 ms | 40,000 ms |",
    );
  });
});

// Each case runs on the history's clock, so the bench gives the same answers on any real day.
describe("the history's clock", () => {
  it("starts at HISTORY_NOW and moves at the real rate, until it is put back", async () => {
    const realClock = useHistoryClock();
    try {
      const first = Date.now();
      expect(Math.abs(first - HISTORY_NOW().getTime())).toBeLessThan(1_000);
      expect(new Date().toISOString().slice(0, 10)).toBe("2026-11-01");
      expect(Math.abs(Date.parse(Date()) - first)).toBeLessThan(2_000);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(Date.now() - first).toBeGreaterThanOrEqual(25);
      // A Date for a given time, and Date's own helpers, stay as they are.
      expect(new Date("2021-11-01T00:00:00.000Z").toISOString()).toBe("2021-11-01T00:00:00.000Z");
      expect(new Date(2021, 10, 1).getMonth()).toBe(10);
      expect(Date.UTC(2021, 10, 1)).toBe(Date.parse("2021-11-01T00:00:00.000Z"));
      expect(new Date()).toBeInstanceOf(Date);
    } finally {
      realClock();
    }
    expect(Math.abs(Date.now() - realNow())).toBeLessThan(1_000);
    expect(Math.abs(Date.now() - HISTORY_NOW().getTime())).toBeGreaterThan(1_000);
  });
});

it("caches the built history in the OS temp folder, never in the repo", () => {
  const repo = fileURLToPath(new URL("../..", import.meta.url));
  expect(relative(tmpdir(), CACHE_FOLDER).startsWith("..")).toBe(false);
  expect(relative(repo, CACHE_FOLDER).startsWith("..")).toBe(true);
});

// The app's start-up, as src/server/start.ts writes it, and every follow-up step a module
// registers, so a module or step the app adds later cannot drop out of the bench.
describe("the bench's modules", () => {
  const ROOT = fileURLToPath(new URL("../..", import.meta.url));
  // The job queue and the HTTP server: the bench runs each job itself, and sends each request in
  // process.
  const NOT_STARTED = new Set(["startApp", "startJobs", "startServer"]);

  it("are every module the app starts", () => {
    const start = readFileSync(join(ROOT, "src/server/start.ts"), "utf8");
    const called = new Set([...start.matchAll(/\b(start[A-Z]\w*)\(/g)].map((match) => match[1]));
    expect(APP_MODULES.map((appModule) => appModule.name).sort()).toEqual(
      [...called].filter((name) => name !== undefined && !NOT_STARTED.has(name)).sort(),
    );
  });

  it("register every follow-up step the app's code registers", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    const registered = new Set(
      walk(join(ROOT, "src"))
        .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
        .flatMap((path) => [
          ...readFileSync(path, "utf8").matchAll(/registerFollowUpStep\(\s*"([^"]+)"/g),
        ])
        .map((match) => match[1]),
    );
    const declared = APP_MODULES.flatMap((appModule) => appModule.step?.name ?? []);
    expect(declared.sort()).toEqual([...registered].sort());
  });

  it("register the follow-up steps the list says, once started", async () => {
    const db = await newTestDatabase();
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    const secrets = await unlockSecrets(db.database, newMasterKey().masterKey, { logger: quiet });
    const stop = startModules(APP_MODULES, {
      database: db.database,
      secrets,
      adapters: [new FakeBankAdapter()],
      startJob: async () => {},
    });
    try {
      // A step that is registered refuses a second one.
      const taken = FOLLOW_UP_STEPS.filter((name) => {
        try {
          registerFollowUpStep(name, async () => undefined)();
          return false;
        } catch {
          return true;
        }
      });
      expect(taken).toEqual(APP_MODULES.flatMap((appModule) => appModule.step?.name ?? []));
    } finally {
      stop();
      db.close();
    }
  });
});
