import { UNCONNECTED } from "../bank/unconnected-kinds.ts";
import {
  type Database,
  type DecisionAccount,
  listDecisionAccounts,
  readCardFacts,
  setHandSetFields,
  storeTransferAnswer,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain } from "../follow-up/index.ts";
import { log } from "../log.ts";
import { paymentAppLine } from "../merchants/index.ts";
import { NotAChoice, type ReviewKind } from "../review/index.ts";
import { addBusinessDays } from "./business-days.ts";
import {
  askedText,
  KEEP,
  keyText,
  NOT_A_TRANSFER,
  ONE_SIDED_KIND,
  ONE_SIDED_STEPS,
  oneSidedKeyOf,
  PICK,
  stillOnCard,
} from "./one-sided-cards.ts";
import type { Decision, DecisionInput } from "./order.ts";
import { isInvestment } from "./pairs.ts";
import { namesInstitutionIn, namesMask } from "./transfers.ts";
import type { TransactionType } from "./types.ts";

export { ONE_SIDED_KIND, ONE_SIDED_STEPS };

// One-sided Transfers and Saving, steps 5.6 and 6.7 (spec 03, One side missing, Unconnected
// accounts, Saving). A Transaction with no pair that has transfer wording or a Plaid transfer
// category goes to one Unconnected account, or counts as Saving. Pairing and every earlier step
// have had their turn, so a code an earlier step claims, such as TRANSFER_OUT_WITHDRAWAL, never
// gets here. A payment-app line never does either: a payment app is never an Unconnected account.
// Steps 5.4, 6.3, and 6.6 tie their one-sided Transfers to an account the same way.

// Transfer wording: "transfer" or "xfer", in any case. A Plaid transfer category: any
// TRANSFER_IN_* or TRANSFER_OUT_* code.
const TRANSFER_WORDING = /transfer|xfer/i;
const TRANSFER_CODE = /^TRANSFER_(IN|OUT)_/;

// With no account named, these codes make Saving with no account. Money in under the last one
// reduces Saving.
const SAVING_CODES = new Set([
  "TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS",
  "TRANSFER_OUT_CRYPTO",
  "TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS",
]);

// One-sided results are provisional until the longest window that could apply has passed: a
// Transfer between two banks, 5 business days (spec 03, Windows). A pair found inside the window
// replaces them. Undefined once the window has passed. A rule whose longest route is shorter, such
// as a card payment's, passes its own window.
const ONE_SIDED_WINDOW = 5;

export function oneSidedUntil(
  txn: { postedDate: string; today: string },
  window = ONE_SIDED_WINDOW,
): string | undefined {
  const until = addBusinessDays(txn.postedDate, window);
  return until >= txn.today ? until : undefined;
}

const isUnconnected = (account: DecisionAccount) =>
  account.kind === UNCONNECTED && !account.connected;

// The accounts a one-sided Transfer may go to: the Unconnected accounts, the synced investment
// Accounts, which count like one of kind "investment or retirement", and the excluded Accounts,
// which count as Unconnected accounts (spec 03, Transaction types).
function standsIn(account: DecisionAccount): boolean {
  return isUnconnected(account) || isInvestment(account) || account.excluded;
}

// The account's kind decides the type: "investment or retirement" makes Saving; "savings", "HSA",
// and "other" make a Transfer. Money to an HSA is never Saving. Money to or from an excluded
// Account is always a Transfer.
function typeFor(account: DecisionAccount): TransactionType {
  if (account.excluded) return "Transfer";
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

// Steps 5.6 and 6.7: transfer wording or a Plaid transfer category, on a line that is no
// payment-app line.
export function oneSidedTransfer(txn: DecisionInput): Decision | undefined {
  const code = txn.providerCategory ?? "";
  if (!TRANSFER_WORDING.test(txn.description) && !TRANSFER_CODE.test(code)) return undefined;
  if (paymentAppLine(txn) !== undefined) return undefined;
  return toUnconnectedAccount(txn);
}

// Ties a one-sided Transfer to one account. The first case that fits wins:
// 1. The account a Member picked on the Review list.
// 2. The account the description names.
// 3. The answer a Member gave a card with the same key, remembered (spec 03, Review list items):
//    its account, while it may still be picked, a Transfer with no account, or Spending.
// 4. Saving with no account, for an investment or crypto code.
// 5. The Household's only Unconnected account, with a Review list item to confirm it.
// 6. A Transfer with no account, with the item "Which account is this?".
// A Closed account can still be named or picked, but is never the only one. A synced investment
// Account or an excluded Account can be named or picked too, but is never the only one: it syncs,
// so money to it shows on its own side as well.
export function toUnconnectedAccount(txn: DecisionInput, window = ONE_SIDED_WINDOW): Decision {
  const code = txn.providerCategory ?? "";
  const until = oneSidedUntil(txn, window);
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
  const key = oneSidedKeyOf(txn);
  const remembered = key === null ? undefined : txn.transferAnswers?.get(keyText(key));
  if (remembered?.answer === "keep") return result("Transfer");
  if (remembered?.answer === "not a transfer") return result("Spending");
  if (remembered?.answer === "account") {
    const kept = accounts.find((account) => account.id === remembered.accountId);
    if (kept !== undefined) return result(typeFor(kept), kept);
  }
  if (SAVING_CODES.has(code)) return result("Saving");
  const open = accounts.filter((account) => !account.closed && isUnconnected(account));
  const [only] = open;
  if (open.length === 1 && only !== undefined) {
    const bestAnswer = { value: `${PICK}${only.id}`, label: `Yes, ${only.name}` };
    return result(typeFor(only), only, { decided: askedText(bestAnswer, 1), bestAnswer });
  }
  return result("Transfer", undefined, { decided: askedText(KEEP, 1), bestAnswer: KEEP });
}

// A Member answers a card: picks an account, or adds one and then picks it, keeps it as a
// Transfer, or chooses "Not a Transfer", which makes it Spending. The answer is remembered for the
// card's key, so it covers every Transaction still on the card and each later one with that key,
// and the follow-up job decides those on the card again. A card of a line with no clean Merchant
// name has no key: the answer sets that Transaction's hand-set fields, as a type or account a
// Member sets by hand. The choices are read when the Member opens them, so an account added since
// is among them; an account that may no longer be picked is no choice.
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
      const tx = answering.database;
      const accountId = choice.value.startsWith(PICK) ? choice.value.slice(PICK.length) : null;
      if (
        accountId !== null &&
        !(await listDecisionAccounts(tx)).some(
          (account) => account.id === accountId && standsIn(account),
        )
      ) {
        throw new NotAChoice("This account can no longer be picked.");
      }
      // Only the Transactions still on the card, read inside the answer's transaction: one a
      // Member changed on its row, or one that left since the card's last update, keeps what it
      // has, in either order.
      const { key, ids, others } = stillOnCard(
        await readCardFacts(tx, item.subject.transactionIds),
      );
      if (ids.length === 0) {
        log.info("A one-sided Transfer card's answer found none of its Transactions still on it");
        return;
      }
      const answer =
        choice.value === NOT_A_TRANSFER.value
          ? "not a transfer"
          : choice.value === KEEP.value
            ? "keep"
            : "account";
      if (key === null) {
        const fields =
          answer === "not a transfer"
            ? { type: "Spending" }
            : answer === "keep"
              ? { type: "Transfer" }
              : { unconnectedAccount: accountId };
        for (const id of ids) await setHandSetFields(tx, id, fields);
      } else {
        await storeTransferAnswer(tx, {
          merchantKey: key.merchantKey,
          merchantName: key.merchantName,
          lastFours: key.lastFours,
          answer,
          accountId,
          madeAt: new Date(),
          madeBy: answering.memberId,
        });
      }
      await followUpAgain(tx, [...ids, ...others]);
    },
    afterAnswer: () => askForFollowUp(),
  };
}
