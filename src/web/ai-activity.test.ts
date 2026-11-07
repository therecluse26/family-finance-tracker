import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiActivityView } from "../redo/work-view.ts";
import {
  aiActivityLine,
  createAiActivityFeed,
  type EventStream,
  type FeedSeams,
  HIDE_AFTER_MS,
  lingering,
  MAX_FAILED_READS,
  POLL_MS,
  RETRY_WAITS_MS,
  readView,
  STEADY_MS,
  STREAM_URL,
  type WorkRead,
} from "./ai-activity.ts";

// The live AI status in the browser (spec 08, Live AI status): the sign's words, how long it stays,
// and the feed: one stream for the page, its tries again with a growing wait and a cap, and the
// reads of the status line while no stream is open, only while the page is visible. On a fake
// EventSource, a fake status line, and a fake clock.

const IDLE: AiActivityView = { run: null, uses: [] };
const CATEGORIES: AiActivityView = { run: { kind: "finish", step: "Categories" }, uses: [] };

class FakeStream implements EventStream {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event("open"));
  }
  send(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
}

class FakePage implements FeedSeams {
  readonly streams: FakeStream[] = [];
  readonly urls: string[] = [];
  reads = 0;
  answer: WorkRead | (() => Promise<WorkRead>) = { status: 200, run: null };
  shown = true;
  hasEventSource = true;
  private readonly visibility = new Set<() => void>();

  openStream(url: string) {
    if (!this.hasEventSource) return undefined;
    this.urls.push(url);
    const stream = new FakeStream();
    this.streams.push(stream);
    return stream;
  }
  async readWork() {
    this.reads += 1;
    return typeof this.answer === "function" ? this.answer() : this.answer;
  }
  visible() {
    return this.shown;
  }
  watchVisibility(changed: () => void) {
    this.visibility.add(changed);
    return () => this.visibility.delete(changed);
  }
  setVisible(shown: boolean) {
    this.shown = shown;
    for (const changed of this.visibility) changed();
  }
  get visibilityWatchers() {
    return this.visibility.size;
  }
  get last(): FakeStream {
    const stream = this.streams.at(-1);
    if (stream === undefined) throw new Error("No stream opened.");
    return stream;
  }
  get open(): FakeStream[] {
    return this.streams.filter((stream) => !stream.closed);
  }
}

describe("the live AI status's words", () => {
  it("says a run's step, and a run before its first step", () => {
    expect(aiActivityLine(CATEGORIES)).toBe("AI working: Categories");
    expect(aiActivityLine({ run: { kind: null, step: "Merchant names" }, uses: [] })).toBe(
      "AI working: Merchant names",
    );
    expect(aiActivityLine({ run: { kind: "finish", step: "starting" }, uses: [] })).toBe(
      "AI working",
    );
  });

  it("puts a run before its own calls", () => {
    expect(
      aiActivityLine({
        run: { kind: "all history", step: "Categories" },
        uses: [{ use: "category fix", calls: 1 }],
      }),
    ).toBe("AI working: Categories");
  });

  it("names a background use by its name in spec 08, and the others by count", () => {
    expect(aiActivityLine({ run: null, uses: [{ use: "insight cards", calls: 1 }] })).toBe(
      "AI working: Insight cards",
    );
    expect(
      aiActivityLine({
        run: null,
        uses: [
          { use: "alert advice", calls: 1 },
          { use: "category fix", calls: 3 },
        ],
      }),
    ).toBe("AI working: Alert advice and 1 more");
    expect(
      aiActivityLine({
        run: null,
        uses: [
          { use: "monthly review", calls: 1 },
          { use: "category fix", calls: 1 },
          { use: "unclear transfer", calls: 2 },
        ],
      }),
    ).toBe("AI working: Monthly review and 2 more");
  });

  it("says nothing when no background AI works, or before the first answer", () => {
    expect(aiActivityLine(IDLE)).toBeUndefined();
    expect(aiActivityLine(undefined)).toBeUndefined();
  });

  it("reads only a view of the shape it knows", () => {
    expect(readView(JSON.stringify(CATEGORIES))).toEqual(CATEGORIES);
    expect(readView("not JSON")).toBeUndefined();
    expect(readView(JSON.stringify({ run: null }))).toBeUndefined();
    expect(readView(JSON.stringify({ run: null, uses: [{ use: "<b>", calls: 1 }] }))).toBe(
      undefined,
    );
    expect(readView(JSON.stringify({ run: { kind: "finish" }, uses: [] }))).toBeUndefined();
    expect(readView(42)).toBeUndefined();
  });
});

describe("the sign's hold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a line at once, and hides it only 2 seconds after the last work ends", () => {
    const shown: (string | undefined)[] = [];
    const held = lingering((line) => shown.push(line));

    held.update(undefined);
    held.update("AI working: Category fix");
    held.update(undefined);
    vi.advanceTimersByTime(HIDE_AFTER_MS - 1);
    // The next batch starts before the sign hides: it never blinks.
    held.update("AI working: Category fix");
    held.update(undefined);
    vi.advanceTimersByTime(HIDE_AFTER_MS - 1);
    expect(shown).toEqual(["AI working: Category fix"]);
    vi.advanceTimersByTime(1);
    expect(shown).toEqual(["AI working: Category fix", undefined]);

    held.update("AI working: Insight cards");
    held.update("AI working: Monthly review");
    held.update(undefined);
    held.stop();
    vi.advanceTimersByTime(HIDE_AFTER_MS);
    expect(shown).toEqual([
      "AI working: Category fix",
      undefined,
      "AI working: Insight cards",
      "AI working: Monthly review",
    ]);
  });
});

describe("the live AI status's feed in the browser", () => {
  let page: FakePage;

  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakePage();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens one stream for every watcher, tells each one each new view, and closes it when the last one stops", () => {
    const feed = createAiActivityFeed(page);
    const sign: AiActivityView[] = [];
    const line: AiActivityView[] = [];
    const stopSign = feed.watch((view) => sign.push(view));
    const stopLine = feed.watch((view) => line.push(view));

    expect(page.urls).toEqual([STREAM_URL]);
    page.last.open();
    page.last.send(IDLE);
    page.last.send(IDLE);
    page.last.send(CATEGORIES);
    page.last.onmessage?.(new MessageEvent("message", { data: "{not json" }));

    expect(sign).toEqual([IDLE, CATEGORIES]);
    expect(line).toEqual([IDLE, CATEGORIES]);
    expect(feed.view()).toEqual(CATEGORIES);
    stopSign();
    expect(page.open).toHaveLength(1);
    stopLine();
    expect(page.open).toHaveLength(0);
    expect(page.visibilityWatchers).toBe(0);
    expect(page.reads).toBe(0);
  });

  it("tries again after 2, 4, 8, 16, 32 and 60 seconds, then stops trying", () => {
    const feed = createAiActivityFeed(page);
    feed.watch(() => {});
    page.answer = { status: 200, run: null };

    for (const wait of RETRY_WAITS_MS) {
      const before = page.streams.length;
      page.last.fail();
      expect(page.last.closed).toBe(true);
      vi.advanceTimersByTime(wait - 1);
      expect(page.streams).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(page.streams).toHaveLength(before + 1);
    }
    page.last.fail();
    vi.advanceTimersByTime(24 * 60 * 60_000);
    expect(page.streams).toHaveLength(RETRY_WAITS_MS.length + 1);
    expect(page.open).toHaveLength(0);
  });

  it("sets the count of failed tries back to 0 once a stream stays open for 5 minutes", () => {
    const feed = createAiActivityFeed(page);
    feed.watch(() => {});
    page.last.fail();
    vi.advanceTimersByTime(RETRY_WAITS_MS[0]);
    page.last.fail();
    vi.advanceTimersByTime(RETRY_WAITS_MS[1]);

    // Open, but not for long: the count goes on.
    page.last.open();
    vi.advanceTimersByTime(STEADY_MS - 1);
    page.last.fail();
    vi.advanceTimersByTime(RETRY_WAITS_MS[2] - 1);
    expect(page.streams).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(page.streams).toHaveLength(4);

    // Open for 5 minutes: the next failure waits 2 seconds again.
    page.last.open();
    vi.advanceTimersByTime(STEADY_MS);
    page.last.fail();
    vi.advanceTimersByTime(RETRY_WAITS_MS[0]);
    expect(page.streams).toHaveLength(5);
  });

  it("reads the status line every 10 seconds while no stream is open, and stops once one opens", async () => {
    const feed = createAiActivityFeed(page);
    const seen: AiActivityView[] = [];
    feed.watch((view) => seen.push(view));
    page.answer = { status: 200, run: { kind: "finish", step: "Money movement" } };

    page.last.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.reads).toBe(1);
    expect(seen).toEqual([{ run: { kind: "finish", step: "Money movement" }, uses: [] }]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(page.reads).toBe(2);

    // The stream opens again after its 2 seconds' wait, before the next read.
    await vi.advanceTimersByTimeAsync(RETRY_WAITS_MS[0]);
    page.last.open();
    page.last.send(IDLE);
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(page.reads).toBe(2);
    expect(seen.at(-1)).toEqual(IDLE);
  });

  it("reads only while the page is visible", async () => {
    const feed = createAiActivityFeed(page);
    feed.watch(() => {});
    page.last.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.reads).toBe(1);

    page.setVisible(false);
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(page.reads).toBe(1);

    // Shown again: one read at once, then every 10 seconds.
    page.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.reads).toBe(2);
    page.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(page.reads).toBe(3);
  });

  it("makes no read when the stream fails while the page is hidden, until the page shows", async () => {
    const feed = createAiActivityFeed(page);
    feed.watch(() => {});
    page.setVisible(false);

    page.last.fail();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(page.reads).toBe(0);

    page.setVisible(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(page.reads).toBe(1);
  });

  it("reads the status line when the browser has no EventSource", async () => {
    page.hasEventSource = false;
    page.answer = { status: 200, run: { kind: null, step: "Insight cards" } };
    const feed = createAiActivityFeed(page);
    const seen: AiActivityView[] = [];
    feed.watch((view) => seen.push(view));

    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ run: { kind: null, step: "Insight cards" }, uses: [] }]);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(page.reads).toBe(2);
  });

  it("stops the stream and the reads at a 401 until a new first watcher", async () => {
    const feed = createAiActivityFeed(page);
    const seen: AiActivityView[] = [];
    const stop = feed.watch((view) => seen.push(view));
    page.answer = { status: 401 };

    page.last.fail();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(page.reads).toBe(1);
    expect(page.streams).toHaveLength(1);
    expect(seen).toEqual([IDLE]);
    expect(page.visibilityWatchers).toBe(0);

    // The shell after a sign-in.
    stop();
    feed.watch(() => {});
    expect(page.streams).toHaveLength(2);
  });

  it("stops reading after 30 failed reads in a row, and at a 404", async () => {
    const feed = createAiActivityFeed(page);
    feed.watch(() => {});
    page.answer = async () => {
      throw new TypeError("Failed to fetch");
    };
    // No stream ever opens again.
    for (const wait of RETRY_WAITS_MS) {
      page.last.fail();
      await vi.advanceTimersByTimeAsync(wait);
    }
    page.last.fail();
    await vi.advanceTimersByTimeAsync(POLL_MS * (MAX_FAILED_READS + 10));
    expect(page.reads).toBe(MAX_FAILED_READS);

    const other = new FakePage();
    other.hasEventSource = false;
    other.answer = { status: 404 };
    createAiActivityFeed(other).watch(() => {});
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(other.reads).toBe(1);
  });

  it("never reads twice at once", async () => {
    page.hasEventSource = false;
    let answer: (read: WorkRead) => void = () => {};
    page.answer = () =>
      new Promise<WorkRead>((done) => {
        answer = done;
      });
    const feed = createAiActivityFeed(page);
    feed.watch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    page.setVisible(true);
    page.setVisible(true);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(page.reads).toBe(1);
    answer({ status: 200, run: null });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(page.reads).toBe(2);
  });
});
