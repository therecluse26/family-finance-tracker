// The auth module's interface. Other modules import from here. It is the only module that imports
// Better Auth.
export {
  AUTH_BASE_PATH,
  type Auth,
  type AuthOptions,
  createAuth,
  type FreshCode,
  MIN_PASSWORD_LENGTH,
  SESSION_SECONDS,
  type SignedInMember,
} from "./auth.ts";
export {
  INVITE_LIFETIME_MS,
  WRONG_INVITE_TOKEN_WINDOW_MS,
  WRONG_INVITE_TOKENS_ALLOWED,
} from "./invites.ts";
export { LOGIN_RESET_LIFETIME_MS } from "./login-resets.ts";
export { FAILED_SIGN_IN_WINDOW_MS, FAILED_SIGN_INS_ALLOWED } from "./sign-in-limit.ts";
