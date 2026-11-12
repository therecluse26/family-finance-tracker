import type { Logger } from "../../log.ts";
import { type Costed, PriceSourceError } from "../adapter.ts";
import { callSource, isRecord, recordsIn, type SourceAnswer } from "./http.ts";

// Apify, the Scraping service (spec 15, Price sources). Each Store's reader runs its own Actor
// through this client. Every run sets `maxTotalChargeUsd=1.00`, the lowest Apify accepts, and the
// run's cost comes from its run record's price list (runCostNanos). At most 2 Actor runs go at once.
//
// A run starts with `POST /v2/acts/{actor}/runs` and waits for its end, then reads its dataset.
// Apify's `run-sync-get-dataset-items` gives only the dataset, with no run record, so it cannot
// give the run's cost.

export const APIFY_BASE_URL = "https://api.apify.com";

const MAX_CHARGE_USD = "1.00";
const RUNS_AT_ONCE = 2;
// Apify waits up to 60 s for a run in one request.
const WAIT_SECONDS = 60;
// A run that has not ended after 5 minutes, or after 6 waits, is stopped. The spike's runs took 2
// to 32 s.
const RUN_DEADLINE_MS = 5 * 60_000;
const MAX_WAITS = 6;
// A dataset holds at most this many rows for the app.
const MAX_ROWS = 1000;
// Apify's run and dataset IDs, in the form it gives them. Each goes into a URL path.
const APIFY_ID = /^[A-Za-z0-9]{1,40}$/;

const ENDED = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

export type ApifyRows = Costed<Record<string, unknown>[]>;

export type ApifyTimings = { requestMs: number; runMs: number; waitSeconds: number };

const DEFAULT_TIMINGS: ApifyTimings = {
  requestMs: (WAIT_SECONDS + 15) * 1000,
  runMs: RUN_DEADLINE_MS,
  waitSeconds: WAIT_SECONDS,
};

// The pay-per-event events an Actor charges, as its reader names them (spec 15, Cost and limits).
export type ActorEvents = {
  // The event charged as a run starts: Apify's own `apify-actor-start`, charged once for each
  // started GB of the run's memory, or the Actor's own, such as `actor-start`, charged once. Null
  // for an Actor that charges none.
  start: string | null;
  // The event charged for each dataset row, such as `apify-default-dataset-item`. Null for an Actor
  // that charges per request, not per row.
  row: string | null;
  // An event charged at least once a run, after it ends, such as target-search's `request`.
  perRun?: string;
};

const APIFY_START = "apify-actor-start";
const MAX_CHARGE_NANOS = Number(MAX_CHARGE_USD) * 1e9;
const MB_PER_GB = 1024;

// A finite number from 0 to `max`, else null.
const amountIn = (value: unknown, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;

// Each event's price in billionths of a dollar, from the run record's pay-per-event price list.
// Null when the record has none.
function priceList(run: Record<string, unknown>): Map<string, number> | null {
  const info = isRecord(run.pricingInfo) ? run.pricingInfo : null;
  const perEvent = info !== null && isRecord(info.pricingPerEvent) ? info.pricingPerEvent : null;
  const events =
    perEvent !== null && isRecord(perEvent.actorChargeEvents) ? perEvent.actorChargeEvents : null;
  if (events === null) return null;
  const prices = new Map<string, number>();
  for (const [event, value] of Object.entries(events)) {
    const usd = isRecord(value) ? amountIn(value.eventPriceUsd, 100) : null;
    if (usd !== null) prices.set(event, Math.round(usd * 1e9));
  }
  return prices.size === 0 ? null : prices;
}

// How many of each event Apify charged so far.
function chargedCounts(run: Record<string, unknown>): Map<string, number> {
  const counts = new Map<string, number>();
  const charged = isRecord(run.chargedEventCounts) ? run.chargedEventCounts : {};
  for (const [event, value] of Object.entries(charged)) {
    const count = amountIn(value, 1_000_000);
    if (count !== null) counts.set(event, Math.floor(count));
  }
  return counts;
}

// A run's cost in billionths of a dollar, from its run record and the rows its dataset holds (null
// when they are not known). At a run's end Apify has charged only its start events: row events are
// charged later. So the run counts what it will be charged, from the Actor's price list:
// - its start events, at least one for each started GB of its memory (`options.memoryMbytes`);
// - its row events, at least one for each dataset row;
// - its per-run event, at least once;
// - every other event Apify charged.
// The count holds every charged event, so it is never below the charged events alone. The cost is
// the larger of the count and `usageTotalUsd`, up to the run's `maxTotalChargeUsd`. A run record with no readable price list, or one without an event the
// reader names, or a row-charging run whose rows are not known, counts at `maxTotalChargeUsd`, so
// the month's total never runs low.
export function runCostNanos(
  run: Record<string, unknown>,
  events: ActorEvents | null,
  rows: number | null,
): number {
  const prices = priceList(run);
  if (prices === null || events === null) return MAX_CHARGE_NANOS;
  const counts = chargedCounts(run);
  if (events.start !== null) {
    if (!prices.has(events.start)) return MAX_CHARGE_NANOS;
    let least = 1;
    if (events.start === APIFY_START) {
      const options = isRecord(run.options) ? run.options : {};
      const memory = amountIn(options.memoryMbytes, 1_000_000);
      if (memory === null || memory === 0) return MAX_CHARGE_NANOS;
      least = Math.ceil(memory / MB_PER_GB);
    }
    counts.set(events.start, Math.max(counts.get(events.start) ?? 0, least));
  }
  if (events.row !== null) {
    if (!prices.has(events.row) || rows === null) return MAX_CHARGE_NANOS;
    counts.set(events.row, Math.max(counts.get(events.row) ?? 0, rows));
  }
  if (events.perRun !== undefined) {
    if (!prices.has(events.perRun)) return MAX_CHARGE_NANOS;
    counts.set(events.perRun, Math.max(counts.get(events.perRun) ?? 0, 1));
  }
  let counted = 0;
  for (const [event, count] of counts) counted += (prices.get(event) ?? 0) * count;
  const usage = amountIn(run.usageTotalUsd, 100);
  const cost = Math.max(usage === null ? 0 : Math.round(usage * 1e9), counted);
  return Math.min(cost, MAX_CHARGE_NANOS);
}

export class ApifyClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly timings: ApifyTimings;
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(options: { baseUrl: string; logger: Logger; timings?: Partial<ApifyTimings> }) {
    this.baseUrl = options.baseUrl;
    this.logger = options.logger;
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
  }

  // For Test: an account read with the token.
  async checkToken(token: string): Promise<Costed<true>> {
    const answer = await this.call(token, "GET", "/v2/users/me");
    if (answer.status !== 200) throw this.failure("account", answer);
    return { value: true, costNanos: null };
  }

  // Runs one Actor with this input, and gives its dataset's rows and the run's cost, counted with
  // the events the Actor charges.
  async run(
    token: string,
    call: { actor: string; input: Record<string, unknown>; events: ActorEvents | null },
  ): Promise<ApifyRows> {
    await this.slot();
    try {
      return await this.runNow(token, call.actor, call.input, call.events);
    } finally {
      this.release();
    }
  }

  private async runNow(
    token: string,
    actor: string,
    input: Record<string, unknown>,
    events: ActorEvents | null,
  ): Promise<ApifyRows> {
    const deadline = Date.now() + this.timings.runMs;
    const params = new URLSearchParams({
      maxTotalChargeUsd: MAX_CHARGE_USD,
      waitForFinish: String(this.timings.waitSeconds),
    });
    const started = await this.call(
      token,
      "POST",
      `/v2/acts/${actor.replace("/", "~")}/runs?${params}`,
      input,
    );
    if (started.status !== 201 && started.status !== 200) throw this.failure(actor, started);
    let run = runIn(started);
    // From here a run exists, so every end, good or not, carries its cost.
    for (let waits = 0; !ENDED.has(String(run.status)); waits += 1) {
      if (waits >= MAX_WAITS || Date.now() >= deadline) {
        const cost = await this.abort(token, run, events);
        this.logger.warn("An Actor run took too long and was stopped", { actor });
        throw new PriceSourceError("timed out", "The Actor run took too long.", cost);
      }
      const wait = new URLSearchParams({ waitForFinish: String(this.timings.waitSeconds) });
      let polled: SourceAnswer;
      try {
        polled = await this.call(token, "GET", `/v2/actor-runs/${run.id}?${wait}`);
        if (polled.status === 200) run = runIn(polled);
      } catch (error) {
        const failed = error instanceof PriceSourceError ? error : unread();
        throw withCost(failed, await this.abort(token, run, events));
      }
      // A run the reader cannot follow is stopped, as on the timeout path.
      if (polled.status !== 200) {
        throw this.failure(actor, polled, await this.abort(token, run, events));
      }
    }
    if (run.status === "TIMED-OUT") {
      this.logger.warn("An Actor run timed out", { actor });
      const cost = await this.endedCost(token, run, events);
      throw new PriceSourceError("timed out", "The Actor run took too long.", cost);
    }
    if (run.status !== "SUCCEEDED") {
      this.logger.warn("An Actor run failed", { actor, runStatus: run.status });
      const cost = await this.endedCost(token, run, events);
      throw new PriceSourceError("store failed", "The Actor run failed.", cost);
    }
    const dataset = datasetOf(run);
    if (dataset === null) {
      const cost = runCostNanos(run, events, null);
      throw new PriceSourceError("store failed", "Apify sent no dataset.", cost);
    }
    const items = new URLSearchParams({ clean: "true", format: "json", limit: String(MAX_ROWS) });
    let read: SourceAnswer;
    try {
      read = await this.call(token, "GET", `/v2/datasets/${dataset}/items?${items}`);
    } catch (error) {
      const failed = error instanceof PriceSourceError ? error : unread();
      throw withCost(failed, await this.endedCost(token, run, events));
    }
    if (read.status !== 200) {
      throw this.failure(actor, read, await this.endedCost(token, run, events));
    }
    const rows = recordsIn(read.body);
    const count = Array.isArray(read.body) ? Math.max(read.body.length, rows.length) : rows.length;
    return { value: rows, costNanos: runCostNanos(run, events, count) };
  }

  // The cost of a run that ended without its rows read, with the row count of its dataset.
  private async endedCost(
    token: string,
    run: Record<string, unknown>,
    events: ActorEvents | null,
  ): Promise<number> {
    const rows = events === null || events.row === null ? null : await this.rowCount(token, run);
    return runCostNanos(run, events, rows);
  }

  // How many rows a run's dataset holds, from Apify's dataset record. Null when it cannot be read.
  private async rowCount(token: string, run: Record<string, unknown>): Promise<number | null> {
    const dataset = datasetOf(run);
    if (dataset === null) return null;
    try {
      const answer = await this.call(token, "GET", `/v2/datasets/${dataset}`);
      const data = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : {};
      const count = answer.status === 200 ? amountIn(data.itemCount, 1_000_000) : null;
      return count === null ? null : Math.floor(count);
    } catch {
      return null;
    }
  }

  // Stops a run, and gives its cost from the run record Apify answers with. When that answer has
  // none, or the abort fails, the run counts at its cap, since it may have spent up to it.
  private async abort(
    token: string,
    run: Record<string, unknown>,
    events: ActorEvents | null,
  ): Promise<number> {
    try {
      const answer = await this.call(token, "POST", `/v2/actor-runs/${run.id}/abort`);
      const stopped = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : null;
      if (answer.status !== 200 || stopped === null) return MAX_CHARGE_NANOS;
      return await this.endedCost(token, stopped, events);
    } catch {
      return MAX_CHARGE_NANOS;
    }
  }

  private call(
    token: string,
    method: "GET" | "POST",
    path: string,
    input?: Record<string, unknown>,
  ): Promise<SourceAnswer> {
    return callSource(
      new URL(path, this.baseUrl),
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(input === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      },
      this.timings.requestMs,
    );
  }

  private slot(): Promise<void> {
    if (this.running < RUNS_AT_ONCE) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) this.running -= 1;
    else next();
  }

  // Apify's answer, mapped to its own error, with the cost of a run that exists. Only the status
  // is logged.
  private failure(
    call: string,
    answer: SourceAnswer,
    cost: number | null = null,
  ): PriceSourceError {
    return withCost(this.mappedFailure(call, answer), cost);
  }

  private mappedFailure(call: string, answer: SourceAnswer): PriceSourceError {
    this.logger.warn("Apify refused a call", { call, status: answer.status });
    const error = isRecord(answer.body) && isRecord(answer.body.error) ? answer.body.error : {};
    const type = typeof error.type === "string" ? error.type : "";
    const limit = /limit|usage|exceed|insufficient|not-enough|credit|quota|paid/i.test(type);
    if (answer.status === 401)
      return new PriceSourceError("refused key", "Apify refused the token.");
    if (answer.status === 402 || answer.status === 429 || (answer.status === 403 && limit)) {
      return new PriceSourceError("usage limit", "Apify usage limit reached.");
    }
    if (answer.status === 403)
      return new PriceSourceError("refused key", "Apify refused the token.");
    if (answer.status === 408 || answer.status === 504) {
      return new PriceSourceError("timed out", "Apify took too long to answer.");
    }
    return new PriceSourceError("store failed", "Apify could not run the Actor.");
  }
}

// The same error, carrying a run's cost.
const withCost = (error: PriceSourceError, cost: number | null) =>
  new PriceSourceError(error.kind, error.message, cost ?? undefined);

const unread = () => new PriceSourceError("store failed", "Apify could not be read.");

// A run's dataset ID, in Apify's form, as it goes into a URL path. Null for none.
function datasetOf(run: Record<string, unknown>): string | null {
  const dataset = typeof run.defaultDatasetId === "string" ? run.defaultDatasetId : "";
  return APIFY_ID.test(dataset) ? dataset : null;
}

// The run record in an answer, with an ID in Apify's form.
function runIn(answer: SourceAnswer): Record<string, unknown> {
  const run = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : null;
  if (run === null || typeof run.id !== "string" || !APIFY_ID.test(run.id)) {
    throw new PriceSourceError("store failed", "Apify sent no run.");
  }
  return run;
}
