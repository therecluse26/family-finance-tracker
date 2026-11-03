import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { api } from "./api.ts";

export function createApp(webRoot: string) {
  return new Hono()
    .get("/healthz", (c) => c.json({ status: "ok" }))
    .route("/api", api)
    .all("/api/*", (c) => c.json({ error: "Not found" }, 404))
    .use(serveStatic({ root: webRoot }))
    .get("*", serveStatic({ root: webRoot, path: "index.html" }));
}
