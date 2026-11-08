import type { Category } from "../categories/list.ts";

// Travel and Gifts and donations have yearly Budgets, over the calendar year (spec 05, Yearly
// Budgets). Every other Budget is monthly. This file imports only the Category list, so the web
// app can read it too.
export const YEARLY_CATEGORIES: readonly Category[] = Object.freeze([
  "Travel",
  "Gifts and donations",
]);
