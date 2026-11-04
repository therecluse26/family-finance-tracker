import * as z from "zod";
import {
  type CpiSeries,
  type Database,
  type FetchedCpi,
  markCpiFailed,
  markCpiFetched,
  readCpiFetch,
  readNewestCpi,
  storeCpiValues,
} from "../db/index.ts";
import { Job } from "../jobs/index.ts";
import { log } from "../log.ts";
import { endCondition, raiseNotice } from "../notify/index.ts";
import { USER_AGENT } from "../version.ts";
import { type BenchmarkSnapshot, benchmarkSnapshot } from "./snapshot.ts";

// The monthly CPI fetch (spec 05, CPI). The app fetches two CPI-U series from the BLS API v1, which
// needs no key, on the 20th, Household time. A failed fetch tries again the next day, at most
// CPI_FETCH_CAP times a round; then the round stops until the next 20th. Until a fetch succeeds,
// the app uses the newest CPI value it has: shipped or fetched. A new value changes the Benchmarks
// the app shows, which read cpiNow; the fetch writes only CPI rows, so it never changes a Budget.
// The request holds nothing about the Household (spec 01, 11. Privacy): a fixed URL, an Accept
// header, and the app's name and version.

export const CPI_SERIES = ["CUUR0000SA0", "CUUR0000SAF11"] as const satisfies readonly CpiSeries[];
export type { CpiSeries };

export const BLS_API = "https://api.bls.gov/publicAPI/v1/timeseries/data/";

// The day of the month the fetch is due, Household time.
export const CPI_FETCH_DAY = 20;

// The failed tries a round allows, one a day, before it stops until the next 20th.
export const CPI_FETCH_CAP = 5;

const TIMEOUT_MS = 20_000;

// Until a Household time zone is set, the fetch day follows UTC, as the scheduler does.
const DEFAULT_TIME_ZONE = "UTC";

// Why a fetch failed. A failure never carries the raw error, which could reach a log line whole.
export type CpiFetchFailure =
  | "timed out"
  | "unreachable"
  | "rate limited"
  | "refused"
  | "bad answer";

export type CpiFetchResult = "fetched" | "not due" | "stopped" | CpiFetchFailure;

// A BLS API v1 answer, as far as the fetch reads it. Each value is text, such as "324.368", or
// "-" when BLS has none.
const blsAnswerSchema = z.object({
  status: z.string(),
  message: z.array(z.string()).optional(),
  Results: z
    .object({
      series: z
        .array(
          z.object({
            seriesID: z.string(),
            data: z.array(z.object({ year: z.string(), period: z.string(), value: z.string() })),
          }),
        )
        .optional(),
    })
    .optional(),
});

const YEAR = /^\d{4}$/;
const MONTH_PERIOD = /^M(0[1-9]|1[0-2])$/;
const NUMBER = /^\d+(?:\.\d+)?$/;

// The monthly values in a BLS answer for one series, or why the answer is refused. M13, the annual
// average, and a missing value are left out.
function cpiValuesOf(body: unknown, series: CpiSeries): FetchedCpi[] | CpiFetchFailure {
  const answer = blsAnswerSchema.safeParse(body);
  if (!answer.success) return "bad answer";
  const { status, message = [], Results } = answer.data;
  if (status !== "REQUEST_SUCCEEDED") {
    // BLS answers its daily limit of requests with REQUEST_NOT_PROCESSED and a "threshold" message.
    return message.some((line) => /threshold/i.test(line)) ? "rate limited" : "refused";
  }
  const found = Results?.series?.find((entry) => entry.seriesID === series);
  if (found === undefined) return "bad answer";
  const values: FetchedCpi[] = [];
  for (const point of found.data) {
    const month = MONTH_PERIOD.exec(point.period)?.[1];
    if (month === undefined || !YEAR.test(point.year) || !NUMBER.test(point.value)) continue;
    const value = Number(point.value);
    if (value > 0) values.push({ series, month: `${point.year}-${month}`, value });
  }
  return values.length > 0 ? values : "bad answer";
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// One series' monthly values from the BLS API, or why the fetch failed.
async function fetchSeries(
  fetcher: typeof fetch,
  series: CpiSeries,
): Promise<FetchedCpi[] | CpiFetchFailure> {
  try {
    const res = await fetcher(`${BLS_API}${series}`, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 429) return "rate limited";
    if (!res.ok) return res.status >= 500 ? "unreachable" : "refused";
    return cpiValuesOf(await res.json().catch(() => undefined), series);
  } catch (error) {
    return timedOut(error) ? "timed out" : "unreachable";
  }
}

const dayFormats = new Map<string, Intl.DateTimeFormat>();

// The year, month, and day a calendar in `timeZone` shows at `at`.
function calendarDay(at: Date, timeZone: string): { year: number; month: number; day: number } {
  let format = dayFormats.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    dayFormats.set(timeZone, format);
  }
  const parts = format.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

// The fetch round at `at`: the month of the last 20th on or before that day, Household time, such
// as "2026-11" from Nov 20 to Dec 19.
export function cpiRound(at: Date, timeZone: string): string {
  const { year, month, day } = calendarDay(at, timeZone);
  const [roundYear, roundMonth] =
    day >= CPI_FETCH_DAY ? [year, month] : month === 1 ? [year - 1, 12] : [year, month - 1];
  return `${roundYear}-${String(roundMonth).padStart(2, "0")}`;
}

type CpiServices = {
  database: Database;
  // The Household time zone, an IANA name, or undefined until one is set.
  timeZone: () => Promise<string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
};

// The System notice condition while a round has stopped at the cap (spec 06, System notices). The
// next successful fetch ends it.
export const CPI_STOPPED = "cpi fetch stopped";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

// A CPI period in words: "September 2026" for a month, or the year or years as they are.
export function cpiPeriodLabel(period: string): string {
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month === null) return period;
  return `${MONTH_NAMES[Number(month[2]) - 1] ?? month[2]} ${month[1]}`;
}

async function raiseCpiStopped(database: Database): Promise<void> {
  const { period } = await cpiNow(database, "CUUR0000SA0");
  await raiseNotice({
    kind: "condition",
    condition: CPI_STOPPED,
    text: `The app could not fetch the newest CPI from BLS. It keeps using the CPI value from ${cpiPeriodLabel(period)}, and tries again after the next 20th.`,
  });
}

// Fetches both series when this round's fetch is due: not yet done, and not stopped at the cap.
// Values a fetch brings are stored even when a later series fails, so a partial fetch is kept. It
// never throws for a failed request.
async function fetchCpiWhenDue(services: CpiServices): Promise<CpiFetchResult> {
  const { database } = services;
  const now = services.now();
  const round = cpiRound(now, (await services.timeZone()) ?? DEFAULT_TIME_ZONE);
  const state = await readCpiFetch(database);
  if (state.fetchedRound !== null && state.fetchedRound >= round) return "not due";
  if (state.failedRound === round && state.failedTries >= CPI_FETCH_CAP) return "stopped";
  const fetched: FetchedCpi[] = [];
  let failure: CpiFetchFailure | undefined;
  for (const series of CPI_SERIES) {
    const result = await fetchSeries(services.fetch, series);
    if (typeof result === "string") {
      failure = result;
      log.warn("The CPI fetch failed for a series", { series, failure });
      break;
    }
    fetched.push(...result);
  }
  await storeCpiValues(database, fetched, now);
  if (failure === undefined) {
    await markCpiFetched(database, round, now);
    log.info("Fetched the CPI", { round, values: fetched.length });
    await endCondition(CPI_STOPPED);
    return "fetched";
  }
  const tries = await markCpiFailed(database, round, failure);
  if (tries >= CPI_FETCH_CAP) {
    log.warn("The CPI fetch stopped until the next 20th", { round, tries, failure });
    // One notice a stopped round: the round's last try raises it, and a later round that stops
    // again while it is open keeps that one notice.
    if (tries === CPI_FETCH_CAP) await raiseCpiStopped(database);
  } else {
    log.info("The CPI fetch tries again tomorrow", { round, tries, failure });
  }
  return failure;
}

let running: CpiServices | undefined;

// The daily task's job. Most days it finds the fetch not due and makes no request. It is safe to
// run twice: a second run finds the round done, or counts one more failed try toward the cap.
export class CpiFetchJob extends Job {
  override async run(): Promise<void> {
    if (running === undefined) throw new Error("The CPI fetch is not running.");
    await fetchCpiWhenDue(running);
  }
}

export type CpiFetchOptions = {
  database: Database;
  timeZone: () => Promise<string | undefined>;
  // The HTTP client: the global fetch, or a stub in tests.
  fetch?: typeof fetch;
  now?: () => Date;
};

// Gives the CPI fetch app.db, the Household time zone, and its HTTP client. The start calls it
// before jobs run.
export function startCpiFetch(options: CpiFetchOptions): { stop(): void } {
  if (running !== undefined) throw new Error("The CPI fetch is already running.");
  const started: CpiServices = {
    database: options.database,
    timeZone: options.timeZone,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    now: options.now ?? (() => new Date()),
  };
  running = started;
  return {
    stop() {
      if (running === started) running = undefined;
    },
  };
}

// The date of the last successful fetch, for the Data sources page, or null before the first.
export async function lastCpiFetch(database: Database): Promise<Date | null> {
  return (await readCpiFetch(database)).fetchedAt;
}

// A CPI value and where it came from: the Benchmark snapshot, or a fetch.
export type CpiValue = {
  series: CpiSeries;
  // A month, such as "2026-09", or for a shipped value the CE year or years it averages.
  period: string;
  value: number;
  source: "shipped" | "fetched";
};

// The last month a period covers: "2026-09" itself, "2025" its December, "2023-2024" the
// December of 2024.
function lastMonthOf(period: string): string {
  const years = /^(?:\d{4}-)?(\d{4})$/.exec(period);
  return years === null ? period : `${years[1]}-12`;
}

// Every CPI value the snapshot was priced at.
function shippedCpi(snapshot: BenchmarkSnapshot) {
  const { ce, food } = snapshot;
  return [
    ce.byIncome.pricedAt,
    ...ce.bySizeAndIncome.map(({ table }) => table.pricedAt),
    food.moderate.pricedAt,
    food.thrifty.us.pricedAt,
    food.thrifty.alaska.pricedAt,
    food.thrifty.hawaii.pricedAt,
  ];
}

// The newest CPI value the app has for a series, shipped or fetched: the one whose period ends
// last. A fetched month wins a tie, since BLS may have revised it.
export async function cpiNow(
  database: Database,
  series: CpiSeries,
  snapshot: BenchmarkSnapshot = benchmarkSnapshot(),
): Promise<CpiValue> {
  let newest: CpiValue | undefined;
  for (const shipped of shippedCpi(snapshot)) {
    if (shipped.series !== series) continue;
    if (newest === undefined || lastMonthOf(shipped.period) > lastMonthOf(newest.period)) {
      newest = { ...shipped, source: "shipped" };
    }
  }
  const fetched = await readNewestCpi(database, series);
  if (
    fetched !== undefined &&
    (newest === undefined || fetched.month >= lastMonthOf(newest.period))
  ) {
    return { series, period: fetched.month, value: fetched.value, source: "fetched" };
  }
  if (newest === undefined) throw new Error(`The Benchmark snapshot has no ${series} value.`);
  return newest;
}
