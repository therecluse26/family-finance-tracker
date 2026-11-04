import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeAccount, fakeTxn } from "../bank/fake.ts";
import { syncConnection, type TxnRecord } from "../bank/index.ts";
import { newTestBank, type TestBank } from "../bank/testing.ts";
import { runFollowUp } from "../follow-up/index.ts";
import { linkByHand, readTransactionDecision, startMoneyMovement, undoLink } from "./index.ts";

// Pending Transactions (spec 03, Pending Transactions; spec 02, Changes to synced data): Matching
// links them at once, and their links carry over to the posted record that points back.

const NOW = () => new Date("2026-10-20T14:00:00.000Z");
const BANK = "fake-first-bank";
const CHECKING = "acc-checking";
const SAVINGS = "acc-savings";

describe("Pending Transactions", () => {
  let bank: TestBank;
  let stops: (() => void)[];
  let connectionId: string;

  const sync = async (page: { added?: TxnRecord[]; removed?: { id: string }[] }) => {
    bank.fake.addPages(BANK, {
      accounts: [
        fakeAccount({ id: CHECKING }),
        fakeAccount({ id: SAVINGS, subtype: "savings", mask: "2222" }),
      ],
      added: page.added ?? [],
      removed: page.removed ?? [],
      historyLoaded: true,
    });
    await syncConnection(connectionId, NOW);
    await runFollowUp(NOW);
  };
  const idOf = async (providerId: string) => {
    const rows = await bank.database.$client.execute({
      sql: "SELECT id FROM transactions WHERE provider_transaction_id = ?",
      args: [providerId],
    });
    return String(rows.rows[0]?.id);
  };
  // Each Transfer link, by its sides' provider IDs, with who made it.
  const transferLinks = async () => {
    const rows = await bank.database.$client.execute(
      `SELECT o.provider_transaction_id AS out_id, i.provider_transaction_id AS in_id, l.made_by
       FROM transfer_links l
       JOIN transactions o ON o.id = l.out_transaction_id
       JOIN transactions i ON i.id = l.in_transaction_id
       ORDER BY out_id`,
    );
    return rows.rows.map((row) => ({ ...row }));
  };
  const typeOf = async (providerId: string) =>
    (await readTransactionDecision(bank.database, await idOf(providerId)))?.parts.map(
      (part) => part.type,
    );
  const out = (id: string, amount: number, pending = true) =>
    fakeTxn({
      id,
      accountId: CHECKING,
      amount: -amount,
      postedDate: "2026-10-05",
      description: "TRANSFER TO SAVINGS 2222",
      pending,
    });
  const into = (id: string, amount: number, pending = true) =>
    fakeTxn({ id, accountId: SAVINGS, amount, postedDate: "2026-10-05", pending });
  // The posted record that takes the pending one's place.
  const posted = (txn: TxnRecord, fields: Partial<TxnRecord> = {}) => ({
    ...txn,
    id: `${txn.id}-posted`,
    pending: false,
    pendingTransactionId: txn.id,
    postedDate: "2026-10-07",
    ...fields,
  });

  beforeEach(async () => {
    bank = await newTestBank();
    stops = [startMoneyMovement({ database: bank.database }).stop];
    connectionId = await bank.connect(BANK);
  });

  afterEach(() => {
    for (const stop of stops.reverse()) stop();
    bank.close();
  });

  it("links a pending Transfer pair at once, and keeps the link when it posts", async () => {
    const sent = out("sent", 50_000);
    const received = into("received", 50_000);
    await sync({ added: [sent, received] });

    expect(await transferLinks()).toEqual([{ out_id: "sent", in_id: "received", made_by: "app" }]);
    expect(await typeOf("sent")).toEqual(["Transfer"]);

    await sync({
      added: [posted(sent), posted(received)],
      removed: [{ id: "sent" }, { id: "received" }],
    });

    expect(await transferLinks()).toEqual([
      { out_id: "sent-posted", in_id: "received-posted", made_by: "app" },
    ]);
    expect(await typeOf("sent-posted")).toEqual(["Transfer"]);
    expect(await typeOf("received-posted")).toEqual(["Transfer"]);
    const hidden = await bank.database.$client.execute(
      "SELECT provider_transaction_id AS id, hidden_reason FROM transactions WHERE pending = 1",
    );
    expect(hidden.rows.map((row) => ({ ...row }))).toEqual([
      { id: "sent", hidden_reason: "posted" },
      { id: "received", hidden_reason: "posted" },
    ]);
    // A hidden Transaction has no result.
    expect(await readTransactionDecision(bank.database, await idOf("sent"))).toBeUndefined();
  });

  it("carries a Member's link on pending Transactions to the posted ones", async () => {
    const sent = out("sent", 50_000);
    const received = into("also-received", 50_000);
    // Two $500s into savings: the Member links the one the app did not pick.
    await sync({ added: [sent, into("received", 50_000), received] });
    expect(await transferLinks()).toEqual([{ out_id: "sent", in_id: "received", made_by: "app" }]);
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    const made = await linkByHand(
      bank.database,
      {
        kind: "Transfer",
        outTransactionId: await idOf("sent"),
        inTransactionId: await idOf("also-received"),
      },
      "member-1",
      NOW(),
    );
    expect(made.outcome).toBe("linked");
    await runFollowUp(NOW);

    await sync({
      added: [posted(sent), posted(received)],
      removed: [{ id: "sent" }, { id: "also-received" }],
    });

    expect(await transferLinks()).toEqual([
      { out_id: "sent-posted", in_id: "also-received-posted", made_by: "Member" },
    ]);
    expect(await typeOf("sent-posted")).toEqual(["Transfer"]);
  });

  it("ends a carried link whose posted amount breaks its hard filters, and matches again", async () => {
    const sent = out("sent", 50_000);
    const received = into("received", 50_000);
    await sync({
      added: [sent, received, { ...into("other", 52_000, false), postedDate: "2026-10-07" }],
    });
    expect(await transferLinks()).toEqual([{ out_id: "sent", in_id: "received", made_by: "app" }]);

    // The money out posts for $520: the pair no longer has the same amount.
    await sync({ added: [posted(sent, { amount: -52_000 })], removed: [{ id: "sent" }] });

    expect(await transferLinks()).toEqual([
      { out_id: "sent-posted", in_id: "other", made_by: "app" },
    ]);
    expect(await typeOf("received")).toEqual(["Income"]);
  });

  it("puts a posted record with no pointer back through matching", async () => {
    const sent = out("sent", 50_000);
    const received = into("received", 50_000);
    await sync({ added: [sent, received] });

    // The bank removes the pending records, and adds posted ones that do not point back.
    await sync({
      added: [
        posted(sent, { pendingTransactionId: null }),
        posted(received, { pendingTransactionId: null }),
      ],
      removed: [{ id: "sent" }, { id: "received" }],
    });

    expect(await transferLinks()).toEqual([
      { out_id: "sent-posted", in_id: "received-posted", made_by: "app" },
    ]);
    const hidden = await bank.database.$client.execute(
      "SELECT hidden_reason FROM transactions WHERE pending = 1",
    );
    expect(hidden.rows.map((row) => row.hidden_reason)).toEqual([
      "removed by provider",
      "removed by provider",
    ]);
  });

  it("never makes an undone link again on the posted record", async () => {
    const sent = out("sent", 50_000);
    const received = into("received", 50_000);
    await sync({ added: [sent, received] });
    const linkId = (await bank.database.$client.execute("SELECT id FROM transfer_links")).rows.map(
      (row) => String(row.id),
    )[0];
    await bank.database.$client.execute(
      `INSERT INTO members (id, name, email, created_at, updated_at)
       VALUES ('member-1', 'Jamie', 'jamie@example.com', '2026-10-01T00:00:00.000Z',
         '2026-10-01T00:00:00.000Z')`,
    );
    expect(await undoLink(bank.database, linkId ?? "", "member-1", NOW())).toBe(true);
    await runFollowUp(NOW);

    await sync({
      added: [posted(sent), posted(received)],
      removed: [{ id: "sent" }, { id: "received" }],
    });

    expect(await transferLinks()).toEqual([]);
    expect(await typeOf("received-posted")).toEqual(["Income"]);
  });
});
