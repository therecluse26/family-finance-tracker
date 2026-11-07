import { describe, expect, it } from "vitest";
import {
  type AiWorkProgress,
  ESTIMATE_AFTER_MS,
  progressPercent,
  progressWords,
  workProgress,
} from "./work-view.ts";

// The progress of a running redo (spec 08, AI work on your Transactions, Progress bar): its items,
// its step's place, and the time left.

const START = new Date("2026-11-06T20:00:00.000Z");
const after = (ms: number) => new Date(START.getTime() + ms);
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const progress = (done: number, worked: number, before = 2_654): AiWorkProgress =>
  workProgress({ before, done, place: 2, steps: 3, startedAt: START, now: after(worked) });

describe("a run's progress", () => {
  it("gives the items marked at the start, the items decided so far, and the step's place", () => {
    expect(progress(1_240, 10 * SECOND)).toEqual({
      before: 2_654,
      done: 1_240,
      place: 2,
      steps: 3,
      minutesLeft: null,
    });
    // Never more than the items at the start, and never fewer than none.
    expect(progress(3_000, 10 * SECOND).done).toBe(2_654);
    expect(progress(-5, 10 * SECOND).done).toBe(0);
  });

  it("gives no time left before 30 seconds of work, or while nothing is decided", () => {
    expect(ESTIMATE_AFTER_MS).toBe(30 * SECOND);
    expect(progress(1_240, 29 * SECOND).minutesLeft).toBeNull();
    expect(progress(0, 10 * MINUTE).minutesLeft).toBeNull();
    expect(progress(1_240, 30 * SECOND).minutesLeft).not.toBeNull();
  });

  it("rounds the time left up to whole minutes at the rate so far, with 0 below one minute", () => {
    // 100 of 400 in 1 minute: 300 left take 3 minutes.
    expect(progress(100, MINUTE, 400).minutesLeft).toBe(3);
    // 100 of 401: 3.01 minutes is about 4.
    expect(progress(100, MINUTE, 401).minutesLeft).toBe(4);
    // 1,240 of 2,654 in 3.5 minutes: about 3.99 minutes left.
    expect(progress(1_240, 3.5 * MINUTE).minutesLeft).toBe(4);
    // 90 of 100 in 1 minute: 6.7 seconds left.
    expect(progress(90, MINUTE, 100).minutesLeft).toBe(0);
    expect(progress(100, MINUTE, 100).minutesLeft).toBe(0);
  });

  it("fills to the share decided, rounded down, so it says 100% only at the end", () => {
    expect(progressPercent(progress(1_240, 0))).toBe(46);
    expect(progressPercent(progress(2_653, 0))).toBe(99);
    expect(progressPercent(progress(2_654, 0))).toBe(100);
    expect(progressPercent(progress(0, 0))).toBe(0);
    // No marked item at the start: the bar is full.
    expect(progressPercent(progress(0, 0, 0))).toBe(100);
  });

  it("says the items, the step and its place, and the time left, each once it is known", () => {
    expect(progressWords(progress(1_240, 3.5 * MINUTE), "Categories")).toBe(
      "1,240 of 2,654 items · Step 2 of 3: Categories · about 4 min left",
    );
    expect(progressWords(progress(90, MINUTE, 100), "Categories")).toBe(
      "90 of 100 items · Step 2 of 3: Categories · less than a minute left",
    );
    expect(progressWords(progress(0, MINUTE), "Categories")).toBe(
      "0 of 2,654 items · Step 2 of 3: Categories",
    );
    expect(progressWords({ ...progress(0, 0), place: null }, "starting")).toBe("0 of 2,654 items");
    expect(
      progressWords(
        workProgress({ before: 0, done: 0, place: 4, steps: 4, startedAt: START, now: START }),
        "Insight cards",
      ),
    ).toBe("Step 4 of 4: Insight cards");
  });
});
