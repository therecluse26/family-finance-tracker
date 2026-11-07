import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addMember, newTestAuth, type TestAuth } from "../auth/testing.ts";
import { FakeBankAdapter, fakeAccount, fakeTxn } from "../bank/fake.ts";
import { startBank, syncConnection } from "../bank/index.ts";
import { addConnection, markSetupStep, setHandSetFields } from "../db/index.ts";
import { createLogger } from "../log.ts";
import { createApp } from "../server/app.ts";
import type { ReviewChoiceView, ReviewItemView } from "../server/review-views.ts";
import { loadSecurity } from "../server/security-mode.ts";
import { type App, TestBrowser } from "../server/testing.ts";
import {
  openReviewItem,
  openReviewItemBatch,
  openReviewItemsOfKind,
  type ReviewChoice,
  type ReviewItem,
  type ReviewKind,
  registerReviewKind,
  settleReviewItems,
} from "./index.ts";

// The Review list: kinds registered by their owners, items opened through the review module, and
// Members' answers through the app's HTTP interface (spec 07, Review list page). Transactions come
// from the fake adapter.

const APP_URL = "http://nas.local:8080";
const BANK = "fake-first-bank";
const KIND = "category guess";

const CATEGORIES: ReviewChoice[] = [
  { value: "restaurants", label: "Restaurants" },
  { value: "groceries", label: "Groceries" },
  { value: "coffee", label: "Coffee shops" },
];

let webRoot: string;

beforeAll(() => {
  webRoot = mkdtempSync(join(tmpdir(), "fft-review-web-"));
  writeFileSync(join(webRoot, "index.html"), "<!doctype html>");
});

afterAll(() => {
  rmSync(webRoot, { recursive: true, force: true });
});

describe("the Review list", () => {
  let test: TestAuth;
  let app: App;
  let stopBank: () => void;
  let unregister: () => void;
  let tab: TestBrowser;
  let memberId: string;
  // Transaction IDs by their fake provider IDs.
  let txns: Record<string, string>;
  // Each answer the kind applied.
  let answers: { item: ReviewItem; choice: ReviewChoice; memberId: string }[];
  let failAnswers: boolean;

  const query = async (sql: string) => (await test.database.$client.execute(sql)).rows;

  // A kind as an owner ticket registers it: "Not this" offers the Category list, and an answer sets
  // the Category on each Transaction as hand-set.
  const categoryGuess: ReviewKind = {
    async otherChoices() {
      return CATEGORIES;
    },
    async answer(item, choice, { memberId: by, database }) {
      answers.push({ item, choice, memberId: by });
      if (item.subject.type !== "transactions")
        throw new Error("A category guess is about Transactions.");
      for (const id of item.subject.transactionIds) {
        await setHandSetFields(database, id, { category: choice.value });
      }
      await duringAnswer();
      if (failAnswers) throw new Error("The answer could not be applied.");
    },
  };

  // Runs inside each answer, after its hand-set marks are written.
  let duringAnswer: () => Promise<void> = async () => {};

  const guess = (provider: string, category = CATEGORIES[0]) => {
    const best = category ?? { value: "restaurants", label: "Restaurants" };
    return openReviewItem(test.database, {
      kind: KIND,
      subject: { type: "transactions", transactionIds: [txns[provider] ?? ""] },
      decided: `The AI guessed ${best.label}, with medium confidence.`,
      bestAnswer: { value: best.value, label: `Yes, ${best.label}` },
    });
  };

  const openItems = async () => {
    const res = await tab.get("/api/review-list");
    expect(res.status).toBe(200);
    return ((await res.json()) as { items: ReviewItemView[] }).items;
  };

  const openCount = async () => {
    const res = await tab.get("/api/review-list/count");
    expect(res.status).toBe(200);
    return ((await res.json()) as { open: number }).open;
  };

  const answer = (id: string, value: string) =>
    tab.post(`/api/review-list/${id}/answer`, { value });

  const handSet = async () =>
    Object.fromEntries(
      (await query("SELECT provider_transaction_id, hand_set FROM transactions")).map((row) => [
        row.provider_transaction_id,
        JSON.parse(String(row.hand_set)),
      ]),
    );

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-03T14:00:00.000Z"));
    answers = [];
    failAnswers = false;
    duringAnswer = async () => {};
    const quiet = createLogger(() => {}, { throwOnSecretField: true });
    test = await newTestAuth(APP_URL, quiet);
    app = createApp(
      webRoot,
      await loadSecurity({ APP_URL }, { logger: quiet }),
      test.auth,
      test.database,
      test.secrets,
    );
    const fake = new FakeBankAdapter();
    stopBank = startBank({ database: test.database, secrets: test.secrets, adapters: [fake] }).stop;
    const checking = fakeAccount({ id: "acc-checking", name: "Everyday Checking" });
    fake.addPages(BANK, {
      accounts: [checking],
      added: ["t1", "t2", "t3"].map((id) =>
        fakeTxn({ id, accountId: checking.id, amount: -1_250 }),
      ),
    });
    const connectionId = await addConnection(test.database, {
      provider: "fake",
      bankId: BANK,
      bankName: "First Fake Bank",
      origin: "linked",
      syncMinute: 7,
    });
    await syncConnection(connectionId);
    txns = Object.fromEntries(
      (await query("SELECT id, provider_transaction_id FROM transactions")).map((row) => [
        String(row.provider_transaction_id),
        String(row.id),
      ]),
    );
    unregister = registerReviewKind(KIND, categoryGuess);
    await markSetupStep(test.database, "master key", "done");
    const member = await addMember(test.auth, { name: "Alice", email: "alice@example.com" });
    memberId = member.id;
    tab = new TestBrowser(app, APP_URL, "192.168.1.20");
    await tab.signIn(member);
  });

  afterEach(() => {
    unregister();
    stopBank();
    vi.useRealTimers();
    test.close();
  });

  it("opens an item with its kind, subject, the Transaction it is about, what the app decided, best answer, and time", async () => {
    const id = await guess("t1");

    expect(await openItems()).toEqual([
      {
        id,
        kind: KIND,
        subject: { type: "transactions", transactionIds: [txns.t1] },
        transactions: [
          {
            id: txns.t1,
            amount: -1_250,
            postedDate: "2026-10-09",
            authorizedDate: null,
            description: "FAKE t1",
            merchantName: null,
            accountName: "Everyday Checking",
            // Matching has not decided it, so it has no parts and no Category yet.
            categories: [],
          },
        ],
        loanName: null,
        decided: "The AI guessed Restaurants, with medium confidence.",
        bestAnswer: { value: "restaurants", label: "Yes, Restaurants" },
        createdAt: "2026-11-03T14:00:00.000Z",
        needsAi: false,
      },
    ]);
  });

  it("leaves out a Transaction that no longer shows", async () => {
    await guess("t1");
    await query("UPDATE transactions SET hidden_reason = 'removed by provider'");

    expect((await openItems())[0]?.transactions).toEqual([]);
  });

  it("holds an item about a loan", async () => {
    unregister();
    const loanItems: ReviewKind = { otherChoices: async () => [], answer: async () => {} };
    unregister = registerReviewKind("link to this loan", loanItems);

    await openReviewItem(test.database, {
      kind: "link to this loan",
      subject: { type: "loan", accountId: "loan-account" },
      decided: "This payment may belong to the Car Loan.",
      bestAnswer: { value: "link", label: "Yes, link it" },
    });

    expect((await openItems())[0]).toMatchObject({
      subject: { type: "loan", accountId: "loan-account" },
      transactions: [],
      loanName: null,
    });

    // An item about an Account the Household has shows its name.
    const [account] = await query("SELECT id FROM household_accounts");
    vi.setSystemTime(new Date("2026-11-03T15:00:00.000Z"));
    await openReviewItem(test.database, {
      kind: "link to this loan",
      subject: { type: "loan", accountId: String(account?.id) },
      decided: "No payment has linked for 2 months.",
      bestAnswer: { value: "keep", label: "Keep the loan open" },
    });

    expect((await openItems()).map((item) => item.loanName)).toEqual(["Everyday Checking", null]);
  });

  it("lists open items newest first, and counts them", async () => {
    const first = await guess("t1");
    vi.setSystemTime(new Date("2026-11-03T15:00:00.000Z"));
    const second = await guess("t2");
    vi.setSystemTime(new Date("2026-11-03T16:00:00.000Z"));
    const third = await guess("t3");

    expect((await openItems()).map((item) => item.id)).toEqual([third, second, first]);
    expect(await openCount()).toBe(3);
  });

  it("runs items made at the same moment by their Transaction's shown date, newest first, with a loan item after them", async () => {
    unregister();
    const loanItems: ReviewKind = { otherChoices: async () => [], answer: async () => {} };
    const unregisterLoan = registerReviewKind("link to this loan", loanItems);
    unregister = registerReviewKind(KIND, categoryGuess);
    // t2 posts last but shows its purchase date, the oldest of the three.
    await query(
      "UPDATE transactions SET posted_date = '2026-10-01' WHERE provider_transaction_id = 't1'",
    );
    await query(
      "UPDATE transactions SET posted_date = '2026-10-20', authorized_date = '2026-09-28' WHERE provider_transaction_id = 't2'",
    );
    await query(
      "UPDATE transactions SET posted_date = '2026-10-15' WHERE provider_transaction_id = 't3'",
    );
    const item = (transactionIds: string[]) => ({
      kind: KIND,
      subject: { type: "transactions" as const, transactionIds },
      decided: "The AI guessed Restaurants, with medium confidence.",
      bestAnswer: { value: "restaurants", label: "Yes, Restaurants" },
    });
    const [onlyT2, loan, onlyT1, t2AndT3] = await openReviewItemBatch(test.database, [
      item([txns.t2 ?? ""]),
      {
        kind: "link to this loan",
        subject: { type: "loan", accountId: "loan-account" },
        decided: "This payment may belong to the Car Loan.",
        bestAnswer: { value: "link", label: "Yes, link it" },
      },
      item([txns.t1 ?? ""]),
      // An item about two Transactions runs by the newer one, t3.
      item([txns.t2 ?? "", txns.t3 ?? ""]),
    ]);
    // An item made later comes first, whatever its Transaction's date.
    vi.setSystemTime(new Date("2026-11-03T15:00:00.000Z"));
    const later = await guess("t2");

    const order = [later, t2AndT3, onlyT1, onlyT2, loan];
    expect((await openItems()).map((open) => open.id)).toEqual(order);
    // The same order on every read.
    expect((await openItems()).map((open) => open.id)).toEqual(order);

    // A Transaction the item no longer shows does not count: with t3 hidden, the item about t2 and
    // t3 runs by t2's date, after t1.
    await query(
      "UPDATE transactions SET hidden_reason = 'posted' WHERE provider_transaction_id = 't3'",
    );
    const hidden = (await openItems()).map((open) => open.id);
    expect(hidden.slice(0, 2)).toEqual([later, onlyT1]);
    expect(hidden.at(-1)).toBe(loan);
    unregisterLoan();
  });

  // Items one follow-up job opens share their time, so they run by their Transactions' date: the
  // purchase date, else the posted date. The order is the same on every read.
  it("runs items made at the same moment by their purchase date, else their posted date, after a later moment", async () => {
    const loanItems: ReviewKind = { otherChoices: async () => [], answer: async () => {} };
    const unregisterLoan = registerReviewKind("link to this loan", loanItems);
    // t3 posted last but was bought first, so the posted date would run it first.
    for (const [id, authorized, posted] of [
      ["t1", "2026-11-01", "2026-11-02"],
      ["t2", null, "2026-10-30"],
      ["t3", "2026-10-25", "2026-11-03"],
    ] as const) {
      await test.database.$client.execute({
        sql: "UPDATE transactions SET authorized_date = ?, posted_date = ? WHERE id = ?",
        args: [authorized, posted, txns[id] ?? ""],
      });
    }
    const about = (...ids: string[]) => ({
      kind: KIND,
      subject: { type: "transactions" as const, transactionIds: ids.map((id) => txns[id] ?? "") },
      decided: "The AI guessed Restaurants, with medium confidence.",
      bestAnswer: { value: "restaurants", label: "Yes, Restaurants" },
    });
    vi.setSystemTime(new Date("2026-11-03T13:00:00.000Z"));
    const [earlier] = await openReviewItemBatch(test.database, [about("t1")]);
    vi.setSystemTime(new Date("2026-11-03T14:00:00.000Z"));
    const [bought25, loan, both, bought01] = await openReviewItemBatch(test.database, [
      about("t3"),
      {
        kind: "link to this loan",
        subject: { type: "loan", accountId: "loan-account" },
        decided: "This payment may belong to the Car Loan.",
        bestAnswer: { value: "link", label: "Yes, link it" },
      },
      // An item about two Transactions runs by the newer one.
      about("t3", "t2"),
      about("t1"),
    ]);

    const expected = [bought01, both, bought25, loan, earlier];
    expect((await openItems()).map((item) => item.id)).toEqual(expected);
    expect((await openItems()).map((item) => item.id)).toEqual(expected);
    // Items of one kind are for callers that settle or revise them: newest made first, with no
    // further order, so they skip each item's Transaction dates.
    const ofKind = (await openReviewItemsOfKind(test.database, KIND)).map((item) => item.id);
    expect([...ofKind].sort()).toEqual([bought01, both, bought25, earlier].sort());
    expect(ofKind.at(-1)).toBe(earlier);
    unregisterLoan();
  });

  it("accepts the best answer: the kind sets the hand-set marks, and the item closes", async () => {
    const id = await guess("t1");

    const res = await answer(id, "restaurants");

    expect(res.status).toBe(200);
    expect(answers).toEqual([
      expect.objectContaining({
        choice: { value: "restaurants", label: "Yes, Restaurants" },
        memberId,
      }),
    ]);
    expect(await handSet()).toEqual({ t1: { category: "restaurants" }, t2: {}, t3: {} });
    expect(await openItems()).toEqual([]);
    expect(await openCount()).toBe(0);
    expect(await query("SELECT closed_reason, answered_by FROM review_items")).toEqual([
      expect.objectContaining({ closed_reason: "answered", answered_by: memberId }),
    ]);
  });

  it("offers the other choices behind Not this, and takes one", async () => {
    const id = await guess("t2");

    const choices = await tab.get(`/api/review-list/${id}/choices`);
    expect(((await choices.json()) as { choices: ReviewChoiceView[] }).choices).toEqual(CATEGORIES);
    const res = await answer(id, "groceries");

    expect(res.status).toBe(200);
    expect(await handSet()).toEqual({ t1: {}, t2: { category: "groceries" }, t3: {} });
    expect(await openCount()).toBe(0);
  });

  it("refuses an answer that is not a choice, and an item that is not open", async () => {
    const id = await guess("t1");

    expect((await answer(id, "travel")).status).toBe(400);
    expect((await tab.post(`/api/review-list/${id}/answer`, {})).status).toBe(400);
    expect((await answer("no-such-item", "restaurants")).status).toBe(404);
    expect(await openCount()).toBe(1);

    expect((await answer(id, "restaurants")).status).toBe(200);
    expect((await answer(id, "groceries")).status).toBe(404);
    expect((await tab.get(`/api/review-list/${id}/choices`)).status).toBe(404);
    expect(answers).toHaveLength(1);
  });

  it("applies one answer when two come at once", async () => {
    const id = await guess("t1");

    const results = await Promise.all([answer(id, "restaurants"), answer(id, "groceries")]);

    expect(results.map((res) => res.status).sort()).toEqual([200, 404]);
    expect(answers).toHaveLength(1);
  });

  it("keeps an item open, with no hand-set marks, when its answer fails partway", async () => {
    const id = await guess("t1");
    failAnswers = true;

    expect((await answer(id, "restaurants")).status).toBe(500);
    expect(await openCount()).toBe(1);
    expect(await handSet()).toEqual({ t1: {}, t2: {}, t3: {} });
  });

  it("answers, and logs the error, when the work after a committed answer fails", async () => {
    unregister();
    const after = vi.fn(async () => {
      throw new Error("The follow-up job could not start.");
    });
    unregister = registerReviewKind(KIND, { ...categoryGuess, afterAnswer: after });
    const id = await guess("t1");

    const res = await answer(id, "restaurants");

    expect(res.status).toBe(200);
    expect(after).toHaveBeenCalledOnce();
    expect(await openCount()).toBe(0);
    expect(await handSet()).toEqual({ t1: { category: "restaurants" }, t2: {}, t3: {} });
  });

  it("keeps an answered result when an event settles the item during the answer", async () => {
    const id = await guess("t1");
    let settling: Promise<number> | undefined;
    duringAnswer = async () => {
      settling = settleReviewItems(
        test.database,
        { kind: KIND, subjectId: txns.t1 ?? "" },
        "A later AI answer had high confidence",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    };

    const res = await answer(id, "groceries");

    expect(res.status).toBe(200);
    expect(await settling).toBe(0);
    expect(await query("SELECT closed_reason, answer FROM review_items")).toEqual([
      {
        closed_reason: "answered",
        answer: JSON.stringify({ value: "groceries", label: "Groceries" }),
      },
    ]);
    expect(await handSet()).toEqual({ t1: { category: "groceries" }, t2: {}, t3: {} });
  });

  it("settles many Transactions in one call, and only items of that kind about them", async () => {
    const stopOther = registerReviewKind("other kind", categoryGuess);
    try {
      await guess("t1");
      await guess("t2");
      const kept = await guess("t3");
      const otherKind = await openReviewItem(test.database, {
        kind: "other kind",
        subject: { type: "transactions", transactionIds: [txns.t1 ?? ""] },
        decided: "Another kind about the same Transaction.",
        bestAnswer: { value: "groceries", label: "Yes, Groceries" },
      });

      const closed = await settleReviewItems(
        test.database,
        { kind: KIND, subjectIds: [txns.t1 ?? "", txns.t2 ?? ""] },
        "A Category rule settled it",
      );

      expect(closed).toBe(2);
      const open = await query("SELECT id FROM review_items WHERE closed_at IS NULL ORDER BY id");
      expect(open.map((row) => row.id)).toEqual([kept, otherKind].sort());
    } finally {
      stopOther();
    }
  });

  it("closes an item when a later event settles it", async () => {
    const settled = await guess("t1");
    const kept = await guess("t2");

    const closed = await settleReviewItems(
      test.database,
      { kind: KIND, subjectId: txns.t1 ?? "" },
      "A later AI answer had high confidence",
    );

    expect(closed).toBe(1);
    expect((await openItems()).map((item) => item.id)).toEqual([kept]);
    expect(
      await query(`SELECT closed_reason, answered_by FROM review_items WHERE id = '${settled}'`),
    ).toEqual([
      expect.objectContaining({
        closed_reason: "A later AI answer had high confidence",
        answered_by: null,
      }),
    ]);
    expect(answers).toEqual([]);
  });

  it("changes no totals while an item stays open, and sends no push or email", async () => {
    const before = {
      accounts: await (await tab.get("/api/accounts")).json(),
      transactions: await (await tab.get("/api/transactions")).json(),
      rows: await query("SELECT * FROM transactions ORDER BY id"),
    };

    await guess("t1");
    await guess("t2", CATEGORIES[1]);

    expect({
      accounts: await (await tab.get("/api/accounts")).json(),
      transactions: await (await tab.get("/api/transactions")).json(),
      rows: await query("SELECT * FROM transactions ORDER BY id"),
    }).toEqual(before);
    await answer((await openItems())[0]?.id ?? "", "groceries");
    expect(await query("SELECT * FROM notice_deliveries")).toEqual([]);
  });

  it("refuses an item of a kind no owner registered, or with no subject", async () => {
    await expect(
      openReviewItem(test.database, {
        kind: "unknown kind",
        subject: { type: "transactions", transactionIds: [txns.t1 ?? ""] },
        decided: "Something",
        bestAnswer: { value: "x", label: "Yes" },
      }),
    ).rejects.toThrow('No Review list kind "unknown kind"');
    await expect(
      openReviewItem(test.database, {
        kind: KIND,
        subject: { type: "transactions", transactionIds: [] },
        decided: "Something",
        bestAnswer: { value: "x", label: "Yes" },
      }),
    ).rejects.toThrow("needs its Transactions or its loan");
    expect(() => registerReviewKind(KIND, categoryGuess)).toThrow("already registered");
  });

  it("answers 403 to an answer from another site or with no Origin, and 415 to one not sent as JSON, and answers nothing", async () => {
    const id = await guess("t1");
    const path = `/api/review-list/${id}/answer`;

    for (const origin of ["http://evil.example", undefined]) {
      const res = await tab.send("POST", path, { value: "restaurants" }, { origin });
      expect(res.status, `origin ${origin}`).toBe(403);
    }
    const text = await tab.send(
      "POST",
      path,
      { value: "restaurants" },
      { "content-type": "text/plain" },
    );
    expect(text.status).toBe(415);

    expect(answers).toEqual([]);
    expect(await openCount()).toBe(1);
    expect((await handSet()).t1).toEqual({});
  });

  it("needs a session for every Review list route", async () => {
    const id = await guess("t1");
    const signedOut = new TestBrowser(app, APP_URL, "192.168.1.21");

    for (const res of [
      await signedOut.get("/api/review-list"),
      await signedOut.get("/api/review-list/count"),
      await signedOut.get(`/api/review-list/${id}/choices`),
      await signedOut.post(`/api/review-list/${id}/answer`, { value: "restaurants" }),
    ]) {
      expect(res.status).toBe(401);
    }
    expect(await openCount()).toBe(1);
  });
});
