import { serve } from "@hono/node-server";
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
}): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = serve(
      { fetch: createApp(options.webRoot, options.security).fetch, port: options.port },
      (info) => {
        resolve({
          port: info.port,
          close: () =>
            new Promise((done, fail) => {
              server.close((error) => (error ? fail(error) : done()));
            }),
        });
      },
    );
    server.once("error", reject);
  });
}
