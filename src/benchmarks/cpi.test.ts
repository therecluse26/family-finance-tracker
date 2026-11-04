import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Database, listOpenNotices, readCpiFetch, storeHouseholdFacts } from "../db/index.ts";
import { newTestDatabase, readEveryTable, type TestDatabase } from "../db/testing.ts";
import { startNotify } from "../notify/index.ts";
import {
  BLS_API,
  CPI_FETCH_CAP,
  CPI_STOPPED,
  CpiFetchJob,
  type CpiSeries,
  cpiNow,
  cpiPeriodLabel,
  cpiRound,
  lastCpiFetch,
  startCpiFetch,
} from "./index.ts";

// The monthly CPI fetch (spec 05, CPI), against a stubbed BLS API. No test reaches BLS.

const NEW_YORK = "America/New_York";

// 6:00 AM in New York, the daily task's time, on a day of 2026.
const at = (day: string) => new Date(`2026-${day}T11:00:00.000Z`);

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

// A BLS API v1 answer for one series, with a value for each month given.
function blsAnswer(series: string, values: Record<string, string>) {
  return {
    status: "REQUEST_SUCCEEDED",
    responseTime: 20,
    message: [],
    Results: {
      series: [
        {
          seriesID: series,
          data: Object.entries(values).map(([month, value]) => ({
            year: month.slice(0, 4),
            period: `M${month.slice(5)}`,
            periodName: "Month",
            value,
            footnotes: [{}],
          })),
        },
      ],
    },
  };
}

const NEWER: Record<CpiSeries, Record<string, string>> = {
  CUUR0000SA0: { "2026-10": "331.250", "2026-09": "330.900" },
  CUUR0000SAF11: { "2026-10": "336.125", "2026-09": "335.500" },
};

type Answer = Response | Error;

// A stub of the global fetch. Each request takes the next answer for its series, or a good one.
class StubBls {
  readonly sent: Sent[] = [];
  readonly answers: Answer[] = [];

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    this.sent.push({
      url,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body,
    });
    const answer = this.answers.shift();
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    const series = url.slice(BLS_API.length) as CpiSeries;
    return Response.json(blsAnswer(series, NEWER[series]));
  };
}

const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

describe("the CPI fetch", () => {
  let test: TestDatabase;
  let database: Database;
  let bls: StubBls;
  let now: Date;
  let stop: () => void;
  let timeZone: string | undefined;
  let stopNotify: () => void;

  beforeEach(async () => {
    test = await newTestDatabase();
    database = test.database;
    bls = new StubBls();
    timeZone = NEW_YORK;
    stopNotify = startNotify({ database }).stop;
    stop = startCpiFetch({
      database,
      timeZone: async () => timeZone,
      fetch: bls.fetch,
      now: () => now,
    }).stop;
  });

  afterEach(() => {
    stop();
    stopNotify();
    test.close();
  });

  const cpiNotices = async () =>
    (await listOpenNotices(database)).filter((notice) => notice.condition === CPI_STOPPED);

  const runOn = async (when: Date) => {
    now = when;
    await new CpiFetchJob().run();
  };

  it("fetches both series on the 20th with a request that holds nothing about the Household", async () => {
    await storeHouseholdFacts(database, {
      zipCode: "10001",
      state: "NY",
      timeZone: NEW_YORK,
      ages: [41, 39, 8],
      rentOrOwn: "rent",
      updatedAt: at("11-01"),
      updatedBy: null,
    });

    await runOn(at("11-20"));

    expect(bls.sent).toEqual(
      ["CUUR0000SA0", "CUUR0000SAF11"].map((series) => ({
        url: `https://api.bls.gov/publicAPI/v1/timeseries/data/${series}`,
        method: "GET",
        headers: {
          accept: "application/json",
          "user-agent": expect.stringMatching(/^family-finance-tracker\/\d+\.\d+\.\d+$/),
        },
        body: undefined,
      })),
    );
    const text = JSON.stringify(bls.sent);
    for (const fact of ["10001", "NY", "41", "39", "rent", "America"]) {
      expect(text).not.toContain(fact);
    }
    expect(await lastCpiFetch(database)).toEqual(at("11-20"));
  });

  it("fetches once a round: not again until the next 20th, Household time", async () => {
    await runOn(at("11-20"));
    for (const day of ["11-21", "11-30", "12-01", "12-19"]) await runOn(at(day));
    expect(bls.sent).toHaveLength(2);

    // 10:00 PM on Dec 19 in New York is already Dec 20 in UTC.
    await runOn(new Date("2026-12-20T03:00:00.000Z"));
    expect(bls.sent).toHaveLength(2);

    await runOn(at("12-20"));
    expect(bls.sent).toHaveLength(4);
  });

  it("follows UTC until a Household time zone is set", async () => {
    timeZone = undefined;

    await runOn(new Date("2026-11-20T03:00:00.000Z"));

    expect(bls.sent).toHaveLength(2);
    expect(cpiRound(new Date("2026-11-20T03:00:00.000Z"), NEW_YORK)).toBe("2026-10");
    expect(cpiRound(new Date("2026-01-05T12:00:00.000Z"), NEW_YORK)).toBe("2025-12");
  });

  it("tries again the next day after a failed fetch, and keeps the newest value it has meanwhile", async () => {
    bls.answers.push(new Response("Service Unavailable", { status: 503 }));

    await runOn(at("11-20"));

    expect(bls.sent).toHaveLength(1);
    expect(await lastCpiFetch(database)).toBeNull();
    expect(await readCpiFetch(database)).toMatchObject({
      failedRound: "2026-11",
      failedTries: 1,
      lastFailure: "unreachable",
    });
    expect(await cpiNow(database, "CUUR0000SAF11")).toMatchObject({ source: "shipped" });

    await runOn(at("11-21"));

    expect(bls.sent).toHaveLength(3);
    expect(await lastCpiFetch(database)).toEqual(at("11-21"));
    expect(await readCpiFetch(database)).toMatchObject({ failedTries: 0, lastFailure: null });
    expect(await cpiNow(database, "CUUR0000SAF11")).toEqual({
      series: "CUUR0000SAF11",
      period: "2026-10",
      value: 336.125,
      source: "fetched",
    });
  });

  it("stops a round that always fails at the cap, never throws, and starts again on the next 20th", async () => {
    const days = ["11-20", "11-21", "11-22", "11-23", "11-24", "11-25", "11-26", "12-05"];
    for (const _day of days) bls.answers.push(timeout());

    for (const day of days) await runOn(at(day));

    expect(bls.sent).toHaveLength(CPI_FETCH_CAP);
    expect(await readCpiFetch(database)).toMatchObject({
      failedRound: "2026-11",
      failedTries: CPI_FETCH_CAP,
      lastFailure: "timed out",
    });

    bls.answers.length = 0;
    await runOn(at("12-20"));

    expect(bls.sent).toHaveLength(CPI_FETCH_CAP + 2);
    expect(await lastCpiFetch(database)).toEqual(at("12-20"));
  });

  it("raises one System notice when a round stops at the cap, keeps it while stopped, and ends it on the next success", async () => {
    const failing = ["11-20", "11-21", "11-22", "11-23"];
    for (const _day of [...failing, "11-24"]) bls.answers.push(timeout());

    for (const day of failing) await runOn(at(day));
    expect(await cpiNotices()).toEqual([]);

    await runOn(at("11-24"));
    for (const day of ["11-25", "11-26", "12-05"]) await runOn(at(day));

    expect(bls.sent).toHaveLength(CPI_FETCH_CAP);
    const notices = await listOpenNotices(database);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "condition",
      condition: CPI_STOPPED,
      text: "The app could not fetch the newest CPI from BLS. It keeps using the CPI value from 2025, and tries again after the next 20th.",
    });

    // The next round stops too: still the one notice.
    for (const day of ["12-20", "12-21", "12-22", "12-23", "12-24"]) {
      bls.answers.push(timeout());
      await runOn(at(day));
    }
    expect(await cpiNotices()).toHaveLength(1);
    expect(await readCpiFetch(database)).toMatchObject({ failedRound: "2026-12", failedTries: 5 });

    const nextYear = new Date("2027-01-20T11:00:00.000Z");
    await runOn(nextYear);

    expect(await lastCpiFetch(database)).toEqual(nextYear);
    expect(await cpiNotices()).toEqual([]);
  });

  it("names the month of the newest CPI value in words", () => {
    expect(cpiPeriodLabel("2026-09")).toBe("September 2026");
    expect(cpiPeriodLabel("2025")).toBe("2025");
    expect(cpiPeriodLabel("2023-2024")).toBe("2023-2024");
  });

  it("keeps the values of a partial fetch, and fetches the round again the next day", async () => {
    const allItems = Response.json(blsAnswer("CUUR0000SA0", NEWER.CUUR0000SA0));
    bls.answers.push(allItems, new Response("Too Many Requests", { status: 429 }));

    await runOn(at("11-20"));

    expect(await cpiNow(database, "CUUR0000SA0")).toMatchObject({
      period: "2026-10",
      source: "fetched",
    });
    expect(await cpiNow(database, "CUUR0000SAF11")).toMatchObject({ source: "shipped" });
    expect(await readCpiFetch(database)).toMatchObject({
      fetchedAt: null,
      lastFailure: "rate limited",
    });

    await runOn(at("11-21"));

    expect(bls.sent).toHaveLength(4);
    expect(await cpiNow(database, "CUUR0000SAF11")).toMatchObject({ source: "fetched" });
  });

  it.each([
    ["a request error", new TypeError("fetch failed"), "unreachable"],
    ["a timeout", timeout(), "timed out"],
    ["a 429", new Response("", { status: 429 }), "rate limited"],
    ["a 404", new Response("", { status: 404 }), "refused"],
    [
      "BLS's daily limit",
      Response.json({
        status: "REQUEST_NOT_PROCESSED",
        message: [
          "Request could not be serviced, as the daily threshold for total number of requests allocated to the user has been reached.",
        ],
        Results: {},
      }),
      "rate limited",
    ],
    ["an answer that is not JSON", new Response("<html>"), "bad answer"],
    [
      "an answer for another series",
      Response.json(blsAnswer("CUUR0000SA0E", { "2026-10": "300" })),
      "bad answer",
    ],
    [
      "an answer with no monthly value",
      Response.json(blsAnswer("CUUR0000SA0", { "2026-13": "330", "2026-10": "-" })),
      "bad answer",
    ],
  ])("maps %s to its own failure", async (_case, answer, failure) => {
    bls.answers.push(answer);

    await runOn(at("11-20"));

    expect(await readCpiFetch(database)).toMatchObject({ failedTries: 1, lastFailure: failure });
  });

  it("writes only CPI rows, so a fetch never changes a Budget", async () => {
    const before = await readEveryTable(database);

    await runOn(at("11-20"));

    const after = await readEveryTable(database);
    const changed = Object.keys(after).filter(
      (name) => JSON.stringify(after[name]) !== JSON.stringify(before[name]),
    );
    expect(changed.sort()).toEqual(["cpi_fetch", "cpi_values"]);
  });
});

describe("the newest CPI value", () => {
  let test: TestDatabase;

  let stopNotify: () => void;

  beforeEach(async () => {
    test = await newTestDatabase();
    stopNotify = startNotify({ database: test.database }).stop;
  });

  afterEach(() => {
    stopNotify();
    test.close();
  });

  const fetchOnce = async (answers: Record<CpiSeries, Record<string, string>>) => {
    const bls = new StubBls();
    for (const series of ["CUUR0000SA0", "CUUR0000SAF11"] as const) {
      bls.answers.push(Response.json(blsAnswer(series, answers[series])));
    }
    const { stop } = startCpiFetch({
      database: test.database,
      timeZone: async () => NEW_YORK,
      fetch: bls.fetch,
      now: () => at("11-20"),
    });
    try {
      await new CpiFetchJob().run();
    } finally {
      stop();
    }
  };

  it("is the shipped value until a fetch brings a newer one", async () => {
    expect(await cpiNow(test.database, "CUUR0000SAF11")).toEqual({
      series: "CUUR0000SAF11",
      period: "2026-09",
      value: 335,
      source: "shipped",
    });
    // The newest shipped all-items value averages the CE year 2025, which ends in December.
    expect(await cpiNow(test.database, "CUUR0000SA0")).toEqual({
      series: "CUUR0000SA0",
      period: "2025",
      value: 330.5,
      source: "shipped",
    });
  });

  it("keeps the shipped value over an older fetched one", async () => {
    await fetchOnce({
      CUUR0000SA0: { "2025-11": "325.000" },
      CUUR0000SAF11: { "2026-08": "334.000" },
    });

    expect(await cpiNow(test.database, "CUUR0000SAF11")).toMatchObject({
      period: "2026-09",
      source: "shipped",
    });
    expect(await cpiNow(test.database, "CUUR0000SA0")).toMatchObject({
      period: "2025",
      source: "shipped",
    });
  });

  it("takes the fetched value for the same month or a newer one", async () => {
    await fetchOnce({
      CUUR0000SA0: { "2026-01": "331.000", "2025-12": "330.000" },
      CUUR0000SAF11: { "2026-09": "335.250" },
    });

    expect(await cpiNow(test.database, "CUUR0000SAF11")).toEqual({
      series: "CUUR0000SAF11",
      period: "2026-09",
      value: 335.25,
      source: "fetched",
    });
    expect(await cpiNow(test.database, "CUUR0000SA0")).toMatchObject({
      period: "2026-01",
      value: 331,
      source: "fetched",
    });
  });
});
