import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, type ErrorHandler, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { type AiRequestLogRoutes, type AiSettings, aiRequestLogRoutes } from "../ai/index.ts";
import type { Auth } from "../auth/index.ts";
import {
  bankConnecting,
  connectionRemoving,
  connectionRepairing,
  type PlaidSettings,
} from "../bank/index.ts";
import type { Chat } from "../chat/index.ts";
import type { Database } from "../db/index.ts";
import type { GoalWriting } from "../goals/index.ts";
import type { Logger } from "../log.ts";
import type { SmtpSettings } from "../notify/email-view.ts";
import { channelSettings } from "../notify/index.ts";
import type { PushSettings } from "../notify/push-view.ts";
import type { AiWork } from "../redo/work-view.ts";
import type { Secrets } from "../secrets/index.ts";
import { weeklySummarySettings } from "../weekly-summary/index.ts";
import { aboutRoutes } from "./about.ts";
import { aiBoxRoutes } from "./ai-box.ts";
import { alertRoutes } from "./alerts.ts";
import { amazonRoutes } from "./amazon.ts";
import { api } from "./api.ts";
import { backupRoutes } from "./backups.ts";
import { bankViews } from "./bank-data.ts";
import { benchmarkRoutes } from "./benchmarks.ts";
import { budgetRoutes } from "./budgets.ts";
import { categoryRoutes } from "./categories.ts";
import { chatRoutes } from "./chat.ts";
import { comingUpRoutes } from "./coming-up.ts";
import { dataExportRoutes } from "./data-export.ts";
import { deviceRoutes } from "./devices.ts";
import type { ServerEnv } from "./env.ts";
import { goalRoutes } from "./goals.ts";
import { householdRoutes } from "./household.ts";
import { masterKeyRoutes } from "./master-key.ts";
import { memberRoutes } from "./members.ts";
import { moneyMovementRoutes } from "./money-movement.ts";
import { monthlyReviewRoutes } from "./monthly-reviews.ts";
import { noticeRoutes } from "./notices.ts";
import { pictureRoutes } from "./pictures.ts";
import { proposalRoutes } from "./proposals.ts";
import { recurringRoutes } from "./recurring.ts";
import { reportRoutes } from "./reports.ts";
import { reviewRoutes } from "./review.ts";
import { safetyHeaders } from "./safety-headers.ts";
import { type Security, securityCheck } from "./security-mode.ts";
import { readSetupState, setupRoutes } from "./setup.ts";
import { topMerchantRoutes } from "./top-merchants.ts";

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
    c.set("sessionId", signedIn.sessionId);
    await next();
  };
}

// Before the routes under /api/plaid/, /api/ai/, /api/smtp/, and /api/push/, which store or use
// Master-key secrets. No Plaid key, Plaid token, AI key, SMTP password, or VAPID key is stored until
// the first-run wizard's required steps are done (spec 12):
// until then, every route but a GET answers 409. They take only JSON bodies, so a form on another
// site cannot post to them. An app made without the service answers 404.
function secretRoutes<Name extends "plaid" | "ai" | "smtp" | "push">(
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
// In plain-HTTP mode the app is not installable and offers no push (spec 09, Security mode): the
// page names no manifest, and the manifest and the service worker are not served. The page's own
// script removes the link too, for a page a browser kept from before.
const MANIFEST_LINK = /<link rel="manifest"[^>]*>/g;
const INSTALL_FILES = new Set(["/manifest.webmanifest", "/sw.js"]);

function installableOverHttpsOnly(mode: "https" | "http"): MiddlewareHandler<ServerEnv> {
  return async (c, next) => {
    if (mode === "https") return next();
    if (INSTALL_FILES.has(c.req.path)) return c.text("Not found", 404);
    await next();
    if (c.res.status !== 200 || !c.res.headers.get("content-type")?.startsWith("text/html")) return;
    const page = (await c.res.text()).replace(MANIFEST_LINK, "");
    c.res = new Response(page, c.res);
    c.res.headers.delete("content-length");
  };
}

export const jsonOnly: MiddlewareHandler<ServerEnv> = async (c, next) => {
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
// The largest body a route takes: a 20,000-character Chat message or Goal's words, which in a
// script of 3-byte characters is 60,000 bytes of JSON, with room for what useChat sends with it.
// The one route that takes a file, the Amazon order file upload, has its own limit, and reads its
// body only after the session and Origin checks.
export const MAX_REQUEST_BODY_BYTES = 128 * 1024;
const AMAZON_UPLOAD = "/api/amazon/import";

const appBodyLimit = bodyLimit({
  maxSize: MAX_REQUEST_BODY_BYTES,
  onError: (c) => c.json({ error: "The request is too large." }, 413),
});

const requestBodyLimit: MiddlewareHandler<ServerEnv> = (c, next) =>
  c.req.method === "POST" && c.req.path === AMAZON_UPLOAD ? next() : appBodyLimit(c, next);

// Until the wizard's step 3 is done, the API stores no Master-key secret (spec 12, Order and resume
// rules). It refuses every write but step 3's own "I saved it", so no route can store one early.
const SAVED_IT = "/api/setup/master-key";

const masterKeyFirst: MiddlewareHandler<ServerEnv> = async (c, next) => {
  const write = c.req.method !== "GET" && c.req.method !== "HEAD";
  if (write && c.req.path !== SAVED_IT && !(await c.var.masterKey.saved())) {
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
  services: {
    plaid?: PlaidSettings;
    ai?: AiSettings;
    // The AI request log's routes: app.db's own, unless a test gives its own.
    aiRequestLog?: AiRequestLogRoutes;
    smtp?: SmtpSettings;
    push?: PushSettings;
    // Chat's answers. Without it, Chat says AI is not set up.
    chat?: Chat;
    // Adding a Goal and editing its words, with the AI's reading. Without it, no Goal is added.
    goalWriting?: GoalWriting;
    // AI work on your Transactions, under /api/ai/work. Without it, those routes answer 404.
    aiWork?: AiWork;
    // `pnpm dev`'s own routes, under /api/dev. The built app has none, so each answers 404.
    devRoutes?: Hono<ServerEnv>;
  } = {},
) {
  const bank = bankViews(database);
  const masterKey = masterKeyRoutes(database, secrets);
  const setup = setupRoutes(database);
  const notices = noticeRoutes(database);
  const reviewList = reviewRoutes(database);
  const household = householdRoutes(database);
  const moneyMovement = moneyMovementRoutes(database);
  const categories = categoryRoutes(database);
  const recurring = recurringRoutes(database);
  const alerts = alertRoutes(database);
  const about = aboutRoutes(database);
  const backups = backupRoutes();
  const benchmarks = benchmarkRoutes(database);
  const budgets = budgetRoutes(database);
  const goals = goalRoutes(database, services.goalWriting);
  const pictures = pictureRoutes(database);
  const comingUp = comingUpRoutes(database);
  const channels = channelSettings(database);
  const weeklySummary = weeklySummarySettings(database);
  const aiRequestLog = services.aiRequestLog ?? aiRequestLogRoutes({ database });
  const topMerchants = topMerchantRoutes(database);
  const reports = reportRoutes(database);
  const aiBox = aiBoxRoutes(database, services.ai);
  const proposals = proposalRoutes(database);
  const monthlyReviews = monthlyReviewRoutes(database);
  const chat = chatRoutes(database, services.chat);
  const plaidConnecting = bankConnecting("plaid");
  const removing = connectionRemoving();
  const repairing = connectionRepairing();
  const dataExport = dataExportRoutes(database, bank, security.logger);
  const amazon = amazonRoutes(database, security.logger);
  const members = memberRoutes(database, auth, security.appUrl);
  const devices = deviceRoutes(auth);
  return (
    new Hono<ServerEnv>()
      .use(safetyHeaders)
      .use(thrownValuesAsErrors)
      // The only route before the security check: it answers any source and any Host.
      .get("/healthz", (c) => c.json({ status: "ok" }))
      .use(securityCheck(security))
      // Before any route reads a body, Better Auth's included.
      .use("/api/*", requestBodyLimit)
      // The first-run wizard's setup code and first Member answer only the app's own pages, and
      // only JSON, so a page on another site cannot spend the setup code's tries.
      .use("/api/auth/first-member/*", sameOriginChanges(security.appUrl.origin))
      .use("/api/auth/first-member/*", jsonOnly)
      // Joining by invite link needs no session, so Better Auth's own check, which lets a request
      // with no cookie and no Origin through, is not enough: these routes answer only the app's
      // own pages, and only JSON.
      .use("/api/auth/invite/*", sameOriginChanges(security.appUrl.origin))
      .use("/api/auth/invite/*", jsonOnly)
      // So does setting a new login by reset link.
      .use("/api/auth/login-reset/*", sameOriginChanges(security.appUrl.origin))
      .use("/api/auth/login-reset/*", jsonOnly)
      // So does signing in with a passkey, and so do the passkey routes of a signed-in Member.
      .use("/api/auth/passkey/*", sameOriginChanges(security.appUrl.origin))
      .use("/api/auth/passkey/*", jsonOnly)
      .all("/api/auth/*", (c) => auth.handle(c.req.raw, c.var.clientAddress))
      // The wizard's progress, which every page reads, before any Member can sign in. It says only
      // which step comes next.
      .get("/api/setup", async (c) => c.json(await readSetupState(database)))
      .use("/api/*", requireSession(auth))
      .use("/api/*", sameOriginChanges(security.appUrl.origin))
      .use("/api/*", async (c, next) => {
        c.set("bank", bank);
        c.set("masterKey", masterKey);
        c.set("setup", setup);
        c.set("notices", notices);
        c.set("reviewList", reviewList);
        c.set("household", household);
        c.set("moneyMovement", moneyMovement);
        c.set("categories", categories);
        c.set("recurring", recurring);
        c.set("alerts", alerts);
        c.set("about", about);
        c.set("backups", backups);
        c.set("benchmarks", benchmarks);
        c.set("budgets", budgets);
        c.set("goals", goals);
        c.set("pictures", pictures);
        c.set("comingUp", comingUp);
        c.set("channels", channels);
        c.set("weeklySummary", weeklySummary);
        c.set("aiRequestLog", aiRequestLog);
        c.set("topMerchants", topMerchants);
        c.set("reports", reports);
        c.set("aiBox", aiBox);
        c.set("proposals", proposals);
        c.set("monthlyReviews", monthlyReviews);
        c.set("chat", chat);
        c.set("plaidConnecting", plaidConnecting);
        c.set("removing", removing);
        c.set("repairing", repairing);
        c.set("dataExport", dataExport);
        c.set("amazon", amazon);
        c.set("members", members);
        c.set("devices", devices);
        c.set("aiWork", services.aiWork);
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
      .use("/api/smtp/*", secretRoutes(database, "smtp", services.smtp))
      .use("/api/push/*", secretRoutes(database, "push", services.push))
      // A Member's own channels take only a JSON body.
      .use("/api/alert-channels", jsonOnly)
      .use("/api/weekly-summary", jsonOnly)
      // So does the AI request log's switch.
      .use("/api/ai-request-log/settings", jsonOnly)
      .route("/api", api)
      .route("/api/dev", services.devRoutes ?? new Hono<ServerEnv>())
      .all("/api/*", (c) => c.json({ error: "Not found" }, 404))
      .use(installableOverHttpsOnly(security.appUrl.mode))
      .use(serveStatic({ root: webRoot }))
      .get("*", serveStatic({ root: webRoot, path: "index.html" }))
      .onError(routeFailed(security.logger))
  );
}
