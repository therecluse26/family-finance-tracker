import {
  accounts,
  members,
  passkeys,
  rateLimits,
  sessions,
  twoFactors,
  verifications,
} from "./schema.ts";

// Better Auth's tables under its own model names, for its Drizzle adapter in the auth module.
export const loginTables = {
  user: members,
  session: sessions,
  account: accounts,
  verification: verifications,
  twoFactor: twoFactors,
  rateLimit: rateLimits,
  passkey: passkeys,
};
