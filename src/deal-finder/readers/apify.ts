import type { Logger } from "../../log.ts";
import { type Costed, PriceSourceError } from "../adapter.ts";
import { callSource, isRecord, recordsIn, type SourceAnswer } from "./http.ts";

// Apify, the Scraping service (spec 15, Price sources). Each Store's reader runs its own Actor
// through this client. Every run sets `maxTotalChargeUsd=1.00`, the lowest Apify accepts, and the
// run's cost comes from Apify's own run record. At most 2 Actor runs go at once.
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

// A run's cost in billionths of a dollar. A run record with no readable cost counts at the run's
// cap, so the month's total never runs low.
export function runCostNanos(run: Record<string, unknown>): number {
  const usd = run.usageTotalUsd;
  if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0 && usd <= 100) {
    return Math.round(usd * 1e9);
  }
  return Number(MAX_CHARGE_USD) * 1e9;
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

  // Runs one Actor with this input, and gives its dataset's rows and the run's cost.
  async run(token: string, actor: string, input: Record<string, unknown>): Promise<ApifyRows> {
    await this.slot();
    try {
      return await this.runNow(token, actor, input);
    } finally {
      this.release();
    }
  }

  private async runNow(
    token: string,
    actor: string,
    input: Record<string, unknown>,
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
        const cost = await this.abort(token, run);
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
        throw withCost(failed, await this.abort(token, run));
      }
      // A run the reader cannot follow is stopped, as on the timeout path.
      if (polled.status !== 200) {
        throw this.failure(actor, polled, await this.abort(token, run));
      }
    }
    const cost = runCostNanos(run);
    if (run.status === "TIMED-OUT") {
      this.logger.warn("An Actor run timed out", { actor });
      throw new PriceSourceError("timed out", "The Actor run took too long.", cost);
    }
    if (run.status !== "SUCCEEDED") {
      this.logger.warn("An Actor run failed", { actor, runStatus: run.status });
      throw new PriceSourceError("store failed", "The Actor run failed.", cost);
    }
    const dataset = typeof run.defaultDatasetId === "string" ? run.defaultDatasetId : "";
    if (!APIFY_ID.test(dataset)) {
      throw new PriceSourceError("store failed", "Apify sent no dataset.", cost);
    }
    const items = new URLSearchParams({ clean: "true", format: "json", limit: String(MAX_ROWS) });
    let read: SourceAnswer;
    try {
      read = await this.call(token, "GET", `/v2/datasets/${dataset}/items?${items}`);
    } catch (error) {
      throw withCost(error instanceof PriceSourceError ? error : unread(), cost);
    }
    if (read.status !== 200) throw this.failure(actor, read, cost);
    return { value: recordsIn(read.body), costNanos: cost };
  }

  // Stops a run, and gives its cost from the run record Apify answers with. When that answer has
  // none, or the abort fails, the run counts at its cap, since it may have spent up to it.
  private async abort(token: string, run: Record<string, unknown>): Promise<number> {
    try {
      const answer = await this.call(token, "POST", `/v2/actor-runs/${run.id}/abort`);
      const stopped = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : {};
      return answer.status === 200 ? runCostNanos(stopped) : runCostNanos({});
    } catch {
      return runCostNanos({});
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

// The run record in an answer, with an ID in Apify's form.
function runIn(answer: SourceAnswer): Record<string, unknown> {
  const run = isRecord(answer.body) && isRecord(answer.body.data) ? answer.body.data : null;
  if (run === null || typeof run.id !== "string" || !APIFY_ID.test(run.id)) {
    throw new PriceSourceError("store failed", "Apify sent no run.");
  }
  return run;
}
