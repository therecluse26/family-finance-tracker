import { Hono } from "hono";
import type { ServerEnv } from "./env.ts";

export const api = new Hono<ServerEnv>()
  .get("/ping", (c) => c.json({ ok: true }))
  .get("/security-mode", (c) => c.json({ mode: c.var.appUrl.mode, appUrl: c.var.appUrl.origin }));

export type Api = typeof api;
