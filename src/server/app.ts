import { serveStatic } from "@hono/node-server/serve-static";
import { type ErrorHandler, Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Auth } from "../auth/index.ts";
import type { Logger } from "../log.ts";
import { api } from "./api.ts";
import type { ServerEnv } from "./env.ts";
import { type Security, securityCheck } from "./security-mode.ts";

// A route threw a value that is not an Error, such as a string.
class ThrownValueError extends Error {
  override name = "ThrownValueError";
}

// Hono hands only an Error to onError, and lets any other thrown value escape with no log line.
// This turns such a value into an Error that names only its type, since the value can hold a
// secret.
const thrownValuesAsErrors: MiddlewareHandler<ServerEnv> = async (_c, next) => {
  try {
    await next();
  } catch (thrown) {
    if (thrown instanceof Error) throw thrown;
    throw new ThrownValueError(`A route threw a ${typeof thrown}, not an Error.`);
  }
};

// Hono's own error handler writes the error and its stack trace to stderr, outside the logger, and
// an error message can hold a secret value. This one writes one line through the logger, which
// refuses registered secret values, and answers 500 with no details. A 4xx HTTPException, such as
// the 400 for malformed JSON, keeps its own answer.
function routeFailed(logger: Logger): ErrorHandler<ServerEnv> {
  return (error, c) => {
    if (error instanceof HTTPException && error.status < 500) return error.getResponse();
    try {
      logger.error("A request failed", { error });
    } catch {
      // Only in tests and development, where the logger throws on a secret instead of refusing it.
      logger.error("A request failed, and its error held a secret");
    }
    return c.json({ error: "Internal error" }, 500);
  };
}

// Every API route except /api/auth/* needs a session (spec 09). Using the session renews it.
function requireSession(auth: Auth): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const signedIn = await auth.signedIn(c.req.raw, c.var.clientAddress);
    if (signedIn === undefined) return c.json({ error: "Sign in first" }, 401);
    for (const cookie of signedIn.setCookies) c.header("Set-Cookie", cookie, { append: true });
    c.set("member", signedIn.member);
    await next();
  };
}

export function createApp(webRoot: string, security: Security, auth: Auth) {
  return (
    new Hono<ServerEnv>()
      .use(thrownValuesAsErrors)
      // The only route before the security check: it answers any source and any Host.
      .get("/healthz", (c) => c.json({ status: "ok" }))
      .use(securityCheck(security))
      .all("/api/auth/*", (c) => auth.handle(c.req.raw, c.var.clientAddress))
      .use("/api/*", requireSession(auth))
      .route("/api", api)
      .all("/api/*", (c) => c.json({ error: "Not found" }, 404))
      .use(serveStatic({ root: webRoot }))
      .get("*", serveStatic({ root: webRoot, path: "index.html" }))
      .onError(routeFailed(security.logger))
  );
}
