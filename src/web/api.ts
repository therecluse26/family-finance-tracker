import { hc } from "hono/client";
import type { Api } from "../server/api.ts";

export const api = hc<Api>("/api");
