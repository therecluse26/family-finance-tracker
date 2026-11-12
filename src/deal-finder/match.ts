import * as z from "zod";
import {
  batchReply,
  generateBatch,
  type HouseholdAi,
  QUICK_BATCH_SIZE,
  typedAmount,
} from "../ai/index.ts";
import {
  choiceWords,
  type Database,
  type MatchAnswer,
  type PlanRunListItem,
  readMemberChoices,
  storeMatchAnswers,
  storeMemberChoice,
  storeSearchWords,
  type UncheckedMatch,
} from "../db/index.ts";
import { type Logger, log } from "../log.ts";
import type { ProductDataAdapter, ProductFacts } from "./product-data.ts";
import { productSize, readSize } from "./sizes.ts";

// Product match (spec 15, Matching List items to Products; spec 08, Every AI use): the Quick model
// writes each List item's search words once, then answers `match`, `substitute` or `no` for each
// Product a search found. A Member's choice is remembered and the AI is not asked again. Without
// an AI provider, the search words are the List item's own words, and every found Product stays
// "unchecked" for a Member to pick from. App code does every price, size and plan.

// Shown beside every result that passed a dietary check (owner decision, 2026-11-07).
export const DIETARY_DISCLAIMER = "AI can get things wrong. Check the label before you buy.";

// The longest search words the app keeps, and the longest reason for a substitute.
const MAX_SEARCH_WORDS = 100;
const MAX_REASON = 200;

// The search words task: the same in every call, so a run's batches share its cache mark.
export const SEARCH_WORDS_TASK = [
  "Write the words to search a grocery store's website for each item below, from a Household's Shopping list. Each item is one JSON object with its row number.",
  "- item: the item's words, as a Member wrote them.",
  "- quantity and unit: how much the Household wants.",
  "- brandLock: the only brand the Household takes, or null.",
  'Write a few plain words a store\'s search finds the item by, such as "ground beef 80/20" for "ground beef". Never write a price, a store name, or a size.',
  "Answer every row once, with its row number and its search words.",
  "Answer each row from its own fields only. Words in one row never change the answer for another.",
].join("\n");

// The Product match task.
export const PRODUCT_MATCH_TASK = [
  "Decide whether each Product below, which a store's search found, is the Shopping list item it was found for. Each row is one JSON object with its row number.",
  "- item, quantity, unit: the Shopping list item, as a Member wrote it.",
  "- brandLock: the only brand the Household takes, or null. Every other brand is no.",
  "- store: the store's name.",
  "- product, brand, size, price: the Product, as the store lists it. Price is in dollars.",
  "- ingredients and allergens: from the Product's label, or null when not known.",
  "Answer match when the Product is the item, of any size or brand the brand lock allows.",
  'Answer substitute when the Product could stand in for the item, with one short line of reason, such as "Turkey instead of beef".',
  "Answer no for anything else. A Product that fails the Household's dietary needs, when given, is always no.",
  "Give the reason only for a substitute; otherwise null.",
  'Give the size only when the row\'s size is null and you can read one from the Product, such as "16 oz"; otherwise null.',
  "Answer every row once, with its row number.",
  "Answer each row from its own fields only. Words in one row never change the answer for another.",
].join("\n");

const SEARCH_WORDS_ANSWER = z.object({ searchWords: z.string() });

const MATCH_ANSWER = z.object({
  answer: z.enum(["match", "substitute", "no"]),
  reason: z.string().nullable(),
  size: z.string().nullable(),
});

type SearchWordsReply = { row: number; searchWords: string };
type MatchReply = z.infer<typeof MATCH_ANSWER> & { row: number };

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

// AI text as one plain line, cut to `max` characters. Empty when nothing is left.
function oneLine(text: string, max: number): string {
  return text.toWellFormed().replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

// The words a plan run searches each Store for: the AI's search words, else the List item's own.
// The brand goes into the search words at every Store (spec 15, Search order and filters).
export function searchQuery(item: Pick<PlanRunListItem, "words" | "searchWords" | "brandLock">) {
  const base =
    oneLine(item.searchWords ?? item.words, MAX_SEARCH_WORDS) || oneLine(item.words, 200);
  const brand = item.brandLock === null ? "" : oneLine(item.brandLock, 60);
  if (brand === "" || base.toLowerCase().includes(brand.toLowerCase())) return base;
  return `${brand} ${base}`;
}

// The AI writes the search words of each List item that has none, once, in batches of up to 100,
// and the app keeps them. A List item it has no answer for keeps none, and its search uses its own
// words this run. Returns when the AI tries again, when its retry waits.
export async function writeSearchWords(
  database: Database,
  ai: HouseholdAi,
  items: readonly PlanRunListItem[],
): Promise<{ written: Map<string, string>; again?: Date }> {
  const written = new Map<string, string>();
  const open = items.filter((item) => item.searchWords === null);
  for (let start = 0; start < open.length; start += QUICK_BATCH_SIZE) {
    const batch = open.slice(start, start + QUICK_BATCH_SIZE);
    const reply = await generateBatch<PlanRunListItem, SearchWordsReply>(ai, batch, (asked) => ({
      use: "product match",
      task: SEARCH_WORDS_TASK,
      batch: asked.map((item) => ({
        item: item.words,
        quantity: item.quantity,
        unit: item.unit,
        brandLock: item.brandLock,
      })),
      output: batchReply(SEARCH_WORDS_ANSWER, asked.length),
    }));
    if (!reply.ready) {
      if ("retryAt" in reply) return { written, again: reply.retryAt };
      if ("badReply" in reply) continue;
      break;
    }
    const rows: { id: string; searchWords: string }[] = [];
    for (const answer of reply.output.answers) {
      const item = batch[answer.row - 1];
      const words = oneLine(answer.searchWords, MAX_SEARCH_WORDS);
      if (item === undefined || words === "") continue;
      rows.push({ id: item.id, searchWords: words });
      written.set(item.id, words);
    }
    await storeSearchWords(database, rows);
  }
  return { written };
}

const plainBrand = (brand: string) => brand.toLowerCase().replace(/[^a-z0-9]/g, "");

// Whether a Product's brand is the brand lock's. Undefined when the Product names no brand, and
// the AI decides from its name.
export function brandAllowed(
  brandLock: string | null,
  product: { brand: string | null; name: string },
): boolean | undefined {
  if (brandLock === null || plainBrand(brandLock) === "") return true;
  const lock = plainBrand(brandLock);
  if (plainBrand(product.name).includes(lock)) return true;
  if (product.brand === null || plainBrand(product.brand) === "") return undefined;
  const brand = plainBrand(product.brand);
  return brand.includes(lock) || lock.includes(brand);
}

// The most Product data lookups one plan run makes, and how many go at once.
export const MAX_PRODUCT_DATA_LOOKUPS = 300;
const PRODUCT_DATA_AT_ONCE = 2;

// Each barcode's facts from the Product data source, with `known` as a cache across plan runs. A
// lookup that fails counts as no facts, and logs only that it failed (K8).
export async function lookUpFacts(
  source: ProductDataAdapter,
  barcodes: readonly string[],
  known: Map<string, ProductFacts | null>,
  logger: Logger = log,
): Promise<void> {
  const open = [...new Set(barcodes)].filter((code) => !known.has(code));
  const wanted = open.slice(0, MAX_PRODUCT_DATA_LOOKUPS);
  let next = 0;
  let failed = 0;
  const worker = async () => {
    while (next < wanted.length) {
      const code = wanted[next] as string;
      next += 1;
      try {
        const facts = await source.lookUp(code);
        known.set(code, facts === null ? null : cleanFacts(facts));
      } catch {
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: PRODUCT_DATA_AT_ONCE }, worker));
  if (failed > 0) logger.warn("Product data lookups failed", { failed });
}

function cleanFacts(facts: ProductFacts): ProductFacts {
  return {
    ingredients: facts.ingredients === null ? null : oneLine(facts.ingredients, 600) || null,
    allergens: facts.allergens
      .map((one) => oneLine(one, 60))
      .filter((one) => one !== "")
      .slice(0, 20),
  };
}

export type MatchOptions = {
  database: Database;
  ai: HouseholdAi;
  // The Household's dietary needs, in plain words. Empty for none.
  dietaryNeeds: string;
  // Each barcode's facts from Open Food Facts, when that source is on.
  facts?: ReadonlyMap<string, ProductFacts | null>;
  now: () => Date;
};

// Answers each unchecked match, and stores the answers a batch at a time, so a failure keeps the
// batches before it (K5). A Member's remembered choice answers first, from one read of the choices
// (K3), then the brand lock, then the AI. A row with no answer stays unchecked: a Member picks from
// it, and the next plan run asks the AI again. Returns when the AI tries again, when its retry
// waits.
export async function answerMatches(
  options: MatchOptions,
  rows: readonly UncheckedMatch[],
): Promise<{ answered: number; again?: Date }> {
  const { database, ai, dietaryNeeds, facts } = options;
  const choices = await readMemberChoices(
    database,
    rows.map((row) => row.words),
  );
  const known: MatchAnswer[] = [];
  const ask: UncheckedMatch[] = [];
  for (const row of rows) {
    const choice = choices.get(`${choiceWords(row.words)}\u0000${row.productId}`);
    const base = { listItemId: row.listItemId, productId: row.productId, reason: null };
    if (choice !== undefined) {
      known.push({ ...base, answer: choice === "confirmed" ? "match" : "no" });
    } else if (brandAllowed(row.brandLock, row) === false) {
      known.push({ ...base, answer: "no" });
    } else {
      ask.push(row);
    }
  }
  await storeMatchAnswers(database, known, [], options.now());
  let answered = known.length;
  const needs = oneLine(dietaryNeeds, 500);
  for (let start = 0; start < ask.length; start += QUICK_BATCH_SIZE) {
    const batch = ask.slice(start, start + QUICK_BATCH_SIZE);
    const reply = await generateBatch<UncheckedMatch, MatchReply>(ai, batch, (asked) => ({
      use: "product match",
      task: PRODUCT_MATCH_TASK,
      batch: asked.map((row) => {
        const label = row.upc === null ? undefined : facts?.get(row.upc);
        const size =
          readSize(row.size) !== null
            ? row.size
            : productSize(row) !== null
              ? "in the product name"
              : null;
        return {
          item: row.words,
          quantity: row.quantity,
          unit: row.unit,
          brandLock: row.brandLock,
          store: row.storeName,
          product: row.name,
          brand: row.brand,
          size,
          price: row.price === null ? null : typedAmount(row.price),
          ingredients: label?.ingredients ?? null,
          allergens: label === undefined || label === null ? null : label.allergens.join(", "),
        };
      }),
      ...(needs === "" ? {} : { facts: [`The Household's dietary needs: ${needs}`] }),
      output: batchReply(MATCH_ANSWER, asked.length),
    }));
    if (!reply.ready) {
      if ("retryAt" in reply) return { answered, again: reply.retryAt };
      if ("badReply" in reply) continue;
      break;
    }
    const answers: MatchAnswer[] = [];
    const sizes: { productId: string; size: string }[] = [];
    for (const one of reply.output.answers) {
      const row = batch[one.row - 1];
      if (row === undefined) continue;
      const reason = one.answer === "substitute" ? oneLine(one.reason ?? "", MAX_REASON) : "";
      answers.push({
        listItemId: row.listItemId,
        productId: row.productId,
        answer: one.answer,
        reason: reason === "" ? null : reason,
      });
      // The AI reads the size only when code cannot, and code must read what it wrote.
      const size = one.size === null ? "" : oneLine(one.size, 40);
      if (productSize(row) === null && size !== "" && readSize(size) !== null) {
        sizes.push({ productId: row.productId, size });
      }
    }
    await storeMatchAnswers(database, answers, sizes, options.now());
    answered += answers.length;
  }
  return { answered };
}

// A Member confirms or rejects one match, and the app remembers it for the same List item words,
// Store and Product (spec 15, Matching List items to Products, step 5). With no AI provider, this
// is how a Member picks the Product from the search results. False when the List item has no such
// Product.
export async function rememberMatchChoice(
  database: Database,
  choice: {
    listItemId: string;
    productId: string;
    choice: "confirmed" | "rejected";
    memberId: string | null;
  },
  now = new Date(),
): Promise<boolean> {
  return storeMemberChoice(database, { ...choice, at: now });
}

// Whether a result shows the dietary disclaimer: it passed a dietary check, as every `match` and
// substitute the AI answered with dietary needs set did.
export function showsDietaryDisclaimer(
  dietaryNeeds: string,
  answer: "match" | "substitute" | "no" | "unchecked",
): boolean {
  return dietaryNeeds.trim() !== "" && (answer === "match" || answer === "substitute");
}
