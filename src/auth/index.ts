// The auth module's interface. Other modules import from here. It is the only module that imports
// Better Auth.
export {
  AUTH_BASE_PATH,
  type Auth,
  type AuthOptions,
  createAuth,
  MIN_PASSWORD_LENGTH,
  SESSION_SECONDS,
  type SignedInMember,
} from "./auth.ts";
export { FAILED_SIGN_IN_WINDOW_MS, FAILED_SIGN_INS_ALLOWED } from "./sign-in-limit.ts";
