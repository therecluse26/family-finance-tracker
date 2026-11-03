import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { api } from "./api.ts";
import type { ServerEnv } from "./env.ts";
import { type Security, securityCheck } from "./security-mode.ts";

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
  );
}
