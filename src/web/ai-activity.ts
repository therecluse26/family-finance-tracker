import { useEffect, useState } from "react";
import { AI_USE_LABELS } from "../ai/ai-view.ts";
import type { AiActivityView, AiWorkView } from "../redo/work-view.ts";
import { api } from "./api.ts";

// The live AI status (spec 08, Live AI status): the background AI work running now, as the page
// learns it from GET /api/ai/activity/stream. One feed serves the whole page, however many parts
// watch it: the main menu's sign and Settings, AI's status line. When the stream fails, the page
// closes it and opens it again with a growing wait, up to a cap, and meanwhile reads Settings, AI's
// status line every 10 seconds while the page is visible. Every read and stream makes no AI call.

export const STREAM_URL = "/api/ai/activity/stream";

// The waits before each new try after a failed stream, in order. After the last, the page stops
// trying until it loads again (K4).
export const RETRY_WAITS_MS = [2_000, 4_000, 8_000, 16_000, 32_000, 60_000] as const;

// A stream that stays open this long sets the count of failed tries back to 0.
export const STEADY_MS = 5 * 60_000;

// How often the page reads the status line while no stream is open, and after how many failed
// reads in a row it stops.
export const POLL_MS = 10_000;
export const MAX_FAILED_READS = 30;

// What the sign needs of a browser's EventSource.
export type EventStream = {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
};

// The status line's answer: its status, and the run it shows.
export type WorkRead = { status: number; run?: AiActivityView["run"] };

export type FeedSeams = {
  // A new stream, or undefined when the browser has no EventSource.
  openStream(url: string): EventStream | undefined;
  readWork(): Promise<WorkRead>;
  visible(): boolean;
  // Calls `changed` when the page is shown or hidden. Returns the function that stops it.
  watchVisibility(changed: () => void): () => void;
};

export type AiActivityFeedView = {
  // The work now, or undefined until the first answer.
  view(): AiActivityView | undefined;
  // Calls `changed` with each new view. The first watcher opens the feed, and the last one to
  // stop closes it.
  watch(changed: (view: AiActivityView) => void): () => void;
};

const IDLE: AiActivityView = { run: null, uses: [] };

// A view from the stream, or undefined for anything else. The page trusts only the shape it knows.
export function readView(data: unknown): AiActivityView | undefined {
  if (typeof data !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { run, uses } = parsed as { run?: unknown; uses?: unknown };
  const runOk =
    run === null ||
    (typeof run === "object" &&
      run !== null &&
      typeof (run as { step?: unknown }).step === "string");
  const usesOk =
    Array.isArray(uses) &&
    uses.every(
      (each: unknown) =>
        typeof each === "object" &&
        each !== null &&
        typeof (each as { use?: unknown }).use === "string" &&
        (each as { use: string }).use in AI_USE_LABELS &&
        typeof (each as { calls?: unknown }).calls === "number",
    );
  return runOk && usesOk ? (parsed as AiActivityView) : undefined;
}

export function createAiActivityFeed(seams: FeedSeams): AiActivityFeedView {
  let now: AiActivityView | undefined;
  const watchers = new Set<(view: AiActivityView) => void>();
  let stream: EventStream | undefined;
  // Failed streams in a row.
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let steadyTimer: ReturnType<typeof setTimeout> | undefined;
  // Reading the status line in place of the stream.
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let reading = false;
  let failedReads = 0;
  // A 401: no stream and no read until a new first watcher, such as the shell after a sign-in.
  let signedOut = false;
  let stopVisibility: (() => void) | undefined;

  const show = (next: AiActivityView) => {
    if (now !== undefined && JSON.stringify(now) === JSON.stringify(next)) return;
    now = next;
    for (const changed of [...watchers]) changed(next);
  };

  const clear = (timer: ReturnType<typeof setTimeout> | undefined) => {
    if (timer !== undefined) clearTimeout(timer);
  };

  function stopPolling(): void {
    polling = false;
    clear(pollTimer);
    pollTimer = undefined;
  }

  function closeStream(): void {
    if (stream === undefined) return;
    stream.onopen = null;
    stream.onmessage = null;
    stream.onerror = null;
    stream.close();
    stream = undefined;
  }

  function closeAll(): void {
    closeStream();
    stopPolling();
    clear(retryTimer);
    clear(steadyTimer);
    retryTimer = undefined;
    steadyTimer = undefined;
    stopVisibility?.();
    stopVisibility = undefined;
  }

  function nextRead(): void {
    clear(pollTimer);
    pollTimer = undefined;
    if (polling && seams.visible()) pollTimer = setTimeout(read, POLL_MS);
  }

  async function read(): Promise<void> {
    pollTimer = undefined;
    if (!polling || reading || !seams.visible()) return;
    reading = true;
    let answer: WorkRead;
    try {
      answer = await seams.readWork();
    } catch {
      answer = { status: 0 };
    } finally {
      reading = false;
    }
    if (!polling) return;
    if (answer.status === 401) {
      // Signed out: the next page opens the sign-in page.
      signedOut = true;
      closeAll();
      show(IDLE);
      return;
    }
    if (answer.status === 404) {
      // The app runs no AI work.
      stopPolling();
      show(IDLE);
      return;
    }
    if (answer.status === 200 && answer.run !== undefined) {
      failedReads = 0;
      show({ run: answer.run, uses: [] });
    } else {
      failedReads += 1;
      if (failedReads >= MAX_FAILED_READS) {
        stopPolling();
        return;
      }
    }
    nextRead();
  }

  function startPolling(): void {
    if (polling || signedOut) return;
    polling = true;
    failedReads = 0;
    void read();
  }

  function connect(): void {
    retryTimer = undefined;
    if (signedOut || watchers.size === 0) return;
    const opened = seams.openStream(STREAM_URL);
    if (opened === undefined) {
      startPolling();
      return;
    }
    stream = opened;
    opened.onopen = () => {
      stopPolling();
      clear(steadyTimer);
      steadyTimer = setTimeout(() => {
        failures = 0;
      }, STEADY_MS);
    };
    opened.onmessage = (event) => {
      const view = readView(event.data);
      if (view === undefined) return;
      stopPolling();
      show(view);
    };
    // The browser would try again on its own, with no cap: the page closes the stream and tries
    // again itself.
    opened.onerror = () => {
      closeStream();
      clear(steadyTimer);
      steadyTimer = undefined;
      failures += 1;
      startPolling();
      const wait = RETRY_WAITS_MS[failures - 1];
      if (wait !== undefined) retryTimer = setTimeout(connect, wait);
    };
  }

  function onVisibility(): void {
    if (!seams.visible()) {
      clear(pollTimer);
      pollTimer = undefined;
    } else if (polling && pollTimer === undefined) {
      void read();
    }
  }

  return {
    view: () => now,
    watch(changed) {
      watchers.add(changed);
      if (watchers.size === 1) {
        // A new first watcher, such as the shell after a sign-in, starts afresh.
        signedOut = false;
        failures = 0;
        stopVisibility = seams.watchVisibility(onVisibility);
        connect();
      }
      return () => {
        if (!watchers.delete(changed) || watchers.size > 0) return;
        closeAll();
      };
    },
  };
}

// The browser's feed, made on first use.
let browserFeed: AiActivityFeedView | undefined;

function feedInBrowser(): AiActivityFeedView {
  browserFeed ??= createAiActivityFeed({
    openStream: (url) =>
      typeof EventSource === "undefined" ? undefined : (new EventSource(url) as EventStream),
    async readWork() {
      const res = await api.ai.work.$get();
      if (!res.ok) return { status: res.status };
      const { work } = (await res.json()) as { work: AiWorkView };
      return { status: res.status, run: work.running };
    },
    visible: () => document.visibilityState === "visible",
    watchVisibility(changed) {
      document.addEventListener("visibilitychange", changed);
      return () => document.removeEventListener("visibilitychange", changed);
    },
  });
  return browserFeed;
}

// The background AI work now, or undefined until the feed's first answer.
export function useAiActivity(): AiActivityView | undefined {
  const [view, setView] = useState<AiActivityView | undefined>();
  useEffect(() => {
    const feed = feedInBrowser();
    setView(feed.view());
    return feed.watch(setView);
  }, []);
  return view;
}

// The sign's line (spec 08, Live AI status), or undefined when no background AI works.
export function aiActivityLine(view: AiActivityView | undefined): string | undefined {
  if (view === undefined) return undefined;
  if (view.run !== null) {
    return view.run.step === "starting" ? "AI working" : `AI working: ${view.run.step}`;
  }
  const [first, ...more] = view.uses;
  if (first === undefined) return undefined;
  const name = AI_USE_LABELS[first.use];
  return more.length === 0 ? `AI working: ${name}` : `AI working: ${name} and ${more.length} more`;
}

// How long the sign stays after the last work ends, so the gap between two batches does not make
// it blink.
export const HIDE_AFTER_MS = 2_000;

// Shows each new line at once, and an end only after `ms` with no new line. Returns the function
// that takes each line, and the one that stops its timer.
export function lingering(
  show: (line: string | undefined) => void,
  ms: number = HIDE_AFTER_MS,
): { update(line: string | undefined): void; stop(): void } {
  let shown: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  return {
    update(line) {
      if (line !== undefined) {
        stop();
        if (line !== shown) show(line);
        shown = line;
        return;
      }
      if (shown === undefined || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        shown = undefined;
        show(undefined);
      }, ms);
    },
    stop,
  };
}

// The sign's line, held for HIDE_AFTER_MS after the work ends.
export function useAiActivityLine(): string | undefined {
  const line = aiActivityLine(useAiActivity());
  const [shown, setShown] = useState<string | undefined>();
  const [held] = useState(() => lingering(setShown));
  useEffect(() => held.update(line), [held, line]);
  useEffect(() => () => held.stop(), [held]);
  return shown;
}
