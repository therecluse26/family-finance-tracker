import type { LoanBody, ManualLoanBody } from "../server/money-movement-views.ts";
import { api } from "./api.ts";

// The edits a Member makes to an Account (spec 07, Account list), each through its own route. Each
// answers the route's response. The routes that read their body themselves are not named in the
// typed client, so each body goes in through a separate object.

export type UnconnectedAccountBody = {
  name: string;
  kind: string;
  institutionName: string;
  mask: string;
  // Whole cents, or null to keep the balance.
  balance: number | null;
};

export const accountEdits = {
  close: (id: string) => api.accounts[":id"].close.$post({ param: { id } }),
  reopen: (id: string) => api.accounts[":id"].reopen.$post({ param: { id } }),
  setExcluded: (id: string, excluded: boolean) => {
    const edit = { param: { id }, json: { excluded } };
    return api.accounts[":id"].exclude.$put(edit);
  },
  // A connected loan's Cash loan or Purchase loan type, and the APR a Member typed.
  setLoan: (id: string, body: LoanBody) => {
    const edit = { param: { id }, json: body };
    return api.accounts[":id"].loan.$put(edit);
  },
  // Adds an Unconnected account when the ID is null.
  saveUnconnectedAccount: (id: string | null, json: UnconnectedAccountBody) => {
    const edit = { param: { id: id ?? "" }, json };
    return id === null
      ? api["unconnected-accounts"].$post({ json })
      : api["unconnected-accounts"][":id"].$put(edit);
  },
  // Adds a Manual loan when the ID is null.
  saveManualLoan: (id: string | null, json: ManualLoanBody) => {
    const edit = { param: { id: id ?? "" }, json };
    return id === null
      ? api["manual-loans"].$post({ json })
      : api["manual-loans"][":id"].$put(edit);
  },
};
