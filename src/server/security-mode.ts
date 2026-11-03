import type { Context, MiddlewareHandler } from "hono";
import { html } from "hono/html";
import { type Logger, log } from "../log.ts";
import { type AppUrl, parseAppUrl } from "./app-url.ts";
import type { ServerEnv } from "./env.ts";
import { formatIp, parseIp } from "./ip-address.ts";
import { type Lookup, parseTrustedProxies, type TrustedProxies } from "./trusted-proxies.ts";

export type Security = { appUrl: AppUrl; proxies: TrustedProxies; logger: Logger };

type Refusal =
  | "wrong-host"
  | "not-from-trusted-proxy"
  | "unclear-source"
  | "unclear-request"
  | "unsupported-method";

const REFUSAL_LOG_INTERVAL_MS = 60_000;
const REFUSAL_LOG_MAX_PAIRS = 1_000;
const REFUSAL_LOG_MAX_LINES = 100;

const REFUSAL_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

// The Fetch Request constructor refuses these methods, so the check cannot rebuild the request.
const UNSUPPORTED_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
const ALLOWED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";

// The only request headers the client sends that a route sees, in c.req.raw and in the raw Node
// request. The check adds Host, X-Forwarded-For, and X-Forwarded-Proto itself. Every other
// header is dropped, so no route can read an address, host, scheme, or path the client wrote,
// under any name. A ticket that needs another header adds it here, with a security review.
const ROUTE_HEADERS = new Set([
  "content-length", // The size of a request body, which body readers and limits check.
  "content-type", // How to read a request body, such as JSON from the web app.
  "cookie", // The session cookie (spec 09, Sessions).
  "origin", // Better Auth compares it with APP_URL to refuse cross-site requests.
  "range", // serveStatic answers a Range request with part of a file.
  "referer", // Better Auth's cross-site check reads it when a request has no Origin.
  // The browser's Fetch Metadata. Better Auth refuses a sign-in form posted from another site,
  // and checks the Origin of any sign-in that carries these headers.
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent", // Better Auth stores it with each session.
]);

const PROXY_FIX =
  "With an http:// APP_URL, list the proxy's own address instead, such as TRUSTED_PROXIES=192.168.1.5.";

// Reads APP_URL and TRUSTED_PROXIES at start. Throws with the reason when the app must not start.
export async function loadSecurity(
  env: { APP_URL?: string; TRUSTED_PROXIES?: string },
  options: { lookup?: Lookup; logger?: Logger } = {},
): Promise<Security> {
  const logger = options.logger ?? log;
  const appUrl = parseAppUrl(env.APP_URL);
  const proxies = parseTrustedProxies(env.TRUSTED_PROXIES, { lookup: options.lookup, logger });
  if (appUrl.mode === "http" && proxies.entries.includes("*")) {
    throw new Error(
      `TRUSTED_PROXIES=* is only for platform services, which use an https:// APP_URL. ${PROXY_FIX}`,
    );
  }
  if (appUrl.mode === "http" && proxies.coversEveryAddress) {
    throw new Error(
      `TRUSTED_PROXIES covers every IPv4 or every IPv6 address, so it trusts every source, as * does. ${PROXY_FIX}`,
    );
  }
  logger.info("Security mode", {
    mode: appUrl.mode,
    appUrl: appUrl.origin,
    trustedProxies: proxies.entries,
  });
  if (appUrl.mode === "https" && proxies.entries.length === 0) {
    logger.warn(
      "TRUSTED_PROXIES is empty, so the app will refuse every request. In HTTPS mode it accepts only requests from a trusted proxy.",
    );
  }
  await proxies.refresh();
  return { appUrl, proxies, logger };
}

const isRouteHeader = (name: string) => ROUTE_HEADERS.has(name.toLowerCase());

type HeaderTable = Record<string, string | string[] | undefined>;

// The parts of Node's IncomingMessage that the check reads or rewrites.
type NodeRequest = {
  socket?: { remoteAddress?: unknown };
  url?: string;
  headers?: HeaderTable;
  headersDistinct?: HeaderTable;
  rawHeaders?: string[];
};

// Only this module reads the raw Node request. A guard test keeps it that way.
function nodeRequest(c: Context<ServerEnv>): NodeRequest | undefined {
  const env = c.env as { incoming?: NodeRequest } | undefined;
  return env?.incoming;
}

function socketAddress(c: Context<ServerEnv>): string | undefined {
  const address = nodeRequest(c)?.socket?.remoteAddress;
  // Node writes a link-local source with its zone, such as fe80::1%eth0.
  return typeof address === "string" ? address.replace(/%.*$/, "") : undefined;
}

// A proxy that adds to X-Forwarded-Proto keeps the earlier hops, so every hop must be https.
function marksHttps(forwardedProto: string | undefined): boolean {
  if (forwardedProto === undefined) return false;
  return forwardedProto.split(",").every((hop) => hop.trim().toLowerCase() === "https");
}

// Host must name APP_URL's host and port. So must an absolute request target, which HTTP
// puts ahead of Host.
function isSentToAppUrl(appUrl: AppUrl, host: string | undefined, target: URL): boolean {
  const lowerHost = host?.toLowerCase();
  const hasPort = /:\d+$/.test(appUrl.host);
  const hostMatches = lowerHost === appUrl.host || (!hasPort && lowerHost === `${appUrl.host}:80`);
  return hostMatches && target.host === appUrl.host;
}

type Checked = { clientAddress: string } | { refusal: Refusal; error?: string };

function check({ appUrl, proxies }: Security, c: Context<ServerEnv>): Checked {
  const target = new URL(c.req.url);
  // Only an absolute request target can hold a name and password. No request to the app needs one.
  if (target.username !== "" || target.password !== "") return { refusal: "unclear-request" };
  if (appUrl.mode === "http" && !isSentToAppUrl(appUrl, c.req.header("host"), target)) {
    return { refusal: "wrong-host" };
  }
  const source = socketAddress(c);
  if (source === undefined) return { refusal: "unclear-source" };
  const trusted = proxies.trusts(source);
  if (appUrl.mode === "https" && !(trusted && marksHttps(c.req.header("x-forwarded-proto")))) {
    return { refusal: "not-from-trusted-proxy" };
  }
  const forwardedFor = trusted ? c.req.header("x-forwarded-for") : undefined;
  const clientAddress = proxies.clientAddress(source, forwardedFor);
  return clientAddress === undefined ? { refusal: "unclear-source" } : { clientAddress };
}

type Vouched = [name: string, value: string][];

// The request a route sees: APP_URL's scheme and host, the allowed headers, and the ones the
// check vouches for. Its body is a stream with no trailers.
function checkedRequest(raw: Request, appUrl: AppUrl, path: string, vouched: Vouched): Request {
  const headers = new Headers();
  raw.headers.forEach((value, name) => {
    if (isRouteHeader(name)) headers.append(name, value);
  });
  for (const [name, value] of vouched) headers.set(name, value);
  return new Request(`${appUrl.origin}${path}`, {
    method: raw.method,
    headers,
    body: raw.body,
    signal: raw.signal,
    duplex: "half",
  });
}

// Gives the raw Node request the same path and headers, and no trailers, for a package that
// reads it.
function checkNodeRequest(incoming: NodeRequest | undefined, path: string, vouched: Vouched) {
  if (incoming === undefined) return;
  // Node builds headers and headersDistinct from rawHeaders when they are first read, so read
  // them before rawHeaders changes.
  const { headers = {}, headersDistinct = {}, rawHeaders = [] } = incoming;
  const kept = (table: HeaderTable) =>
    Object.entries(table).filter(([name]) => isRouteHeader(name));
  incoming.headers = Object.fromEntries([...kept(headers), ...vouched]);
  incoming.headersDistinct = Object.fromEntries([
    ...kept(headersDistinct),
    ...vouched.map(([name, value]) => [name, [value]]),
  ]);
  const keptRaw: string[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const [name = "", value = ""] = rawHeaders.slice(i, i + 2);
    if (isRouteHeader(name)) keptRaw.push(name, value);
  }
  incoming.rawHeaders = [...keptRaw, ...vouched.flat()];
  incoming.url = path;
  // Node writes trailers into the request when it parses the last chunk, which can be after a
  // route starts. Own accessors that read as empty and ignore those writes keep them out.
  const none = (empty: () => object) => ({ get: empty, set() {}, configurable: true });
  Object.defineProperties(incoming, {
    trailers: none(() => ({})),
    trailersDistinct: none(() => ({})),
    rawTrailers: none(() => []),
  });
}

// Checks the request, then rebuilds it for the routes. Any error refuses the request: an error
// that reached Hono would answer 500 and write a stack trace outside the logger.
function admit(security: Security, c: Context<ServerEnv>): Checked {
  try {
    const result = check(security, c);
    if ("refusal" in result) return result;
    if (UNSUPPORTED_METHODS.has(c.req.method.toUpperCase())) {
      return { refusal: "unsupported-method" };
    }
    const { appUrl } = security;
    const { pathname, search } = new URL(c.req.url);
    const path = `${pathname}${search}`;
    const vouched: Vouched = [
      ["host", appUrl.host],
      ["x-forwarded-for", result.clientAddress],
      ["x-forwarded-proto", appUrl.mode],
    ];
    c.req.raw = checkedRequest(c.req.raw, appUrl, path, vouched);
    checkNodeRequest(nodeRequest(c), path, vouched);
    return result;
  } catch (error) {
    // Only the error's name: its message can repeat the request target, with a password in it.
    return {
      refusal: "unclear-request",
      error: error instanceof Error ? error.name : typeof error,
    };
  }
}

const page = (title: string, body: ReturnType<typeof html>) => html`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
  </head>
  <body>
    <main>
      <h1>${title}</h1>
      ${body}
    </main>
  </body>
</html>
`;

function refuse(c: Context<ServerEnv>, refusal: Refusal, appUrl: AppUrl) {
  for (const [name, value] of Object.entries(REFUSAL_HEADERS)) c.header(name, value);
  switch (refusal) {
    case "wrong-host":
      return c.html(
        page(
          "Open the app at its own address",
          html`<p>This app answers only at <a href="${appUrl.address("/")}">${appUrl.origin}</a>.</p>
      <p>It uses plain HTTP, so it asks for a password only at that local address.</p>`,
        ),
        421,
      );
    case "not-from-trusted-proxy":
      return c.html(
        page(
          "Request refused",
          html`<p>This app answers only HTTPS requests that come through its trusted proxy.</p>`,
        ),
        403,
      );
    case "unclear-source":
      return c.html(
        page("Request refused", html`<p>The app could not tell where this request came from.</p>`),
        400,
      );
    case "unclear-request":
      return c.html(
        page("Request refused", html`<p>The app could not read this request.</p>`),
        400,
      );
    case "unsupported-method":
      c.header("Allow", ALLOWED_METHODS);
      return c.html(
        page("Request refused", html`<p>The app does not answer this kind of request.</p>`),
        405,
      );
  }
}

type RefusalFields = {
  reason: Refusal;
  source: string | undefined;
  host: string | undefined;
  error: string | undefined;
};

// Logs the first refusal for each reason and source in a minute. That pair's next line counts
// the ones it left out, and the map holds at most REFUSAL_LOG_MAX_PAIRS pairs. Across every pair
// it writes at most REFUSAL_LOG_MAX_LINES lines a minute. A minute after it first holds a line
// back, or drops a pair whose left-out refusals no line has counted, it writes one summary line.
function refusalLog(logger: Logger): (fields: RefusalFields) => void {
  const pairs = new Map<string, { start: number; skipped: number }>();
  let minute = { start: Number.NEGATIVE_INFINITY, lines: 0 };
  let heldBack = { lines: 0, refusals: 0 };
  let summary: ReturnType<typeof setTimeout> | undefined;

  const holdBack = (lines: number, refusals: number) => {
    heldBack = { lines: heldBack.lines + lines, refusals: heldBack.refusals + refusals };
    if (summary !== undefined) return;
    summary = setTimeout(() => {
      logger.warn("Held back refusal lines", {
        linesHeldBack: heldBack.lines,
        refusalsNotLogged: heldBack.refusals,
      });
      heldBack = { lines: 0, refusals: 0 };
      summary = undefined;
    }, REFUSAL_LOG_INTERVAL_MS);
    summary.unref();
  };

  return ({ reason, source, host, error }) => {
    const key = `${reason} ${source ?? ""}`;
    const now = Date.now();
    const open = pairs.get(key);
    if (open !== undefined && now - open.start < REFUSAL_LOG_INTERVAL_MS) {
      open.skipped += 1;
      return;
    }
    pairs.delete(key);
    if (pairs.size >= REFUSAL_LOG_MAX_PAIRS) {
      const [oldestKey, oldest] = pairs.entries().next().value ?? [];
      if (oldestKey !== undefined) pairs.delete(oldestKey);
      if (oldest !== undefined && oldest.skipped > 0) holdBack(0, oldest.skipped);
    }
    pairs.set(key, { start: now, skipped: 0 });
    const skippedInLastWindow = open?.skipped ?? 0;
    if (now - minute.start >= REFUSAL_LOG_INTERVAL_MS) minute = { start: now, lines: 0 };
    if (minute.lines >= REFUSAL_LOG_MAX_LINES) {
      holdBack(1, 1 + skippedInLastWindow);
      return;
    }
    minute.lines += 1;
    logger.warn("Refused a request", {
      reason,
      source,
      host,
      error,
      skippedInLastWindow,
    });
  };
}

function loggedSource(c: Context<ServerEnv>): string | undefined {
  const source = socketAddress(c);
  const parsed = source === undefined ? undefined : parseIp(source);
  return parsed === undefined ? source : formatIp(parsed);
}

// Undefined when the request cannot give its Host: the reason the check refused it.
function loggedHost(c: Context<ServerEnv>): string | undefined {
  try {
    const host = c.req.header("host");
    // A Host can hold a name and password before an @. The log keeps neither.
    return host?.slice(host.lastIndexOf("@") + 1).slice(0, 200);
  } catch {
    return undefined;
  }
}

// Runs before every route except GET /healthz. The client's address never decides the mode.
export function securityCheck(security: Security): MiddlewareHandler<ServerEnv> {
  const logRefusal = refusalLog(security.logger);
  return async (c, next) => {
    const result = admit(security, c);
    if ("refusal" in result) {
      logRefusal({
        reason: result.refusal,
        source: loggedSource(c),
        host: loggedHost(c),
        error: result.error,
      });
      return refuse(c, result.refusal, security.appUrl);
    }
    c.set("appUrl", security.appUrl);
    c.set("clientAddress", result.clientAddress);
    await next();
  };
}
