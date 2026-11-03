import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { api } from "../server/api.ts";
import {
  CATEGORIES,
  CATEGORY_GROUPS,
  type Category,
  categoryGroupOf,
  categoryGroupTotals,
  isCategory,
  isSuperstore,
  SUPERSTORES,
} from "./index.ts";

// The fixed Category list (spec 04, Categories and Category groups; ADR 0007).

const SPEC = readFileSync(
  new URL("../../docs/spec/04-categorization.md", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

// The rows of the Markdown table under a heading, as cells, with the header row left out.
function specTable(heading: string): string[][] {
  const start = SPEC.indexOf(`## ${heading}\n`);
  const section = SPEC.slice(start, SPEC.indexOf("\n## ", start + 1));
  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  return rows.slice(2);
}

// Spec text as the app keeps it: a link in parentheses is dropped, and other links keep their text.
const plain = (text: string) =>
  text
    .replace(/ \(\[[^\]]*\]\([^)]*\)\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();

describe("the Category list", () => {
  it("matches the spec table: 30 Categories in 6 Category groups, in its order", () => {
    const table = specTable("Categories and Category groups").map(([group = "", names = ""]) => ({
      name: group,
      categories: names.split(", "),
    }));

    expect(
      CATEGORY_GROUPS.map((group) => ({
        name: group.name,
        categories: group.categories.map((category) => category.name),
      })),
    ).toEqual(table);
    expect(CATEGORY_GROUPS).toHaveLength(6);
    expect(CATEGORIES).toHaveLength(30);
    expect(new Set(CATEGORIES.map((category) => category.name)).size).toBe(30);
  });

  it("puts each Category in exactly one Category group", () => {
    expect(categoryGroupOf("Superstores")).toBe("Shopping");
    expect(categoryGroupOf("Interest and fees")).toBe("Bills");
    expect(categoryGroupOf("Miscellaneous")).toBe("Other");
    expect(isCategory("Hobbies")).toBe(true);
    expect(isCategory("Shopping")).toBe(false);
    expect(isCategory("Other")).toBe(false);
  });

  it("gives each Category a one-line definition, from What goes where where it has one", () => {
    for (const category of CATEGORIES) {
      expect(category.definition.length, category.name).toBeGreaterThan(5);
      expect(category.definition, category.name).not.toMatch(/\n/);
    }
    const whatGoesWhere = specTable("What goes where");
    expect(whatGoesWhere).toHaveLength(11);
    for (const [name = "", holds = ""] of whatGoesWhere) {
      expect(CATEGORIES.find((category) => category.name === name)?.definition, name).toBe(
        plain(holds),
      );
    }
  });

  it("cannot be changed in code", () => {
    expect(Object.isFrozen(CATEGORIES)).toBe(true);
    expect(Object.isFrozen(CATEGORY_GROUPS)).toBe(true);
    expect(Object.isFrozen(CATEGORY_GROUPS[0]?.categories)).toBe(true);
    expect(Object.isFrozen(CATEGORIES[0])).toBe(true);
    expect(() => {
      (CATEGORIES as unknown as CategoryDetailsList).push({ name: "Boats" });
    }).toThrow();
  });

  it("has no route that adds, renames, or removes a Category", () => {
    const changes = api.routes.filter(
      (route) => route.method !== "GET" && /categor/i.test(route.path),
    );
    expect(changes).toEqual([]);
  });
});

type CategoryDetailsList = { name: string }[];

describe("Category group totals", () => {
  it("sums each Category group's Categories", () => {
    const totals: Partial<Record<Category, number>> = {
      Housing: 180_000,
      Utilities: 21_450,
      Groceries: 64_210,
      Superstores: 38_990,
      Restaurants: 22_500,
      Hobbies: 4_999,
    };

    expect(categoryGroupTotals(totals)).toEqual({
      Bills: 201_450,
      Shopping: 103_200,
      Transportation: 0,
      "Health and care": 0,
      Leisure: 27_499,
      Other: 0,
    });
  });

  it("gives each Category group's total as the sum of its own Categories only", () => {
    const totals = Object.fromEntries(CATEGORIES.map((category) => [category.name, 1])) as Record<
      Category,
      number
    >;
    const sums = categoryGroupTotals(totals);
    for (const group of CATEGORY_GROUPS) {
      expect(sums[group.name], group.name).toBe(group.categories.length);
    }
  });
});

describe("the Superstores list", () => {
  it("ships with the 9 Merchants the spec names", () => {
    expect([...SUPERSTORES]).toEqual([
      "Walmart",
      "Target",
      "Costco",
      "Sam's Club",
      "BJ's",
      "Amazon",
      "Dollar General",
      "Dollar Tree",
      "Family Dollar",
    ]);
  });

  it("finds a Merchant by its clean name, without case, spaces, or punctuation", () => {
    expect(isSuperstore({ name: "SAMS CLUB" })).toBe(true);
    expect(isSuperstore({ name: "dollar-tree" })).toBe(true);
    expect(isSuperstore({ name: "Amazon Prime" })).toBe(false);
    expect(isSuperstore({ name: "Targeted Fitness" })).toBe(false);
    expect(isSuperstore(null)).toBe(false);
  });
});
