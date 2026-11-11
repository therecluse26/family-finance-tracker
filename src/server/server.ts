import { serve } from "@hono/node-server";
import type { AiSettings } from "../ai/index.ts";
import type { Auth } from "../auth/index.ts";
import type { PlaidSettings } from "../bank/index.ts";
import type { Chat } from "../chat/index.ts";
import type { Database } from "../db/index.ts";
import type { PriceSourceAdapter } from "../deal-finder/index.ts";
import type { GoalWriting } from "../goals/index.ts";
import type { SmtpSettings } from "../notify/email-view.ts";
import type { PushSettings } from "../notify/push-view.ts";
import type { AiWork } from "../redo/index.ts";
import type { Secrets } from "../secrets/index.ts";
import { createApp } from "./app.ts";
import type { Security } from "./security-mode.ts";

export type RunningServer = {
  port: number;
  close: () => Promise<void>;
};

export function startServer(options: {
  port: number;
  webRoot: string;
  security: Security;
  auth: Auth;
  database: Database;
  secrets: Secrets;
  plaid?: PlaidSettings;
  ai?: AiSettings;
  smtp?: SmtpSettings;
  push?: PushSettings;
  chat?: Chat;
  goalWriting?: GoalWriting;
  aiWork?: AiWork;
  priceSources?: PriceSourceAdapter;
}): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: createApp(
          options.webRoot,
          options.security,
          options.auth,
          options.database,
          options.secrets,
          {
            ...(options.plaid === undefined ? {} : { plaid: options.plaid }),
            ...(options.ai === undefined ? {} : { ai: options.ai }),
            ...(options.smtp === undefined ? {} : { smtp: options.smtp }),
            ...(options.push === undefined ? {} : { push: options.push }),
            ...(options.chat === undefined ? {} : { chat: options.chat }),
            ...(options.goalWriting === undefined ? {} : { goalWriting: options.goalWriting }),
            ...(options.aiWork === undefined ? {} : { aiWork: options.aiWork }),
            ...(options.priceSources === undefined ? {} : { priceSources: options.priceSources }),
          },
        ).fetch,
        port: options.port,
      },
      (info) => {
        resolve({
          port: info.port,
          close: () =>
            new Promise((done, fail) => {
              // An open live AI status stream would hold up the close (spec 10, HTTP routes).
              options.aiWork?.activity.stop();
              server.close((error) => (error ? fail(error) : done()));
            }),
        });
      },
    );
    server.once("error", reject);
  });
}
