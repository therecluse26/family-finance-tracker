import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { addUnconnectedAccount, syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { BEST_GUESS_KIND, startCategorization } from "../categorization/index.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { openReviewItems } from "../review/index.ts";
import { decideOneSidedAgain, startMoneyMovement, switchExclude } from "./index.ts";

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

  it(`settles and opens ${ITEMS} one-sided Transfer items again in a few seconds`, async () => {
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
    const asking = await ofKind("one-sided Transfer");
    expect(asking).toHaveLength(ITEMS);
    expect(asking.every((item) => item.decided.includes("Which account is this?"))).toBe(true);

    // The only Unconnected account is now each one's best answer.
    const added = await addUnconnectedAccount(bank.database, {
      name: "Pinecrest savings",
      kind: "savings",
      institutionName: "Pinecrest Bank",
      mask: "6014",
    });
    const started = performance.now();
    await decideOneSidedAgain(bank.database);
    await runFollowUp(NOW);
    const took = performance.now() - started;

    const items = await ofKind("one-sided Transfer");
    expect(items).toHaveLength(ITEMS);
    expect(items.every((item) => item.bestAnswer.value === `account ${added.id}`)).toBe(true);
    expect(took).toBeLessThan(3_000);
    process.stderr.write(`One-sided items: ${ITEMS} decided again in ${Math.round(took)} ms\n`);
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
    const guesses = (await ofKind(BEST_GUESS_KIND)).length;
    expect(guesses).toBeGreaterThan(ITEMS / 2);

    const [card] = (
      await bank.database.$client.execute(
        "SELECT id FROM household_accounts WHERE provider_account_id = 'acc-card'",
      )
    ).rows;
    const started = performance.now();
    expect(await switchExclude(bank.database, String(card?.id), true)).toBe(true);
    await runFollowUp(NOW);
    const took = performance.now() - started;

    expect(await ofKind(BEST_GUESS_KIND)).toEqual([]);
    expect(took).toBeLessThan(5_000);
    process.stderr.write(`Best-guess items: ${guesses} settled in ${Math.round(took)} ms\n`);
  }, 120_000);
});
