import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, type ErrorHandler, Hono, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AiSettings } from "../ai/index.ts";
import type { Auth } from "../auth/index.ts";
import {
  bankConnecting,
  connectionRemoving,
  connectionRepairing,
  type PlaidSettings,
} from "../bank/index.ts";
import type { Database } from "../db/index.ts";
import type { Logger } from "../log.ts";
import type { Secrets } from "../secrets/index.ts";
import { aboutRoutes } from "./about.ts";
import { alertRoutes } from "./alerts.ts";
import { api } from "./api.ts";
import { bankViews } from "./bank-data.ts";
import { benchmarkRoutes } from "./benchmarks.ts";
import { budgetRoutes } from "./budgets.ts";
import { categoryRoutes } from "./categories.ts";
import type { ServerEnv } from "./env.ts";
import { goalRoutes } from "./goals.ts";
import { householdRoutes } from "./household.ts";
import { masterKeyRoutes } from "./master-key.ts";
import { moneyMovementRoutes } from "./money-movement.ts";
import { noticeRoutes } from "./notices.ts";
import { pictureRoutes } from "./pictures.ts";
import { recurringRoutes } from "./recurring.ts";
import { reviewRoutes } from "./review.ts";
import { type Security, securityCheck } from "./security-mode.ts";
import { readSetupState } from "./setup.ts";

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

// Every API route except /api/auth/* and /api/setup needs a session (spec 09). Using the session renews it.
function requireSession(auth: Auth): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const signedIn = await auth.signedIn(c.req.raw, c.var.clientAddress);
    if (signedIn === undefined) return c.json({ error: "Sign in first" }, 401);
    for (const cookie of signedIn.setCookies) c.header("Set-Cookie", cookie, { append: true });
    c.set("member", signedIn.member);
    c.set("checkFreshCode", (code) => auth.checkFreshCode(c.req.raw, c.var.clientAddress, code));
    await next();
  };
}

// Before the routes under /api/plaid/ and /api/ai/, which store Master-key secrets. No Plaid key,
// Plaid token, or AI key is stored until the first-run wizard's required steps are done (spec 12):
// until then, every route but a GET answers 409. They take only JSON bodies, so a form on another
// site cannot post to them. An app made without the service answers 404.
function secretRoutes<Name extends "plaid" | "ai">(
  database: Database,
  name: Name,
  service: ServerEnv["Variables"][Name] | undefined,
): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    if (service === undefined) return c.json({ error: "Not found" }, 404);
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if ((await readSetupState(database)).wizard) {
        return c.json({ error: "Finish the first-run wizard first." }, 409);
      }
      if (!sendsJson(c)) return c.json({ error: "Send JSON." }, 415);
    }
    c.set(name, service);
    await next();
  };
}

const sendsJson = (c: Context<ServerEnv>) =>
  c.req.header("content-type")?.split(";")[0]?.trim() === "application/json";

// The Connection routes, which remove a Connection or open its update mode, take only JSON bodies,
// as the Plaid routes do: a form on another site cannot post to them.
const jsonOnly: MiddlewareHandler<ServerEnv> = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD" && !sendsJson(c)) {
    return c.json({ error: "Send JSON." }, 415);
  }
  await next();
};

// A route that changes data answers only the app's own pages: the request's Origin must be
// APP_URL's. The session cookie is SameSite=Lax, which still lets a page on another port or
// subdomain of the same site send it.
function sameOriginChanges(appOrigin: string): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    const reads = c.req.method === "GET" || c.req.method === "HEAD";
    if (!reads && c.req.header("origin") !== appOrigin) {
      return c.json({ error: "Cross-site request refused" }, 403);
    }
    await next();
  };
}
// Until the wizard's step 3 is done, the API stores no Master-key secret (spec 12, Order and resume
// rules). It refuses every write but step 3's own paste-back, so no route can store one early.
const PASTE_BACK = "/api/setup/master-key";

const masterKeyFirst: MiddlewareHandler<ServerEnv> = async (c, next) => {
  const write = c.req.method !== "GET" && c.req.method !== "HEAD";
  if (write && c.req.path !== PASTE_BACK && !(await c.var.masterKey.saved())) {
    return c.json({ error: "Save the Master key first: finish step 3 of setup." }, 409);
  }
  await next();
};

export function createApp(
  webRoot: string,
  security: Security,
  auth: Auth,
  database: Database,
  secrets: Secrets,
  services: { plaid?: PlaidSettings; ai?: AiSettings } = {},
) {
  const bank = bankViews(database);
  const masterKey = masterKeyRoutes(database, secrets);
  const notices = noticeRoutes(database);
  const reviewList = reviewRoutes(database);
  const household = householdRoutes(database);
  const moneyMovement = moneyMovementRoutes(database);
  const categories = categoryRoutes(database);
  const recurring = recurringRoutes(database);
  const alerts = alertRoutes(database);
  const about = aboutRoutes(database);
  const benchmarks = benchmarkRoutes(database);
  const budgets = budgetRoutes(database);
  const goals = goalRoutes(database);
  const pictures = pictureRoutes(database);
  const plaidConnecting = bankConnecting("plaid");
  const removing = connectionRemoving();
  const repairing = connectionRepairing();
  return (
    new Hono<ServerEnv>()
      .use(thrownValuesAsErrors)
      // The only route before the security check: it answers any source and any Host.
      .get("/healthz", (c) => c.json({ status: "ok" }))
      .use(securityCheck(security))
      .all("/api/auth/*", (c) => auth.handle(c.req.raw, c.var.clientAddress))
      // The wizard's progress, which every page reads, before any Member can sign in. It says only
      // which step comes next.
      .get("/api/setup", async (c) => c.json(await readSetupState(database)))
      .use("/api/*", requireSession(auth))
      .use("/api/*", sameOriginChanges(security.appUrl.origin))
      .use("/api/*", async (c, next) => {
        c.set("bank", bank);
        c.set("masterKey", masterKey);
        c.set("notices", notices);
        c.set("reviewList", reviewList);
        c.set("household", household);
        c.set("moneyMovement", moneyMovement);
        c.set("categories", categories);
        c.set("recurring", recurring);
        c.set("alerts", alerts);
        c.set("about", about);
        c.set("benchmarks", benchmarks);
        c.set("budgets", budgets);
        c.set("goals", goals);
        c.set("pictures", pictures);
        c.set("plaidConnecting", plaidConnecting);
        c.set("removing", removing);
        c.set("repairing", repairing);
        await next();
      })
      .use("/api/*", masterKeyFirst)
      .use("/api/connections/*", jsonOnly)
      // A Member's Category for a Transaction takes only a JSON body.
      .use("/api/transactions/:id/category", jsonOnly)
      // So does a typed Steady Income figure.
      .use("/api/steady-income", jsonOnly)
      .use("/api/plaid/*", secretRoutes(database, "plaid", services.plaid))
      .use("/api/ai/*", secretRoutes(database, "ai", services.ai))
      .route("/api", api)
      .all("/api/*", (c) => c.json({ error: "Not found" }, 404))
      .use(serveStatic({ root: webRoot }))
      .get("*", serveStatic({ root: webRoot, path: "index.html" }))
      .onError(routeFailed(security.logger))
  );
}
