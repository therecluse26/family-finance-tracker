import {
  type CarryOverTransaction,
  type Database,
  type LinkMove,
  listHandLinkedOld,
  listPossibleCopies,
  moveHandLinks,
} from "../db/index.ts";
import { log } from "../log.ts";
import { loanLinkedIds } from "./other-links.ts";

// Link carry-over (spec 02, Carrying Accounts over; spec 03, Undo and hand links). Link again, or a
// new link of a removed bank, hides the old Transactions dated on or after day D as "replaced by
// re-link". A hand-made link on one of them does not end at once: it moves to that Transaction's
// new copy, a new Transaction on the same Account with the same amount and posted date, and stays
// a hand-made link. Until the copy arrives the link stays, so its other side keeps its linked
// state. When the new Connection's first history load ends with no copy, the link ends, and
// Matching runs again. An app-made link on a replaced Transaction ends as any link on a hidden
// Transaction does.

const keyOf = (txn: CarryOverTransaction) => `${txn.accountId}|${txn.amount}|${txn.postedDate}`;

// A fixed order, so the same Transactions always pair the same way.
const inOrder = (a: CarryOverTransaction, b: CarryOverTransaction) =>
  a.description.localeCompare(b.description) || a.id.localeCompare(b.id);

// Pairs each old Transaction with one new copy, one to one: the same Account, amount, and posted
// date. Within those, a copy with the same description comes first, then any copy left.
function pairCopies(
  old: readonly CarryOverTransaction[],
  copies: readonly CarryOverTransaction[],
): LinkMove[] {
  const free = new Map<string, CarryOverTransaction[]>();
  for (const copy of [...copies].sort(inOrder)) {
    const group = free.get(keyOf(copy));
    if (group === undefined) free.set(keyOf(copy), [copy]);
    else group.push(copy);
  }
  const moves: LinkMove[] = [];
  const left: CarryOverTransaction[] = [];
  const take = (txn: CarryOverTransaction, fits: (copy: CarryOverTransaction) => boolean) => {
    const group = free.get(keyOf(txn)) ?? [];
    const index = group.findIndex(fits);
    if (index === -1) return false;
    const [copy] = group.splice(index, 1);
    if (copy !== undefined) moves.push({ from: txn.id, to: copy.id });
    return copy !== undefined;
  };
  for (const txn of [...old].sort(inOrder)) {
    if (!take(txn, (copy) => copy.description === txn.description)) left.push(txn);
  }
  for (const txn of left) take(txn, () => true);
  return moves;
}

// Moves the hand-made links of old Transactions to their new copies among these Transactions,
// once per batch: one read of the copies, one of the old Transactions on their Accounts and days,
// and one write a link table. Returns the Transactions to decide again: each copy, each link's
// other side, and every Transaction linked to a Manual loan whose links moved.
export async function carryHandLinksOver(
  database: Database,
  transactionIds: readonly string[],
): Promise<string[]> {
  const copies = await listPossibleCopies(database, transactionIds);
  if (copies.length === 0) return [];
  const old = await listHandLinkedOld(database, {
    accountIds: [...new Set(copies.map((copy) => copy.accountId))],
    postedDates: [...new Set(copies.map((copy) => copy.postedDate))],
  });
  const moves = pairCopies(old, copies);
  if (moves.length === 0) return [];
  const { others, loanAccountIds } = await moveHandLinks(database, moves);
  log.info("Moved hand-made links to their new copies after a re-link", { moved: moves.length });
  return [
    ...moves.map((move) => move.to),
    ...others,
    ...(await loanLinkedIds(database, loanAccountIds)),
  ];
}
