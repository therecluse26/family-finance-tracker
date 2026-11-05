import { LARGE_PURCHASE_SHARE } from "../budgets/index.ts";
import { dateLabel, dollarsAndCents, monthLabel, percent, wholeDollars } from "../format.ts";

// What an Alert says (spec 06, Anomalies; Overspending Alerts; What an Alert says). A template
// states every fact, in the app's number formats (spec 07, Number formats): cents for a
// Transaction's amount, whole dollars for Spending and Budgets. No number comes from the AI.

// The Merchant, as identity knows it: the provider's Merchant ID when it has one, and the clean
// name the Alert shows.
export type MerchantFact = { id: string | null; name: string };

// A Category's Budget and its Spending in the purchase's month, or for a yearly Budget its year,
// in whole cents.
export type BudgetFact = {
  category: string;
  spent: number;
  budget: number;
  period: "monthly" | "yearly";
  // YYYY-MM for a monthly Budget, YYYY for a yearly one.
  span: string;
};

// Each Alert's facts. Amounts are whole cents spent; dates are YYYY-MM-DD.
export type AlertFacts =
  | {
      kind: "Duplicate charge";
      merchant: MerchantFact;
      account: string;
      amount: number;
      dates: [string, string];
    }
  | {
      kind: "Price increase";
      merchant: MerchantFact;
      base: number;
      amount: number;
      date: string;
      // The Recurring charge's ID, so a "Not a problem" press accepts the new price in it alone.
      recurringCharge: string;
    }
  | {
      kind: "New Recurring charge";
      merchant: MerchantFact;
      amount: number;
      dates: [string, string];
      nextDate: string;
    }
  | {
      kind: "Large purchase";
      merchant: MerchantFact;
      amount: number;
      date: string;
      budget: BudgetFact | null;
    }
  | {
      kind: "Over Budget";
      budget: BudgetFact;
      // The latest Spending in the Category in the Budget's month or year: its Spending in the
      // Category, its Merchant, or null with none, and its date.
      latest: { merchant: MerchantFact | null; amount: number; date: string };
    }
  | {
      kind: "On pace";
      budget: BudgetFact;
      // P, the projected month-end Spending, in whole cents.
      projected: number;
    }
  | {
      kind: "Card interest or fee";
      // True for interest on a credit card; false for any fee.
      cardInterest: boolean;
      merchant: MerchantFact | null;
      account: string;
      amount: number;
      date: string;
    };

// How a template writes each fact: as the app's text, or as the Household summary's pieces, where
// each number goes as a typed value (src/summary/summary.ts). `month` is YYYY-MM and `year` YYYY.
export type AlertWriter<Out> = {
  text: (text: string) => Out;
  // An amount in dollars and cents, such as $70.37.
  cents: (cents: number) => Out;
  // An amount in whole dollars, such as $1,234.
  dollars: (cents: number) => Out;
  percent: (ratio: number) => Out;
  date: (date: string) => Out;
  month: (month: string) => Out;
  year: (year: string) => Out;
};

// The template's pieces, in order, as `writer` writes them.
export function alertPieces<Out>(facts: AlertFacts, writer: AlertWriter<Out>): Out[] {
  const { cents, dollars, date } = writer;
  // A template, such as t`Fee: ${cents(amount)}`: its own words and each value of text are text.
  const t = (strings: TemplateStringsArray, ...values: (Out | string)[]): Out[] =>
    strings.flatMap((words, index) => {
      const value = values[index];
      const pieces = words === "" ? [] : [writer.text(words)];
      if (value === undefined) return pieces;
      return [...pieces, typeof value === "string" ? writer.text(value) : value];
    });
  // " at {Merchant}", or nothing for a Transaction with no Merchant, such as a bank's own fee.
  const atMerchant = (merchant: MerchantFact | null) =>
    merchant === null ? [] : t` at ${merchant.name}`;
  switch (facts.kind) {
    case "Duplicate charge": {
      const [first, second] = facts.dates;
      return t`Possible duplicate charge: ${cents(facts.amount)} at ${facts.merchant.name} on ${facts.account}, on ${date(first)} and ${date(second)}.`;
    }
    case "Price increase": {
      const rise = facts.amount - facts.base;
      return t`${facts.merchant.name} went up from ${cents(facts.base)} to ${cents(facts.amount)} (+${cents(rise)}, +${writer.percent(rise / facts.base)}) on ${date(facts.date)}.`;
    }
    case "New Recurring charge": {
      const [first, second] = facts.dates;
      return t`New Recurring charge? ${facts.merchant.name}, ${cents(facts.amount)} on ${date(first)} and ${date(second)}. Next expected ${date(facts.nextDate)}.`;
    }
    case "Large purchase": {
      const text = t`Large purchase: ${cents(facts.amount)} at ${facts.merchant.name} on ${date(facts.date)}. It is larger than ${writer.percent(LARGE_PURCHASE_SHARE)} of your purchases in the last 12 months.`;
      const { budget } = facts;
      if (budget === null) return text;
      const span =
        budget.period === "yearly" ? writer.year(budget.span) : writer.month(budget.span);
      return [
        ...text,
        ...t` ${budget.category}: ${dollars(budget.spent)} of its ${dollars(budget.budget)} Budget for ${span}.`,
      ];
    }
    case "Over Budget": {
      const { budget, latest } = facts;
      const spent = t`${dollars(budget.spent)} of ${dollars(budget.budget)}`;
      const head =
        budget.period === "yearly"
          ? [...t`${budget.category} is over its ${writer.year(budget.span)} Budget: `, ...spent]
          : [...t`${budget.category} is over Budget for ${writer.month(budget.span)}: `, ...spent];
      return [
        ...head,
        ...t`. Latest: ${cents(latest.amount)}`,
        ...atMerchant(latest.merchant),
        ...t` on ${date(latest.date)}.`,
      ];
    }
    case "On pace": {
      const { budget, projected } = facts;
      const over = writer.percent((projected - budget.budget) / budget.budget);
      return t`${budget.category} is on pace for ${dollars(projected)} in ${writer.month(budget.span)}, ${over} over its ${dollars(budget.budget)} Budget. Spent so far: ${dollars(budget.spent)}.`;
    }
    case "Card interest or fee": {
      if (facts.cardInterest) {
        return t`Card interest: ${cents(facts.amount)} on ${facts.account} on ${date(facts.date)}.`;
      }
      return [
        ...t`Fee: ${cents(facts.amount)}`,
        ...atMerchant(facts.merchant),
        ...t` on ${facts.account} on ${date(facts.date)}.`,
      ];
    }
  }
}

// The template's text, on the Household's date `today`.
export function alertText(facts: AlertFacts, today: string): string {
  return alertPieces<string>(facts, {
    text: (text) => text,
    cents: (cents) => dollarsAndCents(cents),
    dollars: (cents) => wholeDollars(cents),
    percent,
    date: (date) => dateLabel(date, today),
    month: (month) => monthLabel(`${month}-01`),
    year: (year) => year,
  }).join("");
}

// The heading of a merged Alert of `count` parts (spec 06, Merging), such as "2 Categories are over
// Budget". Each part's line follows it.
export function mergedHeading(kind: AlertFacts["kind"], count: number): string {
  switch (kind) {
    case "Duplicate charge":
      return `${count} Duplicate charges`;
    case "Price increase":
      return `${count} Price increases`;
    case "New Recurring charge":
      return `${count} New Recurring charges`;
    case "Large purchase":
      return `${count} Large purchases`;
    case "Over Budget":
      return `${count} Categories are over Budget`;
    case "On pace":
      return `${count} Categories are on pace to go over Budget`;
    case "Card interest or fee":
      return `${count} Card interest or fee charges`;
  }
}
