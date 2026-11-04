import {
  addUnconnectedAccount as addStoredAccount,
  type Database,
  listAssignedMoves,
  listUnconnectedAccounts as listStoredAccounts,
  readLastTypedBalance,
  readUnconnectedAccount,
  type StoredUnconnectedAccount,
  storeTypedBalance,
  type TypedBalance,
  updateUnconnectedAccount,
} from "../db/index.ts";
import type { UnconnectedKind } from "./unconnected-kinds.ts";

// Unconnected accounts (spec 02, Unconnected accounts and Balance estimate). Any Member adds and
// edits one at any time. Its balance is an estimate: the last typed balance, plus money moved in,
// minus money moved out, counting only the Transfers and Saving the app assigned to it after that
// date. With no typed balance, it starts at $0 on the first day of loaded history. It leaves out
// interest and market growth.

export type UnconnectedAccountInput = {
  name: string;
  kind: UnconnectedKind;
  institutionName: string | null;
  // The last 4 digits.
  mask: string | null;
};

// "typed": the balance a Member typed, which no assigned Transfer has moved since. "estimated":
// an assigned Transfer moved it, or no balance was ever typed.
export type BalanceEstimate = {
  // Whole cents. Money in the account is positive.
  balance: number;
  state: "typed" | "estimated";
  // The day of the last typed balance, or null when none was typed.
  typedOn: string | null;
};

export type UnconnectedAccount = UnconnectedAccountInput & {
  id: string;
  closed: boolean;
  estimate: BalanceEstimate;
};

// The estimate from the last typed balance and the amounts of the Transactions assigned since.
// Each amount has the connected Account's sign, so money into the Unconnected account is negative.
export function estimateBalance(
  typed: TypedBalance | undefined,
  assignedAmounts: readonly number[],
): BalanceEstimate {
  const moved = assignedAmounts.reduce((sum, amount) => sum - amount, 0);
  if (typed === undefined) return { balance: moved, state: "estimated", typedOn: null };
  const state = assignedAmounts.some((amount) => amount !== 0) ? "estimated" : "typed";
  return { balance: typed.balance + moved, state, typedOn: typed.date };
}

async function balanceEstimate(database: Database, accountId: string): Promise<BalanceEstimate> {
  const typed = await readLastTypedBalance(database, accountId);
  const moves = await listAssignedMoves(database, accountId, typed?.date);
  return estimateBalance(
    typed,
    moves.map((move) => move.amount),
  );
}

// An Unconnected account's balance over time (spec 02, Balance estimate), oldest first: the last
// typed balance on its day, then the estimate at the end of each day an assigned Transaction moved
// it. With no typed balance, the estimate starts at $0. Only a typed balance is not estimated.
export async function unconnectedBalanceSteps(
  database: Database,
  accountId: string,
): Promise<{ date: string; balance: number; estimated: boolean }[]> {
  const typed = await readLastTypedBalance(database, accountId);
  const steps = typed === undefined ? [] : [{ ...typed, estimated: false }];
  let balance = typed?.balance ?? 0;
  for (const move of await listAssignedMoves(database, accountId, typed?.date)) {
    balance -= move.amount;
    const step = { date: move.postedDate, balance, estimated: true };
    if (steps.at(-1)?.date === step.date) steps[steps.length - 1] = step;
    else steps.push(step);
  }
  return steps;
}

async function withEstimate(
  database: Database,
  account: StoredUnconnectedAccount,
): Promise<UnconnectedAccount> {
  return {
    id: account.id,
    name: account.name,
    kind: account.subtype as UnconnectedKind,
    institutionName: account.institutionName,
    mask: account.mask,
    closed: account.closedAt !== null,
    estimate: await balanceEstimate(database, account.id),
  };
}

export async function listUnconnectedAccounts(database: Database): Promise<UnconnectedAccount[]> {
  const accounts = await listStoredAccounts(database);
  return Promise.all(accounts.map((account) => withEstimate(database, account)));
}

export async function readUnconnectedAccountWithEstimate(
  database: Database,
  id: string,
): Promise<UnconnectedAccount | undefined> {
  const account = await readUnconnectedAccount(database, id);
  return account === undefined ? undefined : withEstimate(database, account);
}

// A balance a Member typed, saved with `today`, the Household's date. It overrides the estimate.
export type TypedBalanceInput = { balance: number; today: string; memberId: string; at?: Date };

const fieldsOf = (input: UnconnectedAccountInput) => ({
  name: input.name,
  subtype: input.kind,
  institutionName: input.institutionName,
  mask: input.mask,
});

async function typeBalance(database: Database, accountId: string, typed: TypedBalanceInput) {
  await storeTypedBalance(database, {
    accountId,
    date: typed.today,
    balance: typed.balance,
    typedAt: typed.at ?? new Date(),
    typedBy: typed.memberId,
  });
}

export async function addUnconnectedAccount(
  database: Database,
  input: UnconnectedAccountInput,
  typed?: TypedBalanceInput,
): Promise<UnconnectedAccount> {
  const id = await addStoredAccount(database, fieldsOf(input));
  if (typed !== undefined) await typeBalance(database, id, typed);
  const account = await readUnconnectedAccountWithEstimate(database, id);
  if (account === undefined) throw new Error("The new Unconnected account was not saved.");
  return account;
}

// Undefined when no Unconnected account has the ID.
export async function editUnconnectedAccount(
  database: Database,
  id: string,
  input: UnconnectedAccountInput,
  typed?: TypedBalanceInput,
): Promise<UnconnectedAccount | undefined> {
  if (!(await updateUnconnectedAccount(database, id, fieldsOf(input)))) return undefined;
  if (typed !== undefined) await typeBalance(database, id, typed);
  return readUnconnectedAccountWithEstimate(database, id);
}
