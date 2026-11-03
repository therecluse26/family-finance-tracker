import type { AppUrl } from "./app-url.ts";

// What the security check sets on every request it accepts, and the session check on every /api
// route outside /api/auth/.
export type ServerEnv = {
  Variables: {
    appUrl: AppUrl;
    // The source address, or the client a trusted proxy names in X-Forwarded-For.
    clientAddress: string;
    // The Member signed in on the request: the auth module's SignedInMember. Written out here,
    // since the web app's type check reads this file and runs without Node's types.
    member: { id: string; name: string; email: string };
  };
};
