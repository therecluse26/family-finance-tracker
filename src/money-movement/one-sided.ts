import { UNCONNECTED } from "../bank/unconnected-kinds.ts";
import {
  type Database,
  type DecisionAccount,
  listDecisionAccounts,
  setHandSetFields,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain } from "../follow-up/index.ts";
import type { ReviewChoice, ReviewKind } from "../review/index.ts";
import { addBusinessDays } from "./business-days.ts";
import type { Decision, DecisionInput } from "./order.ts";
import { isInvestment } from "./pairs.ts";
import { namesInstitutionIn, namesMask } from "./transfers.ts";
import type { TransactionType } from "./types.ts";

// One-sided Transfers and Saving, steps 5.6 and 6.7 (spec 03, One side missing, Unconnected
// accounts, Saving). A Transaction with no pair that has transfer wording or a Plaid transfer
// category goes to one Unconnected account, or counts as Saving. Pairing and every earlier step
// have had their turn, so a code an earlier step claims, such as TRANSFER_OUT_WITHDRAWAL, never
// gets here once that step's rule is registered.

// Transfer wording: "transfer" or "xfer", in any case. A Plaid transfer category: any
// TRANSFER_IN_* or TRANSFER_OUT_* code.
const TRANSFER_WORDING = /transfer|xfer/i;
const TRANSFER_CODE = /^TRANSFER_(IN|OUT)_/;

export const ONE_SIDED_STEPS = ["5.6", "6.7"] as const;

// With no account named, these codes make Saving with no account. Money in under the last one
// reduces Saving.
const SAVING_CODES = new Set([
  "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
  "TRANSFER_OUT_CRYPTO",
  "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",
]);

// One-sided results are provisional until the longest window that could apply has passed: a
// Transfer between two banks, 5 business days (spec 03, Windows). A pair found inside the window
// replaces them. Undefined once the window has passed.
const ONE_SIDED_WINDOW = 5;

export function oneSidedUntil(txn: { postedDate: string; today: string }): string | undefined {
  const until = addBusinessDays(txn.postedDate, ONE_SIDED_WINDOW);
  return until >= txn.today ? until : undefined;
}

// The accounts a one-sided Transfer may go to: the Unconnected accounts, and the synced
// investment Accounts, which count like one of kind "investment or retirement".
function standsIn(account: DecisionAccount): boolean {
  return (account.kind === UNCONNECTED && !account.connected) || isInvestment(account);
}

// The account's kind decides the type: "investment or retirement" makes Saving; "savings", "HSA",
// and "other" make a Transfer. Money to an HSA is never Saving.
function typeFor(account: DecisionAccount): TransactionType {
  return isInvestment(account) || account.subtype === "investment or retirement"
    ? "Saving"
    : "Transfer";
}

// The one account whose last 4 digits, or else whose institution name, the description holds.
// Two accounts that both fit tie, and neither is named.
function namedIn(description: string, accounts: readonly DecisionAccount[]) {
  const byMask = accounts.filter((account) => namesMask(description, account.mask));
  if (byMask.length === 1) return byMask[0];
  const byName = (byMask.length > 1 ? byMask : accounts).filter((account) =>
    namesInstitutionIn(description, account.institutionName),
  );
  return byName.length === 1 ? byName[0] : undefined;
}

// The Review list kind for a one-sided Transfer not tied to an account by its name or last 4
// digits (spec 03, Review list items). It may be Spending, such as rent paid by transfer.
export const ONE_SIDED_KIND = "one-sided Transfer";

const PICK = "account ";
const KEEP: ReviewChoice = { value: "keep", label: "Keep it as a Transfer" };
const NOT_A_TRANSFER: ReviewChoice = { value: "not a transfer", label: "Not a Transfer" };

// Steps 5.6 and 6.7. The first case that fits wins:
// 1. The account a Member picked on the Review list.
// 2. The account the description names.
// 3. Saving with no account, for an investment or crypto code.
// 4. The Household's only account, with a Review list item to confirm it.
// 5. A Transfer with no account, with the item "Which account is this?".
// A Closed account can still be named or picked, but is never the only one.
export function oneSidedTransfer(txn: DecisionInput): Decision | undefined {
  const code = txn.providerCategory ?? "";
  if (!TRANSFER_WORDING.test(txn.description) && !TRANSFER_CODE.test(code)) return undefined;
  const until = oneSidedUntil(txn);
  const result = (
    type: TransactionType,
    account?: DecisionAccount,
    asks?: Decision["asks"],
  ): Decision => ({
    parts: [{ type, amount: txn.amount, category: null }],
    ...(until === undefined ? {} : { provisionalUntil: until }),
    ...(account === undefined ? {} : { unconnectedAccountId: account.id }),
    ...(asks === undefined ? {} : { asks }),
  });
  const accounts = [...txn.accounts.values()].filter(
    (account) => account.id !== txn.accountId && standsIn(account),
  );
  const picked = accounts.find((account) => account.id === txn.handSet.unconnectedAccount);
  if (picked !== undefined) return result(typeFor(picked), picked);
  const named = namedIn(txn.description, accounts);
  if (named !== undefined) return result(typeFor(named), named);
  if (SAVING_CODES.has(code)) return result("Saving");
  const open = accounts.filter((account) => !account.closed);
  const [only] = open;
  if (open.length === 1 && only !== undefined) {
    return result(typeFor(only), only, {
      decided: `It names no account, so the app put it in ${only.name}, the only one.`,
      bestAnswer: { value: `${PICK}${only.id}`, label: `Yes, ${only.name}` },
    });
  }
  return result("Transfer", undefined, {
    decided: "It names no account, so it counts as a Transfer. Which account is this?",
    bestAnswer: KEEP,
  });
}

// A Member answers: picks an account, or adds one and then picks it, or chooses "Not a
// Transfer", which sets the type to Spending by hand. Keeping it as a Transfer sets that type by
// hand. The choices are read when the Member opens them, so an account added since is among them.
// The follow-up job then decides the Transaction again.
export function oneSidedKind(database: Database): ReviewKind {
  return {
    async otherChoices() {
      const accounts = (await listDecisionAccounts(database)).filter(standsIn);
      return [
        ...accounts.map((account) => ({ value: `${PICK}${account.id}`, label: account.name })),
        NOT_A_TRANSFER,
      ];
    },
    async answer(item, choice, answering) {
      if (item.subject.type !== "transactions") {
        throw new Error("A one-sided Transfer item is about a Transaction.");
      }
      const fields =
        choice.value === NOT_A_TRANSFER.value
          ? { type: "Spending" }
          : choice.value === KEEP.value
            ? { type: "Transfer" }
            : { unconnectedAccount: choice.value.slice(PICK.length) };
      for (const id of item.subject.transactionIds) {
        await setHandSetFields(answering.database, id, fields);
      }
      await followUpAgain(answering.database, item.subject.transactionIds);
    },
    afterAnswer: () => askForFollowUp(),
  };
}
