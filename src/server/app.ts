import { serveStatic } from "@hono/node-server/serve-static";
import { type ErrorHandler, Hono } from "hono";
import type { Logger } from "../log.ts";
import { api } from "./api.ts";
import type { ServerEnv } from "./env.ts";
import { type Security, securityCheck } from "./security-mode.ts";

// Hono's own error handler writes the error and its stack trace to stderr, outside the logger, and
// an error message can hold a secret value. This one writes one line through the logger, which
// refuses registered secret values, and answers 500 with no details.
function routeFailed(logger: Logger): ErrorHandler<ServerEnv> {
  return (error, c) => {
    try {
      logger.error("A request failed", { error });
    } catch {
      // Only in tests and development, where the logger throws on a secret instead of refusing it.
      logger.error("A request failed, and its error held a secret");
    }
    return c.json({ error: "Internal error" }, 500);
  };
}

export function createApp(webRoot: string, security: Security) {
  return (
    new Hono<ServerEnv>()
      // The only route before the security check: it answers any source and any Host.
      .get("/healthz", (c) => c.json({ status: "ok" }))
      .use(securityCheck(security))
      .route("/api", api)
      .all("/api/*", (c) => c.json({ error: "Not found" }, 404))
      .use(serveStatic({ root: webRoot }))
      .get("*", serveStatic({ root: webRoot, path: "index.html" }))
      .onError(routeFailed(security.logger))
  );
}
