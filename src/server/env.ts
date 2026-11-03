import type { AppUrl } from "./app-url.ts";

// What the security check sets on every request it accepts.
export type ServerEnv = {
  Variables: {
    appUrl: AppUrl;
    // The source address, or the client a trusted proxy names in X-Forwarded-For.
    clientAddress: string;
  };
};
