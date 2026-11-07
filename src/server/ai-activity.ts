import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { watchSessionEnds } from "../auth/index.ts";
import { log } from "../log.ts";
import type { AiActivityFeed, AiActivityView } from "../redo/work-view.ts";
import type { ServerEnv } from "./env.ts";

// GET /api/ai/activity/stream: the live AI status's feed (spec 08, Live AI status), as server-sent
// events. It sends the background AI work as it is now at once, then each change, and a comment
// line about every 25 seconds so a proxy keeps the stream open. It ends when the browser leaves,
// when the app stops, or when its session ends: at once when this process ends the session, and at
// the next comment line when the session expired. It reads names and counts only, and makes no AI
// call.

// Spec 08, Live AI status: at most 4 feeds open for each session.
export const MAX_STREAMS_PER_SESSION = 4;

// How often a stream sends its comment line.
export const HEARTBEAT_MS = 25_000;

const TOO_MANY = "Too many AI status streams are open. Close a tab, then try again.";

// The feeds open now, by session ID. Never the session's token.
const open = new Map<string, number>();

// How many feeds are open now, for every session.
export function openAiActivityStreams(): number {
  let count = 0;
  for (const each of open.values()) count += each;
  return count;
}

// Takes a place for the session, or answers false at the limit. It runs with no await, so feeds
// opened together cannot all pass the check (K18).
function takePlace(sessionId: string): boolean {
  const taken = open.get(sessionId) ?? 0;
  if (taken >= MAX_STREAMS_PER_SESSION) return false;
  open.set(sessionId, taken + 1);
  return true;
}

function givePlace(sessionId: string): void {
  const left = (open.get(sessionId) ?? 1) - 1;
  if (left > 0) open.set(sessionId, left);
  else open.delete(sessionId);
}

// A feed answers only the app's own pages. A browser sends no Origin with its own EventSource, so
// a request with none passes. One with another site's Origin, or one the browser marks as sent
// from another site, does not: the session cookie is SameSite=Lax, which a page on another port of
// the same site still gets.
function fromAnotherSite(c: Context<ServerEnv>): boolean {
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== c.var.appUrl.origin) return true;
  const site = c.req.header("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

// Sends the latest view, and only the latest: a browser that reads slowly gets the newest view
// once the one before has gone, never a queue. The same view twice in a row goes once. While the
// session is being checked, it holds what it would send, so a session that ended gets nothing more.
function latestSender(stream: SSEStreamingApi) {
  let sent: string | undefined;
  let waiting: string | undefined;
  let sending = false;
  let held = false;
  const pump = async () => {
    sending = true;
    try {
      while (waiting !== undefined) {
        const data = waiting;
        waiting = undefined;
        if (data === sent) continue;
        sent = data;
        await stream.writeSSE({ data });
      }
    } finally {
      sending = false;
    }
  };
  return {
    send(view: AiActivityView) {
      waiting = JSON.stringify(view);
      if (!sending && !held) void pump().catch(() => {});
    },
    // The comment line, when nothing else is on its way.
    heartbeat() {
      if (!sending && !held) void stream.write(": still here\n\n").catch(() => {});
    },
    hold() {
      held = true;
    },
    // The session is still open: what waited goes now.
    release() {
      held = false;
      if (!sending && waiting !== undefined) void pump().catch(() => {});
    },
  };
}

// Whether the session is still open, read without renewing it. A failed read counts as ended.
async function sessionOpen(c: Context<ServerEnv>): Promise<boolean> {
  try {
    const devices = await c.var.devices.devices(c.var.member.id, c.var.sessionId);
    return devices.some((device) => device.thisDevice);
  } catch (error) {
    log.warn("The live AI status stream could not check its session", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return false;
  }
}

// Checks the session on each call, one check at a time, and calls `ended` once it has ended. A call
// during a check runs one more check after it, so a session that ends mid-check is never missed.
// Until a check passes, the sender sends nothing.
function sessionChecker(
  c: Context<ServerEnv>,
  sender: ReturnType<typeof latestSender>,
  ended: () => void,
) {
  let checking = false;
  let again = false;
  let done = false;
  const check = async (): Promise<void> => {
    if (done) return;
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    sender.hold();
    let open: boolean;
    do {
      again = false;
      open = await sessionOpen(c);
    } while (open && again);
    checking = false;
    if (open) {
      sender.release();
      return;
    }
    done = true;
    ended();
  };
  return check;
}

export function aiActivityStream(c: Context<ServerEnv>) {
  const feed: AiActivityFeed | undefined = c.var.aiWork?.activity;
  if (feed === undefined) return c.json({ error: "Not found" }, 404);
  if (fromAnotherSite(c)) return c.json({ error: "Cross-site request refused" }, 403);
  const { sessionId } = c.var;
  if (!takePlace(sessionId)) return c.json({ error: TOO_MANY }, 429);
  // A proxy such as nginx must pass each event on at once.
  c.header("X-Accel-Buffering", "no");
  try {
    const res = streamSSE(c, async (stream) => {
      const { signal } = c.req.raw;
      let left: (() => void) | undefined;
      let stopWatching: (() => void) | undefined;
      let stopSessionWatch: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        await new Promise<void>((ended) => {
          const sender = latestSender(stream);
          // The browser left: Node cancels the response, or aborts the request.
          left = () => ended();
          stream.onAbort(left);
          signal.addEventListener("abort", left, { once: true });
          if (stream.aborted || signal.aborted) return ended();
          stopWatching = feed.watch(sender.send, ended);
          // A session this process ends ends its streams at once; an expired one at the next
          // comment line, which goes only while the session is open.
          const check = sessionChecker(c, sender, ended);
          stopSessionWatch = watchSessionEnds(() => void check());
          sender.send(feed.now());
          heartbeat = setInterval(() => {
            void check().then(sender.heartbeat);
          }, HEARTBEAT_MS);
        });
      } catch (error) {
        // Never the error itself (K8).
        log.warn("The live AI status stream stopped", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      } finally {
        stopWatching?.();
        stopSessionWatch?.();
        if (left !== undefined) signal.removeEventListener("abort", left);
        if (heartbeat !== undefined) clearInterval(heartbeat);
        givePlace(sessionId);
      }
    });
    // The connection closes with its stream, so an idle kept-alive connection never holds up the
    // server's close once the app has ended the stream.
    res.headers.set("Connection", "close");
    return res;
  } catch (error) {
    givePlace(sessionId);
    throw error;
  }
}
