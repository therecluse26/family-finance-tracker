import { LARGE_PURCHASE_SHARE } from "../budgets/index.ts";
import { dateLabel, dollarsAndCents, monthLabel, percent, wholeDollars } from "../format.ts";

// What an Alert says (spec 06, Anomalies; What an Alert says). A template states every fact, in
// the app's number formats (spec 07, Number formats): cents for a Transaction's amount, whole
// dollars for Spending and Budgets. No number comes from the AI.

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
    };

// The template's text, on the Household's date `today`.
export function alertText(facts: AlertFacts, today: string): string {
  const day = (date: string) => dateLabel(date, today);
  const money = dollarsAndCents;
  switch (facts.kind) {
    case "Duplicate charge": {
      const [first, second] = facts.dates;
      return `Possible duplicate charge: ${money(facts.amount)} at ${facts.merchant.name} on ${facts.account}, on ${day(first)} and ${day(second)}.`;
    }
    case "Price increase": {
      const rise = facts.amount - facts.base;
      return `${facts.merchant.name} went up from ${money(facts.base)} to ${money(facts.amount)} (+${money(rise)}, +${percent(rise / facts.base)}) on ${day(facts.date)}.`;
    }
    case "New Recurring charge": {
      const [first, second] = facts.dates;
      return `New Recurring charge? ${facts.merchant.name}, ${money(facts.amount)} on ${day(first)} and ${day(second)}. Next expected ${day(facts.nextDate)}.`;
    }
    case "Large purchase": {
      const text = `Large purchase: ${money(facts.amount)} at ${facts.merchant.name} on ${day(facts.date)}. It is larger than ${percent(LARGE_PURCHASE_SHARE)} of your purchases in the last 12 months.`;
      const { budget } = facts;
      if (budget === null) return text;
      const span = budget.period === "yearly" ? budget.span : monthLabel(`${budget.span}-01`);
      return `${text} ${budget.category}: ${wholeDollars(budget.spent)} of its ${wholeDollars(budget.budget)} Budget for ${span}.`;
    }
  }
}
