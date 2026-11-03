import { Hono } from "hono";

export const api = new Hono().get("/ping", (c) => c.json({ ok: true }));

export type Api = typeof api;
