import { daily } from "../jobs/index.ts";

// When a Connection syncs next (spec 02, Sync schedule, Back-off, and First history load). Times
// are moments; the 6-hour slots follow the Household time zone.

const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;

// A Healthy Connection syncs at these hours, at its own minute.
const SYNC_HOURS = [0, 6, 12, 18];

// While its history loads, a Connection syncs this often, or every minSyncGapHours if longer.
const LOADING_GAP_MS = 15 * MINUTE_MS;

// After each Temporary error in a row, the next retry waits this long; after the fifth, 24 hours.
const BACK_OFF_HOURS = [1, 2, 4, 8, 16];
const LAST_BACK_OFF_HOURS = 24;

// At startup, a Connection whose last sync attempt is older than this syncs at once.
export const CATCH_UP_AFTER_MS = 6 * HOUR_MS;

// After this long in Retrying, every Member gets one System notice.
export const RETRYING_NOTICE_AFTER_MS = 3 * 24 * HOUR_MS;

// While a Connection needs a Member, the app checks it this often.
export const CHECK_GAP_MS = 24 * HOUR_MS;

// The sync schedule starts a sync job, then sets the next sync this far ahead. The job's outcome
// replaces it, so it only matters when the job never ran: then the sync is tried again.
export const STARTED_SYNC_GAP_MS = HOUR_MS;

// A Connection whose history has not loaded this long after it was made stops holding back AI
// (spec 02, First history load).
export const HISTORY_WAIT_RELEASE_MS = 24 * HOUR_MS;

// A First run job, or a bank-added-later job, that has not finished this long after it started is
// started again: a stop lost it, or it used up its retries.
export const LOST_HISTORY_JOB_MS = HOUR_MS;

// Those jobs may call the AI, which costs money, so they never retry without end. Each start gets
// this many attempts, and a lost job starts again at most this many times. Then it stops, and a
// System notice asks a Member to press Retry.
export const HISTORY_JOB_ATTEMPTS = 3;
export const HISTORY_JOB_RESTARTS = 2;

// After Link again or a new link of a removed bank, hand-made links on replaced Transactions wait
// for new copies at most this many days after the carry-over, when the new Connection's first
// history load has not ended by then (spec 02, Link carry-over). The owner sets this number.
export const COPIES_WAIT_CAP_DAYS = 7;
export const COPIES_WAIT_CAP_MS = COPIES_WAIT_CAP_DAYS * 24 * HOUR_MS;

// The sync schedule's job tries this many times to make the old Transactions of an ended wait
// unhandled. Then it stops.
export const COPIES_WAIT_END_TRIES = 5;

// Sync now asks a Connection's provider to Refresh at most this often (spec 02, Sync now).
export const REFRESH_GAP_MS = HOUR_MS;

// Refresh makes the bank fetch fresh data, which arrives later: a second sync follows this long
// after the first.
export const SECOND_SYNC_AFTER_MS = 5 * MINUTE_MS;
// After Repair or Add accounts, the sync starts at once unless one started less than this long ago,
// or less than minSyncGapHours if longer. Then the sync schedule starts it when the gap has passed.
// So a Member cannot start syncs without limit.
export const UPDATE_SYNC_GAP_MS = 5 * MINUTE_MS;

const twoDigits = (n: number) => String(n).padStart(2, "0");

// The first of 00:mm, 06:mm, 12:mm, and 18:mm, Household time, after `after`.
function nextSlot(after: Date, syncMinute: number, timeZone: string): Date {
  const times = SYNC_HOURS.map((hour) =>
    daily(`${twoDigits(hour)}:${twoDigits(syncMinute)}`)
      .next(after, timeZone)
      .getTime(),
  );
  return new Date(Math.min(...times));
}

// The next sync after a successful one that started at `startedAt` and ended at `endedAt`. While
// its history loads, the Connection syncs every 15 minutes; once loaded, at its next 6-hour slot.
// Neither comes sooner than minSyncGapHours after the last sync started.
export function nextHealthySync(sync: {
  startedAt: Date;
  endedAt: Date;
  historyLoaded: boolean;
  syncMinute: number;
  minSyncGapHours: number;
  timeZone: string;
}): Date {
  const gapMs = sync.minSyncGapHours * HOUR_MS;
  if (!sync.historyLoaded) {
    return new Date(sync.startedAt.getTime() + Math.max(LOADING_GAP_MS, gapMs));
  }
  const earliest = sync.startedAt.getTime() + gapMs;
  let slot = nextSlot(sync.endedAt, sync.syncMinute, sync.timeZone);
  while (slot.getTime() < earliest) slot = nextSlot(slot, sync.syncMinute, sync.timeZone);
  return slot;
}

// How long the back-off waits after the given number of Temporary errors in a row, 1 or more.
export function backOffMs(failedSyncs: number): number {
  return (BACK_OFF_HOURS[failedSyncs - 1] ?? LAST_BACK_OFF_HOURS) * HOUR_MS;
}

// The retry after a Temporary error, for a sync that started at `startedAt`, in a Connection
// Retrying since `retryingSince`. A retry that would come after the 3-day mark comes at the mark
// instead, so a failure there sends the System notice on time. No retry comes sooner than
// minSyncGapHours after the sync started.
export function nextRetry(
  startedAt: Date,
  failedSyncs: number,
  minSyncGapHours: number,
  retryingSince: Date,
): Date {
  const start = startedAt.getTime();
  const mark = retryingSince.getTime() + RETRYING_NOTICE_AFTER_MS;
  let next = start + backOffMs(failedSyncs);
  if (start < mark && next > mark) next = mark;
  return new Date(Math.max(next, start + minSyncGapHours * HOUR_MS));
}
