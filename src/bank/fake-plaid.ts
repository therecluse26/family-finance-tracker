// Test support: a fake Plaid server on 127.0.0.1, which Plaid's real client talks to in place of
// Plaid. It answers with responses written by hand in Plaid's shape, so no test calls Plaid. Every
// token it hands out is made when the test runs.
import { readFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PlaidApi } from "plaid";
import type { PlaidClientFor } from "./plaid.ts";
import { plaidConfiguration } from "./plaid-keys.ts";

// Plaid's answers, written by hand in Plaid's shape. They hold no real data.
export const RECORDED = JSON.parse(
  readFileSync(new URL("./plaid-recorded.json", import.meta.url), "utf8"),
) as {
  accountsGet: { accounts: Record<string, unknown>[] };
  liabilitiesGet: unknown;
  transactionsSync: Record<string, unknown>[];
  // Without its item_id, which a test makes.
  itemGet: { item: Record<string, unknown> };
  itemRemove: unknown;
};

// A fake Plaid answer: a JSON body with a status, a redirect, or a dropped connection.
export type Answer = { status?: number; body: unknown } | { redirect: string } | "hang up";

export type PlaidRequest = {
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
};

// Plaid's error body.
export function plaidFailure(type: string, code: string, message = "Plaid's message.") {
  return {
    error_type: type,
    error_code: code,
    error_message: message,
    display_message: null,
    request_id: "req-failed",
  };
}

// Made-up tokens in the form Plaid hands out, made when the test runs. Never real tokens.
export const newLinkToken = () => `link-production-${crypto.randomUUID()}`;
export const newPublicToken = () => `public-production-${crypto.randomUUID()}`;
export const newAccessToken = () => `access-production-${crypto.randomUUID()}`;
export const newItemId = () => crypto.randomUUID().replaceAll("-", "");

// A hand-written /accounts/get Account in Plaid's shape: a checking Account unless the fields say
// otherwise. Its account_id is Plaid's, and differs for each Item.
export function plaidAccount(
  fields: { account_id: string; mask: string } & Record<string, unknown>,
) {
  return {
    balances: {
      available: 100,
      current: 100,
      limit: null,
      iso_currency_code: "USD",
      unofficial_currency_code: null,
    },
    name: "Plaid Checking",
    official_name: null,
    type: "depository",
    subtype: "checking",
    ...fields,
  };
}

// A hand-written posted Transaction in Plaid's /transactions/sync shape. Plaid's amount is
// positive for money out.
export function plaidTransaction(fields: {
  transaction_id: string;
  account_id: string;
  date: string;
  amount?: number;
}) {
  return {
    amount: 10,
    iso_currency_code: "USD",
    unofficial_currency_code: null,
    authorized_date: null,
    datetime: null,
    authorized_datetime: null,
    pending: false,
    pending_transaction_id: null,
    name: `FAKE ${fields.transaction_id}`,
    original_description: `FAKE ${fields.transaction_id}`,
    merchant_name: null,
    merchant_entity_id: null,
    logo_url: null,
    website: null,
    payment_channel: "other",
    account_owner: null,
    transaction_code: null,
    counterparties: [],
    personal_finance_category: null,
    ...fields,
  };
}

// A hand-written last /transactions/sync page: it adds `added`, and history is loaded.
export function plaidSyncPage(nextCursor: string, added: unknown[] = []) {
  return {
    added,
    modified: [],
    removed: [],
    accounts: [],
    next_cursor: nextCursor,
    has_more: false,
    transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    request_id: `req-${nextCursor}`,
  };
}

// A fake Plaid server. Each path answers from its queue in order; its last answer repeats.
export class FakePlaid {
  readonly requests: PlaidRequest[] = [];
  private readonly answers = new Map<string, Answer[]>();
  private readonly server: Server = createServer((req, res) => {
    let text = "";
    req.on("data", (chunk) => {
      text += chunk;
    });
    req.on("end", () => {
      const path = req.url ?? "";
      this.requests.push({ path, headers: req.headers, body: JSON.parse(text || "{}") });
      const queue = this.answers.get(path) ?? [];
      const answer = (queue.length > 1 ? queue.shift() : queue[0]) ?? {
        status: 400,
        body: plaidFailure("INVALID_REQUEST", "UNKNOWN_FIELDS"),
      };
      if (answer === "hang up") {
        req.socket.destroy();
      } else if ("redirect" in answer) {
        res.writeHead(307, { location: answer.redirect });
        res.end();
      } else {
        res.writeHead(answer.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(answer.body));
      }
    });
  });
  private url: string | undefined;

  answer(path: string, ...answers: Answer[]): void {
    this.answers.set(path, answers);
  }

  // The requests to one path.
  to(path: string): PlaidRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  // Plaid's real client, with the app's configuration, pointed at this server.
  readonly clientFor: PlaidClientFor = (keys) => {
    const configuration = plaidConfiguration(keys);
    if (this.url === undefined) throw new Error("Start the fake Plaid server first.");
    // Only here: the fake Plaid server in place of Plaid, so the test stays offline.
    configuration.basePath = this.url;
    return new PlaidApi(configuration);
  };

  close(): Promise<unknown> {
    return new Promise((resolve) => this.server.close(resolve));
  }
}
