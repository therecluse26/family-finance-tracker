import type { APIError } from "better-auth/api";
import {
  addSignInTries,
  countSignInTries,
  type Database,
  removeSignInTries,
  removeSignInTriesUpTo,
} from "../db/index.ts";
import { CLIENT_ADDRESS_HEADER } from "./sign-in-limit.ts";

// The wrong-token limit of one-use links, such as invite and reset links (spec 09): 5 wrong tokens
// per 15 minutes per IP address, as for failed sign-ins. Past that, every token is refused without
// being checked.

export const WRONG_LINK_TOKENS_ALLOWED = 5;
export const WRONG_LINK_TOKEN_WINDOW_MS = 15 * 60 * 1000;

type EndpointContext = { headers?: Headers; request?: Request };

// Checks a token from a link and returns what `find` found for it. The try is counted as wrong
// before the check, in the same step as the count, so of tries at the same time only the first 5
// in the window are checked. A wrong token, and a token refused because too many were wrong, stay
// counted; a right one is taken back.
export async function tryLinkToken<T>(
  database: Database,
  ctx: EndpointContext,
  link: {
    // The sign-in tries key prefix of this kind of link, such as "invite-ip:".
    keyPrefix: string;
    find: () => Promise<T | undefined>;
    tooMany: () => APIError;
    notOpen: () => APIError;
  },
): Promise<T> {
  const address = (ctx.request?.headers ?? ctx.headers)?.get(CLIENT_ADDRESS_HEADER) ?? "";
  const now = new Date();
  const since = new Date(now.getTime() - WRONG_LINK_TOKEN_WINDOW_MS);
  await removeSignInTriesUpTo(database, since);
  const [added] = await addSignInTries(database, [`${link.keyPrefix}${address}`], now);
  if (added === undefined) throw new Error("No try was added.");
  if ((await countSignInTries(database, added.key, since, added.id)) > WRONG_LINK_TOKENS_ALLOWED) {
    throw link.tooMany();
  }
  const found = await link.find();
  if (found === undefined) throw link.notOpen();
  await removeSignInTries(database, [added.id]);
  return found;
}
