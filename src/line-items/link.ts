import {
  addReviewItems,
  closeReviewItemsIn,
  closeShipmentReviewItems,
  type Database,
  deleteRefusedLineItemLinks,
  type LinkingItem,
  type LinkTransaction,
  listAwaitingCopies,
  listShipmentsToLink,
  type Queries,
  readAccountMasks,
  readAmazonCandidates,
  readHeldShipments,
  readItemsHeldBy,
  readLinkedTransactions,
  readLinkingItems,
  readLinkTransactions,
  readOpenShipmentItems,
  readRefusedLineItemLinks,
  readShipmentItems,
  readShownTransactions,
  type ShipmentTarget,
  type ShipmentToLink,
  shipmentAnswerValue,
  shipmentOfAnswer,
  storeLineItemLinks,
  storeRefusedLineItemLinks,
  unlinkLineItems,
} from "../db/index.ts";
import { askForFollowUp, followUpAgain, registerFollowUpStep } from "../follow-up/index.ts";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../format.ts";
import { householdTimeZone } from "../household/index.ts";
import { log } from "../log.ts";
import { merchantKey } from "../merchants/index.ts";
import {
  NotAChoice,
  type ReviewItem,
  type ReviewKind,
  registerReviewKind,
} from "../review/index.ts";
import { registerLineItemsImported, registerLineItemsRemoved } from "./seams.ts";

// Linking Amazon shipments to the card Transactions that paid for them (spec 14, Linking Line items
// to Transactions). Amazon charges a card when it ships, so the app links by shipment: one order's
// Line items with one ship time.
// - The app's link: an unlinked shipment and exactly one Spending charge that fits it. Two or more
//   that fit put a Review list item up. None waits, and counts as "not matched" 60 days after the
//   ship date.
// - A Member links a shipment by hand, and undoes any link. The app never makes an undone link
//   again.
// - When the bank removes, hides, or changes a Transaction, its links end as the spec says.
// Every link change makes its Transactions unhandled in the same transaction, so the cascade remakes
// their parts.

// The Review list kind of an Amazon shipment that fits two or more Transactions (spec 14, Review
// list items).
export const AMAZON_SHIPMENT_KIND = "Amazon shipment";

// An unlinked shipment waits for a charge until this many days after its ship date.
export const WAITING_DAYS = 60;

const DAY_MS = 86_400_000;

export const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

// The first ship date of a shipment that still waits for a charge today.
export const waitingFrom = (today: string) => addDays(today, -(WAITING_DAYS - 1));

// A purchase date from 1 day before to 7 days after the ship date.
const DAYS_BEFORE_SHIP = 1;
export const DAYS_AFTER_SHIP = 7;

// Amazon's Merchant, by Merchant identity: its clean name compared without case, spaces, or
// punctuation (spec 04, Identity). A bank line with AMAZON or AMZN counts too.
const AMAZON_MERCHANTS = new Set(
  [
    "Amazon",
    "Amazon.com",
    "Amazon Marketplace",
    "Amazon Mktp",
    "Amazon Mktplace",
    "Amzn Mktp",
    "Amzn Mktp US",
  ].map(merchantKey),
);

export function isAmazonCharge(txn: {
  description: string;
  merchantCleanName: string | null;
}): boolean {
  return (
    (txn.merchantCleanName !== null && AMAZON_MERCHANTS.has(merchantKey(txn.merchantCleanName))) ||
    /AMAZON|AMZN/i.test(txn.description)
  );
}

// One shipment as a run sees it.
type Shipment = {
  key: string;
  orderId: string;
  shipTime: string;
  shipDate: string;
  total: number;
  cardLast4: string | null;
  giftCard: boolean;
  items: LinkingItem[];
};

const shipmentKey = (orderId: string, shipTime: string) => `${orderId}|${shipTime}`;
const refusalKey = (orderId: string, shipTime: string, transactionId: string) =>
  `${orderId}|${shipTime}|${transactionId}`;

function shipmentsOf(items: readonly LinkingItem[]): Map<string, Shipment> {
  const shipments = new Map<string, Shipment>();
  for (const item of items) {
    const key = shipmentKey(item.orderId, item.shipTime);
    const found = shipments.get(key);
    if (found === undefined) {
      shipments.set(key, {
        key,
        orderId: item.orderId,
        shipTime: item.shipTime,
        shipDate: item.shipDate,
        total: item.total,
        cardLast4: item.cardLast4,
        giftCard: item.giftCard,
        items: [item],
      });
      continue;
    }
    found.items.push(item);
    found.total += item.total;
    found.giftCard ||= item.giftCard;
    found.cardLast4 ??= item.cardLast4;
    if (item.shipDate < found.shipDate) found.shipDate = item.shipDate;
  }
  return shipments;
}

// What a run is for: after an import, every unlinked shipment is tried. In a follow-up job, a
// shipment is tried while it waits for a charge, when one of its fits is new or changed, or when
// its link just ended.
export type LinkRunScope = { after: "import" } | { after: "sync"; unhandled: ReadonlySet<string> };

// A link the app plans: a shipment, or a whole order, and the one Transaction that fits it.
type Planned = { target: ShipmentTarget; shipments: Shipment[]; transactionId: string };

// What a run changed: the Transactions whose links it made or ended.
export type LinkRunResult = { linked: number; ended: number; transactionIds: string[] };

// One link run (spec 14, The app's link): it ends the links the bank's changes end, then links each
// unlinked shipment that exactly one Spending charge fits. It reads each table once, and writes
// in two transactions: the ended links, then the new links and the Review list items. A run that
// changes nothing writes nothing, so it marks no Transaction and starts no job.
export async function runLinking(
  database: Database,
  scope: LinkRunScope,
  now: Date,
): Promise<LinkRunResult> {
  const items = await readLinkingItems(database, "amazon");
  if (items.length === 0) return { linked: 0, ended: 0, transactionIds: [] };
  const zone = (await householdTimeZone(database)) ?? "UTC";
  const today = calendarDateIn(now, zone);
  const shipments = shipmentsOf(items);

  // The links the bank's changes end (spec 14, When the bank changes the Transaction).
  const ending = await linksToEnd(database, items, shipments);
  const filled = handLinksToFill(shipments, ending);
  const endedIds = new Set<string>();
  if (ending.size > 0 || filled.size > 0) {
    const touched = [...new Set([...ending.values(), ...filled.values()])];
    await database.transaction(async (tx) => {
      await unlinkLineItems(tx, ending);
      await storeLineItemLinks(tx, filled, "hand");
      await followUpAgain(tx, touched);
    });
    for (const id of ending.values()) endedIds.add(id);
  }
  const justUnlinked = new Set<string>();
  for (const item of items) {
    if (ending.has(item.id)) {
      item.transactionId = null;
      item.linkKind = null;
      justUnlinked.add(shipmentKey(item.orderId, item.shipTime));
    }
    const fill = filled.get(item.id);
    if (fill !== undefined) item.transactionId = fill;
  }

  const plan = await planLinks(database, shipments, { scope, today, justUnlinked });
  const linked = await storePlan(database, plan, today, now);
  if (endedIds.size > 0 || linked.length > 0) {
    log.info("Amazon shipments linked to Transactions", {
      linked: linked.length,
      ended: endedIds.size,
      reviewItems: plan.open.length,
    });
  }
  return {
    linked: linked.length,
    ended: endedIds.size,
    transactionIds: [...new Set([...endedIds, ...linked, ...filled.values()])],
  };
}

// The Line items whose links end, each with its Transaction:
// - the Transaction is pending, or the bank removed it, or hid it as posted;
// - it is hidden as replaced by re-link: its app links end, and its hand links end once its
//   Connection no longer waits for its copy, to which Matching moves them (spec 02, Link
//   carry-over);
// - its amount no longer equals the total of the shipments the app linked to it, such as after the
//   bank changed it, or a newer file added a Line item to one: those app links end. A hand link
//   stays.
async function linksToEnd(
  database: Database,
  items: readonly LinkingItem[],
  shipments: ReadonlyMap<string, Shipment>,
): Promise<Map<string, string>> {
  const held = new Map<string, LinkingItem[]>();
  for (const item of items) {
    if (item.transactionId === null) continue;
    const found = held.get(item.transactionId);
    if (found === undefined) held.set(item.transactionId, [item]);
    else found.push(item);
  }
  const ending = new Map<string, string>();
  if (held.size === 0) return ending;
  const end = (list: readonly LinkingItem[], id: string) => {
    for (const item of list) ending.set(item.id, id);
  };
  const replaced: string[] = [];
  for (const txn of await readLinkedTransactions(database)) {
    const list = held.get(txn.id) ?? [];
    const app = list.filter((item) => item.linkKind !== "hand");
    const hand = list.filter((item) => item.linkKind === "hand");
    if (
      txn.pending ||
      txn.hiddenReason === "posted" ||
      txn.hiddenReason === "removed by provider"
    ) {
      end(list, txn.id);
    } else if (txn.hiddenReason === "replaced by re-link") {
      end(app, txn.id);
      if (hand.length > 0) replaced.push(txn.id);
    } else if (app.length > 0) {
      const linked = new Set(app.map((item) => shipmentKey(item.orderId, item.shipTime)));
      const total = [...linked].reduce((sum, key) => sum + (shipments.get(key)?.total ?? 0), 0);
      if (-txn.amount !== total) end(app, txn.id);
    }
  }
  if (replaced.length > 0) {
    const awaiting = await listAwaitingCopies(database, replaced);
    for (const id of replaced) {
      if (!awaiting.has(id)) {
        end(
          (held.get(id) ?? []).filter((item) => item.linkKind === "hand"),
          id,
        );
      }
    }
  }
  return ending;
}

// A newer file can add a Line item to a shipment a Member linked by hand: it joins the shipment's
// Transaction, unless that link ends now. An app link's total no longer matches, so it ends.
function handLinksToFill(
  shipments: ReadonlyMap<string, Shipment>,
  ending: ReadonlyMap<string, string>,
): Map<string, string> {
  const hand = new Map<string, string>();
  for (const shipment of shipments.values()) {
    const linked = shipment.items.filter(
      (item) => item.transactionId !== null && !ending.has(item.id),
    );
    const first = linked[0];
    if (first?.transactionId == null || linked.length === shipment.items.length) continue;
    if (first.linkKind !== "hand") continue;
    if (linked.some((item) => item.transactionId !== first.transactionId)) continue;
    for (const item of shipment.items) {
      if (item.transactionId === null) hand.set(item.id, first.transactionId);
    }
  }
  return hand;
}

// What a run plans to write.
type Plan = {
  links: Planned[];
  // Open shipment items to close, with why.
  close: { id: string; reason: string }[];
  // New shipment items: a shipment, or a whole order, and the Transactions that fit it.
  open: { target: ShipmentTarget; shipments: Shipment[]; fits: LinkTransaction[] }[];
};

// The most passes a run makes: a link in one pass can leave another shipment one fit.
const MAX_PASSES = 10;

async function planLinks(
  database: Database,
  shipments: ReadonlyMap<string, Shipment>,
  run: { scope: LinkRunScope; today: string; justUnlinked: ReadonlySet<string> },
): Promise<Plan> {
  const plan: Plan = { links: [], close: [], open: [] };
  // The Transactions that hold Line items, by the order they hold.
  const holders = new Map<string, string>();
  const unlinked: Shipment[] = [];
  for (const shipment of shipments.values()) {
    const held = shipment.items.find((item) => item.transactionId !== null);
    if (held?.transactionId == null) unlinked.push(shipment);
    else holders.set(held.transactionId, shipment.orderId);
  }
  const openItems = await readOpenShipmentItems(database, AMAZON_SHIPMENT_KIND);
  if (unlinked.length === 0 && openItems.length === 0) return plan;

  const tried = unlinked.filter((shipment) => !shipment.giftCard && shipment.total > 0);
  const dates = tried.map((shipment) => shipment.shipDate).sort();
  const first = dates[0];
  const last = dates.at(-1);
  const candidates =
    first === undefined || last === undefined
      ? []
      : (
          await readAmazonCandidates(database, {
            from: addDays(first, -DAYS_BEFORE_SHIP),
            to: addDays(last, DAYS_AFTER_SHIP),
          })
        ).filter(isAmazonCharge);
  const byAmount = new Map<number, LinkTransaction[]>();
  for (const txn of candidates) {
    const found = byAmount.get(-txn.amount);
    if (found === undefined) byAmount.set(-txn.amount, [txn]);
    else found.push(txn);
  }
  const masks = await readAccountMasks(database);
  const knownMasks = new Set(masks.values());
  const refused = new Set(
    (await readRefusedLineItemLinks(database)).map((row) =>
      refusalKey(row.orderId, row.shipTime, row.transactionId),
    ),
  );

  // The charges that fit shipments: one shipment, or a whole order's. The card filter applies only
  // when some Account has the shipment's card's last 4 digits.
  const fitsOf = (group: readonly Shipment[]): LinkTransaction[] => {
    const total = group.reduce((sum, shipment) => sum + shipment.total, 0);
    const days = group.map((shipment) => shipment.shipDate).sort();
    const from = addDays(days[0] ?? "", -DAYS_BEFORE_SHIP);
    const to = addDays(days.at(-1) ?? "", DAYS_AFTER_SHIP);
    const cards = new Set(
      group.flatMap((shipment) =>
        shipment.cardLast4 !== null && knownMasks.has(shipment.cardLast4)
          ? [shipment.cardLast4]
          : [],
      ),
    );
    return (byAmount.get(total) ?? []).filter(
      (txn) =>
        txn.purchaseDate >= from &&
        txn.purchaseDate <= to &&
        (cards.size === 0 || cards.has(masks.get(txn.accountId) ?? "")) &&
        !holders.has(txn.id) &&
        !group.some((shipment) =>
          refused.has(refusalKey(shipment.orderId, shipment.shipTime, txn.id)),
        ),
    );
  };
  const waitingSince = waitingFrom(run.today);
  const isTried = (group: readonly Shipment[], fits: readonly LinkTransaction[]) => {
    const { scope } = run;
    if (scope.after === "import") return true;
    return (
      group.some((shipment) => shipment.shipDate >= waitingSince) ||
      group.some((shipment) => run.justUnlinked.has(shipment.key)) ||
      fits.some((txn) => scope.unhandled.has(txn.id))
    );
  };
  const link = (target: ShipmentTarget, group: Shipment[], transactionId: string) => {
    plan.links.push({ target, shipments: group, transactionId });
    holders.set(transactionId, target.orderId);
    for (const shipment of group) planned.add(shipment.key);
  };
  const planned = new Set<string>();

  // The open items first: one whose shipment is linked closes, and one with a single Transaction
  // left links it (spec 14, Review list items).
  const asked = new Set<string>();
  const byOrder = new Map<string, Shipment[]>();
  for (const shipment of shipments.values()) {
    const order = byOrder.get(shipment.orderId);
    if (order === undefined) byOrder.set(shipment.orderId, [shipment]);
    else order.push(shipment);
  }
  for (const item of openItems) {
    const target = shipmentOfAnswer(item.value);
    const group =
      target === undefined
        ? []
        : target.shipTime === null
          ? (byOrder.get(target.orderId) ?? [])
          : [shipments.get(shipmentKey(target.orderId, target.shipTime))].flatMap((found) =>
              found === undefined ? [] : [found],
            );
    if (target === undefined || group.length === 0) {
      plan.close.push({ id: item.id, reason: "shipment gone" });
      continue;
    }
    if (group.some((shipment) => shipment.items.some((line) => line.transactionId !== null))) {
      plan.close.push({ id: item.id, reason: "shipment linked" });
      continue;
    }
    const subject = new Set(item.transactionIds);
    const left = fitsOf(group).filter((txn) => subject.has(txn.id));
    const only = left[0];
    if (left.length === 1 && only !== undefined) {
      link(target, group, only.id);
      plan.close.push({ id: item.id, reason: "only one Transaction left" });
    } else if (left.length === 0) {
      plan.close.push({ id: item.id, reason: "no Transaction left" });
    } else {
      for (const shipment of group) asked.add(shipment.key);
    }
  }

  // Each pass links every shipment that exactly one charge fits, when no other shipment's only fit
  // is that charge too. Such a charge waits: the shipments' own charges are likely still to come.
  const free = () =>
    tried.filter((shipment) => !planned.has(shipment.key) && !asked.has(shipment.key));
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const claims = new Map<string, Shipment[]>();
    for (const shipment of free()) {
      const fits = fitsOf([shipment]);
      const only = fits[0];
      if (fits.length !== 1 || only === undefined || !isTried([shipment], fits)) continue;
      claims.set(only.id, [...(claims.get(only.id) ?? []), shipment]);
    }
    let made = 0;
    for (const [transactionId, claimants] of claims) {
      const [shipment] = claimants;
      if (claimants.length !== 1 || shipment === undefined) continue;
      link({ orderId: shipment.orderId, shipTime: shipment.shipTime }, [shipment], transactionId);
      made += 1;
    }
    if (made === 0) break;
  }

  // What is left: two or more fits put a Review list item up. An order none of whose shipments
  // fits alone is tried as one charge for the whole order.
  const none = new Set<string>();
  for (const shipment of free()) {
    const fits = fitsOf([shipment]);
    if (fits.length === 0) none.add(shipment.key);
    else if (fits.length >= 2 && isTried([shipment], fits)) {
      plan.open.push({
        target: { orderId: shipment.orderId, shipTime: shipment.shipTime },
        shipments: [shipment],
        fits,
      });
    }
  }
  const orderClaims = new Map<string, { orderId: string; group: Shipment[] }[]>();
  for (const [orderId, group] of byOrder) {
    if (group.length < 2 || !group.every((shipment) => none.has(shipment.key))) continue;
    const fits = fitsOf(group);
    if (fits.length === 0 || !isTried(group, fits)) continue;
    const only = fits[0];
    if (fits.length === 1 && only !== undefined) {
      orderClaims.set(only.id, [...(orderClaims.get(only.id) ?? []), { orderId, group }]);
    } else {
      plan.open.push({ target: { orderId, shipTime: null }, shipments: group, fits });
    }
  }
  for (const [transactionId, claimants] of orderClaims) {
    const [claim] = claimants;
    if (claimants.length !== 1 || claim === undefined || holders.has(transactionId)) continue;
    link({ orderId: claim.orderId, shipTime: null }, claim.group, transactionId);
  }
  return plan;
}

// The words of a shipment's Review list item: its order, when it shipped, what it holds, and how
// many charges fit it.
function decidedOf(open: Plan["open"][number], today: string): string {
  const names = open.shipments.flatMap((shipment) => shipment.items.map((item) => item.name));
  const firstName = names[0] ?? "";
  const shown = firstName.length > 80 ? `${firstName.slice(0, 79)}…` : firstName;
  const more = names.length - 1;
  const total = open.shipments.reduce((sum, shipment) => sum + shipment.total, 0);
  const shipped = open.shipments.map((shipment) => shipment.shipDate).sort()[0] ?? today;
  const what = more === 0 ? shown : `${shown} and ${more} more ${more === 1 ? "item" : "items"}`;
  const which = open.target.shipTime === null ? "Amazon order" : "Amazon shipment of order";
  return `${which} ${open.target.orderId}, shipped ${dateLabel(shipped, today)}: ${what}. ${open.fits.length} charges of ${dollarsAndCents(total)} fit it.`;
}

const NONE_OF_THESE = "None of these";

// Stores a run's links and Review list items in one transaction. It reads again which shipments
// are linked, which Transactions hold Line items, the refused links, and the open items, so a
// Member's link or answer made since the run read them wins. Returns the Transactions it linked.
async function storePlan(
  database: Database,
  plan: Plan,
  today: string,
  at: Date,
): Promise<string[]> {
  if (plan.links.length === 0 && plan.close.length === 0 && plan.open.length === 0) return [];
  return database.transaction(async (tx) => {
    const held = await readHeldShipments(tx);
    const linkedShipments = new Set(held.map((row) => shipmentKey(row.orderId, row.shipTime)));
    const holding = new Set(held.map((row) => row.transactionId));
    const refused = new Set(
      (await readRefusedLineItemLinks(tx)).map((row) =>
        refusalKey(row.orderId, row.shipTime, row.transactionId),
      ),
    );
    const stillFree = (shipments: readonly Shipment[]) =>
      shipments.every((shipment) => !linkedShipments.has(shipment.key));
    const links = new Map<string, string>();
    const linked: string[] = [];
    for (const planned of plan.links) {
      if (!stillFree(planned.shipments) || holding.has(planned.transactionId)) continue;
      if (
        planned.shipments.some((shipment) =>
          refused.has(refusalKey(shipment.orderId, shipment.shipTime, planned.transactionId)),
        )
      ) {
        continue;
      }
      for (const shipment of planned.shipments) {
        for (const item of shipment.items) links.set(item.id, planned.transactionId);
      }
      holding.add(planned.transactionId);
      linked.push(planned.transactionId);
    }
    await storeLineItemLinks(tx, links, "app");
    const reasons = new Map<string, string[]>();
    for (const { id, reason } of plan.close)
      reasons.set(reason, [...(reasons.get(reason) ?? []), id]);
    for (const [reason, ids] of reasons) await closeReviewItemsIn(tx, ids, { reason, at });
    const asked = new Set(
      (await readOpenShipmentItems(tx, AMAZON_SHIPMENT_KIND)).map((item) => item.value),
    );
    const opened = plan.open.filter(
      (open) => stillFree(open.shipments) && !asked.has(shipmentAnswerValue(open.target)),
    );
    await addReviewItems(
      tx,
      opened.map((open) => ({
        kind: AMAZON_SHIPMENT_KIND,
        subjectType: "transactions" as const,
        subjectIds: open.fits.map((txn) => txn.id),
        decided: decidedOf(open, today),
        bestAnswer: { value: shipmentAnswerValue(open.target), label: NONE_OF_THESE },
      })),
      at,
    );
    await followUpAgain(tx, linked);
    return linked;
  });
}

// Why a hand link was refused, or that it was made (spec 14, Hand links).
export type HandLinkOutcome =
  | "linked"
  | "no Transaction"
  | "pending"
  | "not Spending"
  | "no shipment"
  | "already linked"
  | "another order";

// Links a shipment, or each unlinked shipment of a whole order, to a posted Spending Transaction
// by hand, through `tx`: the link may differ in amount. A Transaction holds the Line items of one
// order at most. A refusal of that pair ends, and each open shipment item about the shipment or
// its order closes, except `except`, which a Member is answering.
async function linkByHandIn(
  tx: Queries,
  transactionId: string,
  target: ShipmentTarget,
  by: { at: Date; except?: string },
): Promise<HandLinkOutcome> {
  const [txn] = await readLinkTransactions(tx, [transactionId]);
  if (txn === undefined || txn.hiddenReason !== null) return "no Transaction";
  if (txn.pending) return "pending";
  if (!txn.spending || txn.amount >= 0) return "not Spending";
  const all = await readShipmentItems(tx, target);
  if (all.length === 0) return "no shipment";
  // A whole order links the shipments still unlinked; one shipment links only when it is.
  const items = target.shipTime === null ? all.filter((item) => item.transactionId === null) : all;
  if (items.length === 0 || items.some((item) => item.transactionId !== null)) {
    return "already linked";
  }
  const held = await readItemsHeldBy(tx, transactionId);
  if (held.some((item) => item.orderId !== target.orderId)) return "another order";
  await storeLineItemLinks(tx, new Map(items.map((item) => [item.id, transactionId])), "hand");
  const shipTimes = [...new Set(items.map((item) => item.shipTime))];
  await deleteRefusedLineItemLinks(
    tx,
    shipTimes.map((shipTime) => ({ orderId: target.orderId, shipTime, transactionId })),
  );
  await closeShipmentReviewItems(
    tx,
    AMAZON_SHIPMENT_KIND,
    [
      ...shipTimes.map((shipTime) => ({ orderId: target.orderId, shipTime })),
      { orderId: target.orderId, shipTime: null },
    ],
    {
      reason: "linked by hand",
      at: by.at,
      ...(by.except === undefined ? {} : { except: by.except }),
    },
  );
  await followUpAgain(tx, [transactionId]);
  return "linked";
}

// A Member links a shipment to a Transaction by hand, from its detail view. The follow-up job then
// remakes its parts.
export async function linkShipmentByHand(
  database: Database,
  transactionId: string,
  shipment: { orderId: string; shipTime: string },
  at = new Date(),
): Promise<HandLinkOutcome> {
  const outcome = await database.transaction((tx) =>
    linkByHandIn(tx, transactionId, shipment, { at }),
  );
  if (outcome === "linked") {
    log.info("A Member linked an Amazon shipment by hand");
    await askForFollowUp();
  }
  return outcome;
}

// Undo on a Transaction's detail view: every Line item linked to it, by the app or by hand, is
// unlinked, and the app never links those shipments to it again. The follow-up job then tries
// them again and remakes the Transaction's parts. False when it holds no Line item.
export async function undoShipmentLinks(
  database: Database,
  transactionId: string,
  memberId: string,
  at = new Date(),
): Promise<boolean> {
  const undone = await database.transaction(async (tx) => {
    const held = await readItemsHeldBy(tx, transactionId);
    if (held.length === 0) return false;
    await unlinkLineItems(tx, new Map(held.map((item) => [item.id, transactionId])));
    const shipments = new Map(
      held.map((item) => [shipmentKey(item.orderId, item.shipTime), item] as const),
    );
    await storeRefusedLineItemLinks(
      tx,
      [...shipments.values()].map((item) => ({
        orderId: item.orderId,
        shipTime: item.shipTime,
        transactionId,
      })),
      { memberId, at },
    );
    await followUpAgain(tx, [transactionId]);
    return true;
  });
  if (undone) {
    log.info("A Member undid an Amazon link");
    await askForFollowUp();
  }
  return undone;
}

// The unlinked shipments a Member may link to a Transaction by hand: an order date from 30 days
// before to 3 days after its purchase date. Undefined when no Transaction that shows has the ID.
export async function shipmentsToLink(
  database: Database,
  transactionId: string,
): Promise<ShipmentToLink[] | undefined> {
  const [txn] = await readLinkTransactions(database, [transactionId]);
  if (txn === undefined || txn.hiddenReason !== null) return undefined;
  return listShipmentsToLink(database, "amazon", {
    from: addDays(txn.purchaseDate, -30),
    to: addDays(txn.purchaseDate, 3),
  });
}

const LINK = "link|";

// The Review list kind: picking one of its Transactions links the shipment by hand. "None of
// these", its best answer, refuses each of them, so the app never offers them for it again.
function shipmentKind(database: Database): ReviewKind {
  return {
    async otherChoices(item: ReviewItem) {
      const ids = item.subject.type === "transactions" ? item.subject.transactionIds : [];
      const shown = new Map(
        (await readShownTransactions(database, ids)).map((txn) => [txn.id, txn]),
      );
      return ids.flatMap((id) => {
        const txn = shown.get(id);
        if (txn === undefined) return [];
        const day = txn.authorizedDate ?? txn.postedDate;
        return [{ value: `${LINK}${id}`, label: `${day} · ${dollarsAndCents(-txn.amount)}` }];
      });
    },
    async answer(item, choice, answering) {
      const target = shipmentOfAnswer(item.bestAnswer.value);
      const subject = item.subject.type === "transactions" ? item.subject.transactionIds : [];
      if (target === undefined) throw new NotAChoice();
      const at = new Date();
      if (choice.value === item.bestAnswer.value) {
        const shipTimes = [
          ...new Set(
            (await readShipmentItems(answering.database, target)).map((line) => line.shipTime),
          ),
        ];
        await storeRefusedLineItemLinks(
          answering.database,
          subject.flatMap((transactionId) =>
            shipTimes.map((shipTime) => ({ orderId: target.orderId, shipTime, transactionId })),
          ),
          { memberId: answering.memberId, at },
        );
        return;
      }
      const transactionId = choice.value.slice(LINK.length);
      if (!choice.value.startsWith(LINK) || !subject.includes(transactionId)) {
        throw new NotAChoice();
      }
      const outcome = await linkByHandIn(answering.database, transactionId, target, {
        at,
        except: item.id,
      });
      if (outcome !== "linked") throw new NotAChoice();
    },
    afterAnswer: () => askForFollowUp(),
  };
}

// Registers linking: the follow-up step, the run after each import, the follow-up after Delete
// all, and the Review list kind. The start calls it before jobs run. `now` is fixed in the bench.
export function startLineItemLinks(options: { database: Database; now?: () => Date }): {
  stop(): void;
} {
  const { database } = options;
  const now = options.now ?? (() => new Date());
  const stops = [
    registerFollowUpStep("Amazon linking", async (unhandled) => {
      await runLinking(database, { after: "sync", unhandled: new Set(unhandled) }, now());
      return undefined;
    }),
    registerLineItemsImported("linking", async (db) => {
      const run = await runLinking(db, { after: "import" }, now());
      if (run.transactionIds.length > 0) await askForFollowUp();
    }),
    // Delete all made its Transactions unhandled in its own transaction, and closed the open
    // shipment items.
    registerLineItemsRemoved("linking", async (_db, transactionIds) => {
      if (transactionIds.length > 0) await askForFollowUp();
    }),
    registerReviewKind(AMAZON_SHIPMENT_KIND, shipmentKind(database)),
  ];
  return {
    stop() {
      for (const stop of stops.reverse()) stop();
    },
  };
}
