import type { PlaidSettings } from "../bank/plaid-view.ts";
import type { AppUrl } from "./app-url.ts";
import type { BankViews } from "./bank-views.ts";

// What the security check sets on every request it accepts, and the session check on every /api
// route outside /api/auth/ and /api/setup.
export type ServerEnv = {
  Variables: {
    appUrl: AppUrl;
    // The source address, or the client a trusted proxy names in X-Forwarded-For.
    clientAddress: string;
    // The Member signed in on the request: the auth module's SignedInMember. Written out here,
    // since the web app's type check reads this file and runs without Node's types.
    member: { id: string; name: string; email: string };
    // The Accounts, Transactions, and Connections in app.db, for the routes that list them.
    bank: BankViews;
    // The sensitive-action check (spec 09, Signing in) for a code from the Member signed in on
    // this request. Its answer is the auth module's FreshCode, written out as member is.
    checkFreshCode: (code: string) => Promise<"fresh" | "wrong" | "too many tries">;
    // The Plaid keys and the count of Plaid Items, for the routes under /api/plaid/.
    plaid: PlaidSettings;
  };
};
