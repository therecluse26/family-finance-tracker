import type { MiddlewareHandler } from "hono";
import type { ServerEnv } from "./env.ts";

// The browser rules every answer carries, in both Security modes: pages, static files, the SPA
// fallback, API JSON, 401 and 404 answers, /healthz, and the security check's refusal pages.
// The page runs only the app's own scripts and Plaid Link's, which Plaid requires to load from its
// own CDN (Settings, Banks). Link opens in a frame from that CDN. No other site can frame the app,
// so no page can trick a Member into a one-click write, and no inline script or style runs even if
// bank text ever got past React's escaping.
const PLAID_CDN = "https://cdn.plaid.com";

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${PLAID_CDN}`,
  `style-src 'self' ${PLAID_CDN}`,
  `img-src 'self' data: ${PLAID_CDN}`,
  `frame-src ${PLAID_CDN}`,
  "connect-src 'self' https://production.plaid.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export const SAFETY_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// Runs first, so it sees every answer, even an error's. An answer that already sets one of these
// headers, such as a refusal page's stricter policy, keeps its own.
export const safetyHeaders: MiddlewareHandler<ServerEnv> = async (c, next) => {
  await next();
  for (const [name, value] of Object.entries(SAFETY_HEADERS)) {
    if (!c.res.headers.has(name)) c.header(name, value);
  }
};
