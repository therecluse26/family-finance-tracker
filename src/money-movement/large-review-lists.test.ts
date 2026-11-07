import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { addUnconnectedAccount, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { BEST_GUESS_KIND, startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { answerReviewItem, openReviewItems } from "../review/index.ts";
import {
  decideOneSidedAgain,
  deleteTransferAnswer,
  startMoneyMovement,
  switchExclude,
  transferAnswerViews,
} from "./index.ts";

// Review list items on a large history. When the Household's accounts change, every result they
// touch is decided again, and its Review list items settle and open again in one batch, never with
// a read of every open item for each Transaction (spec 03, Unconnected accounts; spec 02, Exclude;
// spec 07, Review list page).

const NOW = () => new Date("2026-11-01T14:00:00.000Z");
const CHECKING = fakeAccount({ id: "acc-checking", name: "Everyday Checking", mask: "4417" });
const CARD = fakeAccount({
  id: "acc-card",
  name: "Everyday Card",
  mask: "7731",
  type: "credit",
  subtype: "credit card",
});
const ITEMS = 2_500;
const day = (n: number) => new Date(Date.UTC(2020, 0, 1 + n)).toISOString().slice(0, 10);

describe("Review list items on a large history", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const load = async (added: TxnRecord[]) => {
    bank.fake.addPages("fake-first-bank", {
      accounts: [CHECKING, CARD],
      added,
      historyLoaded: true,
    });
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const ofKind = async (kind: string) =>
    (await openReviewItems(bank.database)).filter((item) => item.kind === kind);

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [
      startMoneyMovement({ database: bank.database }).stop,
      startCategorization({ database: bank.database }).stop,
    ];
    connectionId = await bank.connect("fake-first-bank");
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  // CPU time, which a busy host does not stretch.
  const timed = async (work: () => Promise<unknown>) => {
    const started = process.cpuUsage();
    await work();
    const used = process.cpuUsage(started);
    return (used.user + used.system) / 1_000;
  };
  const cardIds = (items: { subject: { type: string } }[]) =>
    items.flatMap((item) =>
      "transactionIds" in item.subject ? (item.subject.transactionIds as string[]) : [],
    );

  it(`groups ${ITEMS} one-sided Transfers on one card, answers it, and deletes the remembered answer, each in a few seconds`, async () => {
    await load(
      Array.from({ length: ITEMS }, (_, n) =>
        fakeTxn({
          id: `out-${n}`,
          accountId: CHECKING.id,
          amount: -(1_000 + n),
          postedDate: day(Math.floor(n / 2)),
          description: `ONLINE TRANSFER REF ${100_000 + n}`,
        }),
      ),
    );
    // One card: the reference numbers are no account number, so every line has one key.
    const asking = await ofKind("one-sided Transfer");
    expect(asking).toHaveLength(1);
    expect(cardIds(asking)).toHaveLength(ITEMS);
    expect(asking[0]?.decided).toContain("Which account is this?");

    // The only Unconnected account is now the card's best answer.
    const added = await addUnconnectedAccount(bank.database, {
      name: "Pinecrest savings",
      kind: "savings",
      institutionName: "Pinecrest Bank",
      mask: "6014",
    });
    const again = await timed(async () => {
      await decideOneSidedAgain(bank.database);
      await runFollowUp(NOW);
    });
    const [card] = await ofKind("one-sided Transfer");
    expect(cardIds([card ?? { subject: { type: "loan" } }])).toHaveLength(ITEMS);
    expect(card?.bestAnswer.value).toBe(`account ${added.id}`);
    expect(again).toBeLessThan(3_000);

    // The answer covers the card in a few statements, and the follow-up job decides them again.
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('m', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    const answered = await timed(async () => {
      expect(await answerReviewItem(bank.database, card?.id ?? "", `account ${added.id}`, "m")).toBe(
        "answered",
      );
      await runFollowUp(NOW);
    });
    expect(await ofKind("one-sided Transfer")).toEqual([]);
    const assigned = await bank.database.$client.execute(
      "SELECT count(*) AS n FROM unconnected_assignments WHERE account_id = ?",
      [added.id],
    );
    expect(Number(assigned.rows[0]?.n)).toBe(ITEMS);
    expect(answered).toBeLessThan(5_000);

    // Deleting the remembered answer sends them all back, and they ask again on one card.
    const [answer] = await transferAnswerViews(bank.database);
    const deleted = await timed(async () => {
      expect(await deleteTransferAnswer(bank.database, answer?.id ?? "")).toBe(true);
      await runFollowUp(NOW);
    });
    expect(cardIds(await ofKind("one-sided Transfer"))).toHaveLength(ITEMS);
    expect(deleted).toBeLessThan(5_000);
    process.stderr.write(
      `One-sided card of ${ITEMS}: decided again ${Math.round(again)} ms, answered ${Math.round(answered)} ms, answer deleted ${Math.round(deleted)} ms\n`,
    );
  }, 120_000);

  it(`settles ${ITEMS} best-guess items in a few seconds when their card is excluded`, async () => {
    await load(
      Array.from({ length: ITEMS }, (_, n) =>
        fakeTxn({
          id: `buy-${n}`,
          accountId: CARD.id,
          amount: -(500 + n),
          postedDate: day(Math.floor(n / 2)),
          description: `PURCHASE ${n} ZQX VENDOR ${n}`,
        }),
      ),
    );
    // The Transactions on the best-guess cards.
    const guesses = (await ofKind(BEST_GUESS_KIND)).flatMap((item) =>
      item.subject.type === "transactions" ? item.subject.transactionIds : [],
    ).length;
    expect(guesses).toBeGreaterThan(ITEMS / 2);

    const [card] = (
      await bank.database.$client.execute(
        "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-card'",
      )
    ).rows;
    // CPU time, which a busy host does not stretch.
    const started = process.cpuUsage();
    expect(await switchExclude(bank.database, String(card?.id), true)).toBe(true);
    await runFollowUp(NOW);
    const used = process.cpuUsage(started);
    const took = (used.user + used.system) / 1_000;

    expect(await ofKind(BEST_GUESS_KIND)).toEqual([]);
    expect(took).toBeLessThan(5_000);
    process.stderr.write(`Best-guess items: ${guesses} settled in ${Math.round(took)} ms\n`);
  }, 120_000);
});
