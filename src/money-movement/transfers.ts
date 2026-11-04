import { munkres } from "munkres";
import {
  type Database,
  listRefusedTransferLinks,
  listTransferCandidates,
  listTransferLinkDates,
  listTransferLinksOf,
  type NewTransferLink,
  refuseTransferLink,
  saveTransferLinks,
  type TransferCandidate,
  type TransferPair,
} from "../db/index.ts";
import { log } from "../log.ts";
import { addBusinessDays, addDays, daysBetween } from "./business-days.ts";
import { isHandSetType } from "./order.ts";

// Transfer pairing between two of the Household's Accounts (spec 03, Transfers). It needs no AI:
// - Hard filters decide which pairs are candidates. Strong signals decide each candidate's tier.
// - Pairing compares every candidate at once with minimum-cost matching (`munkres`), never first
//   come, first served. The chosen set has the most Strong pairs, then the most pairs, then the
//   most strong signals, then the smallest total date gap.
// - A Strong pair applies at once. An Unclear pair goes to the AI when one is registered (T81),
//   else on the Review list; it is not linked meanwhile.
// - The app keeps only its own links up to date. A link the AI or a Member made stays while both
//   sides still show with equal amounts.
// - Pairing reads only the Transactions near the ones that changed, so a sync never solves all of
//   history again. A link wholly outside them stays as it is.

export const TRANSFER_SIGNALS = [
  "last 4 digits",
  "institution name",
  "Plaid category",
  "earlier Transfer",
] as const;

export type TransferSignal = (typeof TRANSFER_SIGNALS)[number];

// Card rewards never enter pairing (spec 03, Card rewards): money into a credit card whose
// description holds "reward" or "redemption", in any case.
export function isCardReward(txn: {
  amount: number;
  accountKind: string;
  description: string;
}): boolean {
  return (
    txn.amount > 0 && txn.accountKind === "credit" && /reward|redemption/i.test(txn.description)
  );
}

// The route's window in business days (spec 03, Windows): within one bank, 1; a card payment from
// another bank, 4; between two banks, or to a connected loan, 5.
export function transferWindow(
  a: Pick<TransferCandidate, "institutionId" | "accountKind">,
  b: Pick<TransferCandidate, "institutionId" | "accountKind">,
): number {
  if (a.institutionId !== null && a.institutionId === b.institutionId) return 1;
  if (a.accountKind === "credit" || b.accountKind === "credit") return 4;
  return 5;
}

// No window of 5 business days spans more than this many calendar days.
const WINDOW_DAYS = 14;

// The index of the first of these, in date order, posted on or after the date.
function firstOnOrAfter(byDate: readonly TransferCandidate[], date: string): number {
  let low = 0;
  let high = byDate.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((byDate[middle]?.postedDate ?? "") < date) low = middle + 1;
    else high = middle;
  }
  return low;
}

// Either side may post first.
function insideWindow(a: TransferCandidate, b: TransferCandidate): boolean {
  const [early, late] = a.postedDate <= b.postedDate ? [a, b] : [b, a];
  return late.postedDate <= addBusinessDays(early.postedDate, transferWindow(a, b));
}

// The hard filters (spec 03, Hard filters): two different Accounts, money out and money in, the
// same amount to the cent, and both posted dates inside the route's window. The Household's
// Accounts are the ones the candidate list holds.
function passesHardFilters(out: TransferCandidate, into: TransferCandidate): boolean {
  return (
    out.accountId !== into.accountId &&
    out.amount < 0 &&
    out.amount === -into.amount &&
    insideWindow(out, into)
  );
}

// Lowercase words, with a bank's name endings dropped, so "Synchrony Bank" names "SYNCHRONY".
const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
const ENDINGS = new Set(["bank", "na", "n", "a", "inc", "fsb", "corp", "co"]);

function nameWords(name: string): string[] {
  const out = words(name);
  while (out.length > 0 && ENDINGS.has(out[out.length - 1] ?? "")) out.pop();
  return out;
}

function holdsWords(text: string, name: string[]): boolean {
  if (name.length === 0) return false;
  const found = words(text);
  for (let start = 0; start + name.length <= found.length; start += 1) {
    if (name.every((word, index) => found[start + index] === word)) return true;
  }
  return false;
}

// The other Account's last 4 digits, not inside a longer number.
function namesMask(description: string, mask: string | null): boolean {
  return (
    mask !== null && /^\d{4}$/.test(mask) && new RegExp(`(?<!\\d)${mask}(?!\\d)`).test(description)
  );
}

// The other institution's name in the description, or in a counterparty of type
// financial_institution.
function namesInstitution(txn: TransferCandidate, institution: string | null): boolean {
  if (institution === null) return false;
  const name = nameWords(institution);
  return (
    holdsWords(txn.description, name) ||
    txn.counterparties.some(
      (party) => party.type === "financial_institution" && holdsWords(party.name, name),
    )
  );
}

// Plaid's transfer, credit card payment, or loan payment category.
const isTransferCategory = (code: string | null) =>
  code !== null && /^(TRANSFER_IN|TRANSFER_OUT|LOAN_PAYMENTS)_/.test(code);

// The strong signals that need nothing but the two Transactions and their Accounts. Matching never
// reads `authorized_date`, `transaction_code`, or `counterparties[].account_numbers`.
function ownSignals(out: TransferCandidate, into: TransferCandidate): TransferSignal[] {
  const signals: TransferSignal[] = [];
  if (namesMask(out.description, into.mask) || namesMask(into.description, out.mask)) {
    signals.push("last 4 digits");
  }
  if (namesInstitution(out, into.institutionName) || namesInstitution(into, out.institutionName)) {
    signals.push("institution name");
  }
  if (isTransferCategory(out.providerCategory) || isTransferCategory(into.providerCategory)) {
    signals.push("Plaid category");
  }
  return signals;
}

// A Transfer between two Accounts, for the "earlier Transfer" signal.
type EarlierPair = {
  outTransactionId: string;
  inTransactionId: string;
  accounts: string;
  lastDate: string;
};

// The earlier and the later of two calendar dates.
const [firstOf, lastOf] = [
  (a: string, b: string) => [a, b].sort()[0] ?? a,
  (a: string, b: string) => [a, b].sort()[1] ?? b,
];

const accountsKey = (a: string, b: string) => (a < b ? `${a} ${b}` : `${b} ${a}`);
const pairKey = (pair: TransferPair) => `${pair.outTransactionId} ${pair.inTransactionId}`;

type Edge = {
  out: TransferCandidate;
  into: TransferCandidate;
  own: TransferSignal[];
  signals: TransferSignal[];
  gap: number;
};

// The earlier Transfers by their 2 Accounts, oldest last date first.
type EarlierIndex = Map<string, EarlierPair[]>;

function earlierIndexOf(earlier: readonly EarlierPair[]): EarlierIndex {
  const index: EarlierIndex = new Map();
  for (const pair of earlier) {
    const list = index.get(pair.accounts);
    if (list === undefined) index.set(pair.accounts, [pair]);
    else list.push(pair);
  }
  for (const list of index.values()) list.sort((a, b) => a.lastDate.localeCompare(b.lastDate));
  return index;
}

// A Transfer between the same 2 Accounts that ended before this pair's first date, and shares
// neither of its Transactions.
function hasEarlier(edge: Edge, earlier: EarlierIndex): boolean {
  const first = firstOf(edge.out.postedDate, edge.into.postedDate);
  for (const pair of earlier.get(accountsKey(edge.out.accountId, edge.into.accountId)) ?? []) {
    if (pair.lastDate >= first) return false;
    if (pair.outTransactionId !== edge.out.id && pair.inTransactionId !== edge.into.id) return true;
  }
  return false;
}

const withEarlier = (edge: Edge, earlier: EarlierIndex): Edge => ({
  ...edge,
  signals: hasEarlier(edge, earlier) ? [...edge.own, "earlier Transfer"] : edge.own,
});

// The edges as one cost matrix for `munkres`: a row per money-out side and a column per money-in
// side. Each edge's weight orders the sets as the spec does: one Strong pair outweighs any number
// of pairs, one pair outweighs any number of signals, and one signal outweighs any total date gap.
// A set's weight is the sum of its pairs' weights. An edge costs less than no pair, by its weight.
type CostMatrix = {
  costs: bigint[][];
  // The cost of no pair.
  most: bigint;
  weights: bigint[];
  // Each edge's cell.
  cells: { row: number; col: number }[];
  // Each cell's edge, or -1.
  edgeAt: Int32Array[];
};

function costMatrixOf(edges: readonly Edge[]): CostMatrix {
  const rowOf = new Map<string, number>();
  const colOf = new Map<string, number>();
  for (const edge of edges) {
    if (!rowOf.has(edge.out.id)) rowOf.set(edge.out.id, rowOf.size);
    if (!colOf.has(edge.into.id)) colOf.set(edge.into.id, colOf.size);
  }
  const n = BigInt(Math.min(rowOf.size, colOf.size));
  let widest = 0;
  for (const edge of edges) widest = Math.max(widest, edge.gap);
  const maxGap = BigInt(widest + 1);
  const signalUnit = n * maxGap + 1n;
  const pairUnit = n * (BigInt(TRANSFER_SIGNALS.length) * signalUnit + maxGap) + 1n;
  const strongUnit = n * (pairUnit + BigInt(TRANSFER_SIGNALS.length) * signalUnit + maxGap) + 1n;
  const weights = edges.map(
    (edge) =>
      (edge.signals.length > 0 ? strongUnit : 0n) +
      pairUnit +
      BigInt(edge.signals.length) * signalUnit +
      (maxGap - BigInt(edge.gap)),
  );
  let most = 0n;
  for (const weight of weights) if (weight >= most) most = weight + 1n;
  const costs = Array.from({ length: rowOf.size }, () => new Array<bigint>(colOf.size).fill(most));
  const edgeAt = Array.from({ length: rowOf.size }, () => new Int32Array(colOf.size).fill(-1));
  const cells = edges.map((edge, index) => {
    const row = rowOf.get(edge.out.id) ?? 0;
    const col = colOf.get(edge.into.id) ?? 0;
    (costs[row] as bigint[])[col] = most - (weights[index] ?? 0n);
    (edgeAt[row] as Int32Array)[col] = index;
    return { row, col };
  });
  return { costs, most, weights, cells, edgeAt };
}

// The best set of pairs: the indexes of its edges, and its weight. A cell that costs as much as no
// pair is no pair.
function assign(matrix: CostMatrix): { chosen: number[]; weight: bigint } {
  if (matrix.costs.length === 0) return { chosen: [], weight: 0n };
  const chosen: number[] = [];
  let weight = 0n;
  for (const [row, col] of munkres(matrix.costs)) {
    const index = matrix.edgeAt[row]?.[col] ?? -1;
    if (index < 0 || matrix.costs[row]?.[col] === matrix.most) continue;
    chosen.push(index);
    weight += matrix.weights[index] ?? 0n;
  }
  return { chosen, weight };
}

function solve(edges: readonly Edge[]): Edge[] {
  return assign(costMatrixOf(edges)).chosen.flatMap((index) => edges[index] ?? []);
}

// Each of these chosen edges, with whether an equally good set leaves it out. Each check reuses the
// one matrix, with the edge's cell set to no pair.
function tiesOf(matrix: CostMatrix, best: bigint, chosen: readonly number[]): boolean[] {
  return chosen.map((index) => {
    const cell = matrix.cells[index];
    const row = cell === undefined ? undefined : matrix.costs[cell.row];
    if (cell === undefined || row === undefined) return false;
    const cost = row[cell.col] ?? matrix.most;
    row[cell.col] = matrix.most;
    const without = assign(matrix).weight;
    row[cell.col] = cost;
    return without === best;
  });
}

// Up to this many money-out sides, the tie checks solve the whole group again for each chosen
// pair. A longer chain checks each pair among the edges near it instead, so the cost stays close to
// one solve: an equally good set that differs only far away is not looked for.
const WHOLE_TIE_CHECK = 60;
const NEAR_DAYS = 14;

// The best set, with each chosen pair that an equally good set leaves out marked uncertain. Two
// sets that tie use only the Household's own Accounts, as every candidate does, so either gives the
// same Spending (spec 03, Global pairing).
function solveWithTies(edges: readonly Edge[]): { edge: Edge; uncertain: boolean }[] {
  const matrix = costMatrixOf(edges);
  const best = assign(matrix);
  const ties =
    matrix.costs.length <= WHOLE_TIE_CHECK
      ? tiesOf(matrix, best.weight, best.chosen)
      : nearTiesOf(edges, best.chosen);
  return best.chosen.flatMap((index, at) => {
    const edge = edges[index];
    return edge === undefined ? [] : [{ edge, uncertain: ties[at] === true }];
  });
}

// The tie check of each chosen edge among the edges within NEAR_DAYS days of it. A Transaction the
// best set pairs with one outside them keeps that pair.
function nearTiesOf(edges: readonly Edge[], chosen: readonly number[]): boolean[] {
  const spans = edges.map((edge) => ({
    first: firstOf(edge.out.postedDate, edge.into.postedDate),
    last: lastOf(edge.out.postedDate, edge.into.postedDate),
  }));
  const byFirst = edges.map((_, index) => index);
  byFirst.sort((a, b) => (spans[a]?.first ?? "").localeCompare(spans[b]?.first ?? ""));
  const pairedBy = new Map<string, number>();
  for (const index of chosen) {
    const edge = edges[index];
    if (edge === undefined) continue;
    pairedBy.set(edge.out.id, index);
    pairedBy.set(edge.into.id, index);
  }
  return chosen.map((index) => {
    const span = spans[index];
    if (span === undefined) return false;
    const from = addDays(span.first, -NEAR_DAYS);
    const to = addDays(span.last, NEAR_DAYS);
    // The first edge in date order that starts on or after `from`.
    let low = 0;
    let high = byFirst.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((spans[byFirst[middle] ?? 0]?.first ?? "") < from) low = middle + 1;
      else high = middle;
    }
    const near = new Set<number>();
    for (let at = low; at < byFirst.length; at += 1) {
      const other = byFirst[at] ?? 0;
      const otherSpan = spans[other];
      if (otherSpan === undefined || otherSpan.first > to) break;
      if (otherSpan.last <= to) near.add(other);
    }
    const kept = [...near].filter((other) => {
      const edge = edges[other];
      if (edge === undefined) return false;
      return [edge.out.id, edge.into.id].every((id) => {
        const pair = pairedBy.get(id);
        return pair === undefined || near.has(pair);
      });
    });
    const local = kept.flatMap((other) => edges[other] ?? []);
    const matrix = costMatrixOf(local);
    return tiesOf(matrix, assign(matrix).weight, [kept.indexOf(index)])[0] === true;
  });
}

// The AI's judgment of an Unclear pair (spec 03, Tiers). T81 registers it, and keeps its answers so
// the app never asks about the same pair twice. Undefined when no AI answers.
export type UnclearPairAnswer = { answer: "yes" | "no"; confidence: "high" | "medium" | "low" };
export type UnclearPairJudge = (pair: {
  out: TransferCandidate;
  into: TransferCandidate;
}) => Promise<UnclearPairAnswer | undefined>;

let judge: UnclearPairJudge | undefined;

// Registers the AI's judgment of Unclear pairs. Returns a function that removes it again.
export function registerUnclearPairJudge(registered: UnclearPairJudge): () => void {
  if (judge !== undefined) throw new Error("A judge of Unclear pairs is already registered.");
  judge = registered;
  return () => {
    if (judge === registered) judge = undefined;
  };
}

// A Review list item that pairing asks for: an Unclear pair, or a pair picked from two equally
// good sets.
export type PairItem = { kind: "unclear" | "guess"; pair: TransferPair };

export type PairingResult = {
  // Transactions whose link began or ended, which the order must decide again.
  changed: Set<string>;
  // Every Transaction whose pairing this run looked at.
  looked: Set<string>;
  items: PairItem[];
};

// Groups the edges into sets that share no Transaction, so each solves on its own.
function components(edges: readonly Edge[]): Edge[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    for (let at = id; at !== root; ) {
      const next = parent.get(at) ?? root;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const edge of edges) {
    for (const id of [edge.out.id, edge.into.id]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(edge.out.id), find(edge.into.id));
  }
  const groups = new Map<string, Edge[]>();
  for (const edge of edges) {
    const root = find(edge.out.id);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [edge]);
    else group.push(edge);
  }
  return [...groups.values()];
}

// Pairing never re-solves all of history. It looks at the Transactions within this many business
// days of the ones it pairs around: one more than the longest window, so a date on a weekend
// counts too. A link wholly outside that stays as it is.
const REACH = 6;

// Pairs Transfers again around these Transactions: each one, and each one near it that could pair
// with it, directly or through others. Stores the app's links and returns what changed.
export async function pairTransfers(
  database: Database,
  transactionIds: readonly string[],
  now = new Date(),
): Promise<PairingResult> {
  const seeds = new Set(transactionIds);
  const touching = await listTransferLinksOf(database, transactionIds);
  for (const link of touching) {
    seeds.add(link.outTransactionId);
    seeds.add(link.inTransactionId);
  }
  const found = await listTransferCandidates(database, { ids: [...seeds] });
  const byId = new Map(found.map((candidate) => [candidate.id, candidate]));
  const result: PairingResult = { changed: new Set(), looked: new Set(seeds), items: [] };

  // A link ends when a side no longer shows, is pending, or is on an excluded Account, or the
  // amounts differ. Otherwise a link the AI or a Member made stays, and its sides stay out of
  // pairing.
  const ended = touching.filter((link) => {
    const out = byId.get(link.outTransactionId);
    const into = byId.get(link.inTransactionId);
    return out === undefined || into === undefined || out.amount !== -into.amount;
  });
  await saveTransferLinks(database, { remove: ended.map((link) => link.id), update: [], add: [] });
  for (const link of ended) {
    result.changed.add(link.outTransactionId);
    result.changed.add(link.inTransactionId);
  }

  const oldestFirst = found.sort(
    (a, b) => a.postedDate.localeCompare(b.postedDate) || a.id.localeCompare(b.id),
  );
  for (const near of nearGroupsOf(oldestFirst)) {
    const part = await pairNear(database, near, now);
    for (const id of part.changed) result.changed.add(id);
    for (const id of part.looked) result.looked.add(id);
    result.items.push(...part.items);
  }
  if (ended.length > 0) log.info("Ended Transfer links", { ended: ended.length });
  return result;
}

// The Transactions, oldest first, in runs whose reach overlaps, so no Transaction is read twice.
function nearGroupsOf(oldestFirst: readonly TransferCandidate[]): TransferCandidate[][] {
  const groups: TransferCandidate[][] = [];
  let reach = "";
  for (const candidate of oldestFirst) {
    const current = groups.at(-1);
    if (current === undefined || addBusinessDays(candidate.postedDate, -REACH) > reach) {
      groups.push([candidate]);
    } else {
      current.push(candidate);
    }
    reach = addBusinessDays(candidate.postedDate, REACH);
  }
  return groups;
}

// Pairs around one run of seeds: the Transactions of their amounts, posted within REACH business
// days of them.
async function pairNear(
  database: Database,
  near: readonly TransferCandidate[],
  now: Date,
): Promise<PairingResult> {
  const seeds = new Set(near.map((candidate) => candidate.id));
  const first = near[0]?.postedDate ?? "";
  const last = near.at(-1)?.postedDate ?? "";
  const candidates = await listTransferCandidates(database, {
    amounts: [...new Set(near.map((candidate) => Math.abs(candidate.amount)))],
    from: addBusinessDays(first, -REACH),
    to: addBusinessDays(last, REACH),
  });
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const links = await listTransferLinksOf(database, [...byId.keys()]);

  // The sides of a link the AI or a Member made, and of an app link that reaches outside the
  // Transactions read here, stay as they are.
  const held = new Set<string>();
  for (const link of links) {
    const inside = byId.has(link.outTransactionId) && byId.has(link.inTransactionId);
    if (link.madeBy !== "app" || !inside) {
      held.add(link.outTransactionId);
      held.add(link.inTransactionId);
    }
  }

  // A Transaction with a hand-set type, card rewards, and a held link's sides never pair.
  const free = candidates.filter(
    (candidate) =>
      !isHandSetType(candidate.handSet.type) && !isCardReward(candidate) && !held.has(candidate.id),
  );
  const refused = await listRefusedTransferLinks(
    database,
    free.filter((candidate) => candidate.amount < 0).map((candidate) => candidate.id),
  );
  const byAmount = new Map<number, TransferCandidate[]>();
  for (const candidate of free) {
    const amount = Math.abs(candidate.amount);
    const group = byAmount.get(amount);
    if (group === undefined) byAmount.set(amount, [candidate]);
    else group.push(candidate);
  }
  const edges: Edge[] = [];
  for (const group of byAmount.values()) {
    // Money in by date, so each money-out side reads only the days its window could reach.
    const ins = group.filter((candidate) => candidate.amount > 0);
    ins.sort((a, b) => a.postedDate.localeCompare(b.postedDate));
    for (const out of group) {
      if (out.amount >= 0) continue;
      const to = addDays(out.postedDate, WINDOW_DAYS);
      for (let at = firstOnOrAfter(ins, addDays(out.postedDate, -WINDOW_DAYS)); ; at += 1) {
        const into = ins[at];
        if (into === undefined || into.postedDate > to) break;
        if (!passesHardFilters(out, into)) continue;
        if (refused.has(pairKey({ outTransactionId: out.id, inTransactionId: into.id }))) continue;
        const own = ownSignals(out, into);
        const gap = Math.abs(daysBetween(out.postedDate, into.postedDate));
        edges.push({ out, into, own, signals: own, gap });
      }
    }
  }
  const groups = components(edges).filter((group) =>
    group.some((edge) => seeds.has(edge.out.id) || seeds.has(edge.into.id)),
  );
  const looked = new Set(seeds);
  for (const group of groups) {
    for (const edge of group) {
      looked.add(edge.out.id);
      looked.add(edge.into.id);
    }
  }

  // Earlier Transfers between the same 2 Accounts: the stored links, then the Strong pairs a first
  // pass picks.
  const accountIds = [
    ...new Set(groups.flat().flatMap((e) => [e.out.accountId, e.into.accountId])),
  ];
  const stored: EarlierPair[] = (await listTransferLinkDates(database, accountIds)).map((link) => ({
    outTransactionId: link.outTransactionId,
    inTransactionId: link.inTransactionId,
    accounts: accountsKey(link.outAccountId, link.inAccountId),
    lastDate: lastOf(link.outDate, link.inDate),
  }));
  const asEarlier = (edge: Edge): EarlierPair => ({
    outTransactionId: edge.out.id,
    inTransactionId: edge.into.id,
    accounts: accountsKey(edge.out.accountId, edge.into.accountId),
    lastDate: lastOf(edge.out.postedDate, edge.into.postedDate),
  });

  const storedIndex = earlierIndexOf(stored);
  const firstPass = groups.flatMap((group) =>
    solve(group.map((edge) => withEarlier(edge, storedIndex)))
      .filter((edge) => edge.signals.length > 0)
      .map(asEarlier),
  );
  const earlier = earlierIndexOf([...stored, ...firstPass]);

  const chosen: { edge: Edge; uncertain: boolean; ai?: UnclearPairAnswer }[] = [];
  const items: PairItem[] = [];
  for (const group of groups) {
    let current = group.map((edge) => withEarlier(edge, earlier));
    // When the AI rejects an Unclear pair with high confidence, pairing runs again without it.
    for (;;) {
      const picked = solveWithTies(current);
      const rejected = new Set<Edge>();
      const settled: typeof chosen = [];
      const asked: PairItem[] = [];
      for (const { edge, uncertain } of picked) {
        if (edge.signals.length > 0) {
          settled.push({ edge, uncertain });
          continue;
        }
        const answer = await judge?.({ out: edge.out, into: edge.into });
        if (answer?.confidence === "high" && answer.answer === "yes") {
          settled.push({ edge, uncertain: false, ai: answer });
        } else if (answer?.confidence === "high") {
          rejected.add(edge);
        } else {
          asked.push({ kind: "unclear", pair: pairOf(edge) });
        }
      }
      if (rejected.size === 0) {
        chosen.push(...settled);
        items.push(...asked);
        break;
      }
      for (const edge of rejected) {
        await refuseTransferLink(database, pairOf(edge), { refusedBy: "AI", at: now });
      }
      current = current.filter((edge) => !rejected.has(edge));
    }
  }
  for (const { edge, uncertain, ai } of chosen) {
    if (uncertain && ai === undefined) items.push({ kind: "guess", pair: pairOf(edge) });
  }

  // The app's links around these Transactions, before and after.
  const before = new Map(
    links
      .filter(
        (link) =>
          link.madeBy === "app" &&
          !held.has(link.outTransactionId) &&
          (looked.has(link.outTransactionId) || looked.has(link.inTransactionId)),
      )
      .map((link) => [pairKey(link), link]),
  );
  const after = new Map(chosen.map((pick) => [pairKey(pairOf(pick.edge)), pick]));
  const changed = new Set<string>();
  const remove: string[] = [];
  const update: { id: string; fields: Partial<NewTransferLink> }[] = [];
  const add: NewTransferLink[] = [];
  for (const [key, link] of before) {
    const pick = after.get(key);
    if (pick === undefined || pick.ai !== undefined) {
      remove.push(link.id);
      changed.add(link.outTransactionId);
      changed.add(link.inTransactionId);
    } else {
      const evidence = evidenceOf(pick);
      if (
        link.tier !== evidence.tier ||
        link.uncertain !== evidence.uncertain ||
        link.signals.join() !== evidence.signals.join()
      ) {
        update.push({ id: link.id, fields: evidence });
      }
    }
  }
  for (const [key, pick] of after) {
    if (before.has(key) && pick.ai === undefined) continue;
    add.push({ ...pairOf(pick.edge), ...evidenceOf(pick), memberId: null, createdAt: now });
    changed.add(pick.edge.out.id);
    changed.add(pick.edge.into.id);
  }
  await saveTransferLinks(database, { remove, update, add });
  if (add.length > 0 || remove.length > 0) {
    log.info("Paired Transfers", { linked: add.length, ended: remove.length });
  }
  return { changed, looked, items };
}

function pairOf(edge: Edge): TransferPair {
  return { outTransactionId: edge.out.id, inTransactionId: edge.into.id };
}

function evidenceOf(pick: { edge: Edge; uncertain: boolean; ai?: UnclearPairAnswer }) {
  return {
    tier: pick.edge.signals.length > 0 ? ("Strong" as const) : ("Unclear" as const),
    signals: [...pick.edge.signals],
    aiAnswer: pick.ai?.answer ?? null,
    aiConfidence: pick.ai?.confidence ?? null,
    madeBy: pick.ai === undefined ? ("app" as const) : ("AI" as const),
    uncertain: pick.uncertain,
  };
}
