import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { AI_USE_LABELS } from "../../../ai/ai-view.ts";
import {
  AI_REQUEST_LOG_KEEP_DAYS,
  type AiRequestLogEntryView,
  type AiRequestLogItem,
  type AiRequestLogKeepDays,
  type AiRequestLogPage,
  type AiRequestLogSettingsView,
  type AiRequestUsage,
  CLEANUP_FAILED_AGAIN,
  failureLine,
} from "../../../ai/request-log-view.ts";
import { callCost } from "../../../ai/usage-view.ts";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { Card } from "../../components/Card.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import {
  ADD_PANEL,
  BUTTONS,
  CHOICE,
  DoneLine,
  HINT,
  Lead,
  SettingCard,
  TEXT_LINK,
} from "./settings-ui.tsx";

// The AI request log (spec 08, AI request log): its card on the AI usage page, with the "Keep AI
// request text" switch and the kept days, the log page of kept calls, newest first, and one kept
// call's page with its request and reply. The text shows as plain text only: React writes it as
// text, never as Markdown or HTML.

// The log page and a kept call's page.
export const AI_REQUEST_LOG_PATH = "/settings/ai/usage/log";
export const aiRequestPath = (id: number) => `${AI_REQUEST_LOG_PATH}/${id}`;

// The page's requests, exactly as it sends them. The write sends a JSON body: the server answers
// 415 to a write without one.
export const readAiRequestLog = (before?: number) =>
  api["ai-request-log"].$get({ query: before === undefined ? {} : { before: String(before) } });
export const readAiRequestLogSettings = () => api["ai-request-log"].settings.$get();
export const readAiRequestLogEntry = (id: string) =>
  api["ai-request-log"][":id"].$get({ param: { id } });
export const saveAiRequestLog = (settings: { on: boolean; keepDays: AiRequestLogKeepDays }) =>
  api["ai-request-log"].settings.$put({ json: settings });

// What the confirm step says before the switch goes off.
export const TURN_OFF_QUESTION =
  "Turn off the AI request log? This deletes all kept AI request text now. Backups made before keep their copies until they roll off.";

// What the card says after a save: `said`, or, when the cleanup was stopped and still is, that the
// retry failed too.
export function savedLine(
  before: AiRequestLogSettingsView,
  after: AiRequestLogSettingsView,
  said: string,
): { done: string } | { error: string } {
  return before.stopped && after.stopped ? { error: CLEANUP_FAILED_AGAIN } : { done: said };
}

// The request, kept as compact JSON, indented for reading. A request cut at 256 KB is no longer
// whole JSON, so it shows as kept.
export function readableRequest(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// The words to show for a refused request: the server's own.
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

const count = (tokens: number) => tokens.toLocaleString("en-US");

// "Nov 20, 8:15 AM" in the Household time zone. `today` gives the year rule of dateLabel.
function whenLabel(at: string, zone: string, today: string): string {
  const moment = new Date(at);
  return `${dateLabel(calendarDateIn(moment, zone), today)}, ${timeLabel(moment, zone)}`;
}

// The board's switch (.sw): 40 by 24 px, accent when on, the field gray when off. This page draws
// its own, as WeeklySummary.tsx and Budgets.tsx do; one shared switch should move to components.
const SWITCH_TRACK =
  "relative inline-block h-6 w-10 shrink-0 rounded-full bg-field peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-70 after:absolute after:top-[3px] after:left-[3px] after:size-[18px] after:rounded-full after:bg-white after:content-[''] peer-checked:after:left-[19px]";

// The card on the AI usage page. The switch and the kept days save at once. Turning the switch
// off asks first, since it deletes every kept text.
export function AiRequestLogCard(props: {
  initial: AiRequestLogSettingsView;
  // Starts with the confirm step open, for a test of the first paint.
  confirming?: boolean;
}) {
  const [view, setView] = useState(props.initial);
  const [confirming, setConfirming] = useState(props.confirming ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  async function save(settings: { on: boolean; keepDays: AiRequestLogKeepDays }, said: string) {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      const res = await saveAiRequestLog(settings);
      if (!res.ok) return setError(await refusal(res));
      const after = ((await res.json()) as { settings: AiRequestLogSettingsView }).settings;
      const line = savedLine(view, after, said);
      setView(after);
      setConfirming(false);
      if ("error" in line) setError(line.error);
      else setDone(line.done);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  const turn = () => {
    if (view.on) return setConfirming(true);
    return save({ on: true, keepDays: view.keepDays }, "The AI request log is on.");
  };

  return (
    <SettingCard
      id="ai-request-log"
      title="AI request log"
      status={
        view.on ? <StatusText tone="good">On</StatusText> : <span className="text-muted">Off</span>
      }
    >
      <Lead>
        The exact text of each AI call: what the AI provider got, after the privacy filter, and what
        came back. Kept on this server only.
      </Lead>
      <div className="mt-4 border-t border-line-soft pt-3.5">
        <label className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
          <input
            type="checkbox"
            role="switch"
            className="peer sr-only"
            aria-checked={view.on}
            aria-describedby="ai-request-log-what"
            checked={view.on}
            disabled={busy || confirming}
            onChange={turn}
          />
          <span aria-hidden="true" className={SWITCH_TRACK} />
          <span className="min-w-0 flex-[1_1_220px]">
            <span className="block font-semibold">Keep AI request text</span>
            <span id="ai-request-log-what" className="mt-0.5 block text-small text-muted">
              Off by default. The AI usage metadata on this page is kept either way.
            </span>
          </span>
        </label>
      </div>
      {confirming ? (
        <div className={ADD_PANEL}>
          <p id="ai-request-log-confirm" className="font-semibold">
            {TURN_OFF_QUESTION}
          </p>
          <div className={BUTTONS}>
            <Button
              type="button"
              aria-describedby="ai-request-log-confirm"
              disabled={busy}
              onClick={() =>
                save(
                  { on: false, keepDays: view.keepDays },
                  "The AI request log is off. Its kept text is deleted.",
                )
              }
            >
              Turn off and delete
            </Button>
            <Button
              type="button"
              variant="outlined"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Keep it on
            </Button>
          </div>
        </div>
      ) : null}
      <fieldset className="mt-4">
        <legend className="text-sm font-semibold">Keep text for</legend>
        <div className="flex flex-wrap gap-x-5">
          {AI_REQUEST_LOG_KEEP_DAYS.map((days) => (
            <label key={days} className={CHOICE}>
              <input
                type="radio"
                name="ai-request-log-days"
                value={days}
                checked={view.keepDays === days}
                disabled={busy}
                onChange={() => save({ on: view.on, keepDays: days }, `Text is kept ${days} days.`)}
              />
              {days} days
            </label>
          ))}
        </div>
        <p className={HINT}>
          Each night the app deletes text older than this. Fewer days deletes the older text now.
        </p>
      </fieldset>
      {view.stopped ? (
        <div className="mt-3.5">
          <p className="text-small">
            <StatusText tone="critical">
              The app could not delete old AI request text, so the log keeps no new text.
            </StatusText>
          </p>
          <div className={BUTTONS}>
            <Button
              type="button"
              variant="outlined"
              size="small"
              disabled={busy}
              onClick={() => save(view, "The cleanup ran again.")}
            >
              Try the cleanup again
            </Button>
          </div>
        </div>
      ) : null}
      <DoneLine done={done} />
      <ErrorLine error={error} />
      <p className="mt-3.5 text-sm">
        <Link className={TEXT_LINK} to={AI_REQUEST_LOG_PATH}>
          Open the AI request log
        </Link>
      </p>
    </SettingCard>
  );
}

// A kept call's tokens and cost on one line, or that its failed call counted nothing.
function usageLine(usage: AiRequestUsage): string {
  if (usage === null) return "No usage counted";
  const tokens =
    usage.noCacheTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
  return `${count(tokens)} tokens · ${callCost(usage.costNanos)}`;
}

// The log page's list, once a page has loaded.
export function AiRequestLogList(props: {
  settings: AiRequestLogSettingsView;
  entries: readonly AiRequestLogItem[];
  zone: string;
  today: string;
}) {
  const { settings, entries, zone, today } = props;
  return (
    <>
      {settings.on ? null : (
        <p className="text-muted">
          The AI request log is off, so it keeps no new text. Turn it on on the{" "}
          <Link className={TEXT_LINK} to="/settings/ai/usage">
            AI usage page
          </Link>
          .
        </p>
      )}
      {settings.stopped ? (
        <p className="text-small">
          <StatusText tone="critical">
            The app could not delete old AI request text, so the log keeps no new text. Try the
            cleanup again on the AI usage page.
          </StatusText>
        </p>
      ) : null}
      {entries.length === 0 ? (
        <Card>
          <p className="text-muted">No kept AI request text.</p>
        </Card>
      ) : (
        <Card padding="list" aria-labelledby="ai-request-log-calls">
          <h3 id="ai-request-log-calls" className="sr-only">
            Kept AI calls
          </h3>
          <ol>
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 border-t border-line-soft py-[11px] text-sm first:border-t-0"
              >
                <span className="min-w-0 flex-[1_1_220px]">
                  <Link
                    className="font-semibold text-ink hover:text-accent hover:underline"
                    to={aiRequestPath(entry.id)}
                  >
                    {whenLabel(entry.at, zone, today)}
                  </Link>
                  <span className="block text-small text-muted [overflow-wrap:anywhere]">
                    {AI_USE_LABELS[entry.use]} · {entry.model}
                  </span>
                  {entry.failure === null ? null : (
                    <span className="block text-small">
                      <StatusText tone="critical">
                        Failed: {failureLine(entry.failure, entry.failureStatus)}
                      </StatusText>
                    </span>
                  )}
                </span>
                <span className="ml-auto text-right tabular-nums">{usageLine(entry.usage)}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}

// The page heading of the log pages: an h2 under Settings' h1, and a link back.
function LogHeading(props: { title: string; back: { to: string; label: string } }) {
  return (
    <div>
      <h2 className="text-heading font-bold">{props.title}</h2>
      <p className="mt-1 text-sm">
        <Link className={TEXT_LINK} to={props.back.to}>
          {props.back.label}
        </Link>
      </p>
    </div>
  );
}

// Settings → AI → AI usage → AI request log: the kept calls, newest first, 50 at a time.
export function AiRequestLog() {
  const [page, setPage] = useState<AiRequestLogPage | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const zone = useHouseholdZone();

  async function load(before?: number) {
    setBusy(true);
    setError(undefined);
    try {
      const res = await readAiRequestLog(before);
      if (!res.ok) return setError("The AI request log did not load.");
      const next = ((await res.json()) as { log: AiRequestLogPage }).log;
      setPage((current) =>
        before === undefined || current === undefined
          ? next
          : { ...next, entries: [...current.entries, ...next.entries] },
      );
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page loads once.
  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <LogHeading
        title="AI request log"
        back={{ to: "/settings/ai/usage", label: "Back to AI usage" }}
      />
      <ErrorLine error={error} />
      {page === undefined || zone === undefined ? null : (
        <>
          <AiRequestLogList
            settings={page.settings}
            entries={page.entries}
            zone={zone}
            today={calendarDateIn(new Date(), zone)}
          />
          {page.older === null ? null : (
            <div>
              <Button
                type="button"
                variant="outlined"
                disabled={busy}
                onClick={() => load(page.older ?? undefined)}
              >
                Show older
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// A request or a reply as plain text, in a box that scrolls inside itself, so a long text never
// widens the page.
function TextBox(props: { id: string; title: string; text: string; cut: boolean; empty: string }) {
  return (
    <Card aria-labelledby={props.id}>
      <h3 id={props.id} className="text-heading font-bold">
        {props.title}
      </h3>
      {props.cut ? (
        <p className="mt-1.5 text-small">
          <StatusText tone="serious">Cut at 256 KB: the rest was not kept.</StatusText>
        </p>
      ) : null}
      {props.text === "" ? (
        <p className="mt-1.5 text-muted">{props.empty}</p>
      ) : (
        <pre
          // A box that scrolls is a stop for the keyboard, so it can scroll without a mouse.
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the box scrolls.
          tabIndex={0}
          className="mt-3 max-h-[36rem] overflow-y-auto rounded-control border border-line bg-page p-3 font-mono text-small whitespace-pre-wrap [overflow-wrap:anywhere]"
        >
          {props.text}
        </pre>
      )}
    </Card>
  );
}

const FACT = "text-muted";
const VALUE = "min-w-0 tabular-nums [overflow-wrap:anywhere]";

// One kept call: its facts, then its request and its reply.
export function AiRequestLogEntryReport(props: {
  entry: AiRequestLogEntryView;
  zone: string;
  today: string;
}) {
  const { entry, zone, today } = props;
  const { usage } = entry;
  return (
    <>
      <Card>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
          <dt className={FACT}>Use</dt>
          <dd className={VALUE}>{AI_USE_LABELS[entry.use]}</dd>
          <dt className={FACT}>Model</dt>
          <dd className={VALUE}>{entry.model}</dd>
          <dt className={FACT}>Time</dt>
          <dd className={VALUE}>{whenLabel(entry.at, zone, today)}</dd>
          {usage === null ? (
            <>
              <dt className={FACT}>Usage</dt>
              <dd className={VALUE}>No usage counted</dd>
            </>
          ) : (
            <>
              <dt className={FACT}>Input without cache</dt>
              <dd className={VALUE}>{count(usage.noCacheTokens)}</dd>
              <dt className={FACT}>Cache read</dt>
              <dd className={VALUE}>{count(usage.cacheReadTokens)}</dd>
              <dt className={FACT}>Cache write</dt>
              <dd className={VALUE}>{count(usage.cacheWriteTokens)}</dd>
              <dt className={FACT}>Output</dt>
              <dd className={VALUE}>{count(usage.outputTokens)}</dd>
              <dt className={FACT}>Cost</dt>
              <dd className={VALUE}>{callCost(usage.costNanos)}</dd>
            </>
          )}
        </dl>
        {entry.failure === null ? null : (
          <p className="mt-3 text-sm">
            <StatusText tone="critical">
              Failed: {failureLine(entry.failure, entry.failureStatus)}
            </StatusText>
          </p>
        )}
      </Card>
      <TextBox
        id="ai-request-sent"
        title="Request"
        text={readableRequest(entry.request)}
        cut={entry.requestCut}
        empty="No request text."
      />
      <TextBox
        id="ai-request-reply"
        title="Reply"
        text={entry.response}
        cut={entry.responseCut}
        empty="No reply text."
      />
    </>
  );
}

// Settings → AI → AI usage → one kept call.
export function AiRequestLogEntry() {
  const { id = "" } = useParams();
  const [entry, setEntry] = useState<AiRequestLogEntryView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const zone = useHouseholdZone();

  useEffect(() => {
    setEntry(undefined);
    setError(undefined);
    readAiRequestLogEntry(id)
      .then(async (res) => {
        if (res.status === 404) return setError("This AI request text is no longer kept.");
        if (!res.ok) return setError("The AI request did not load.");
        setEntry(((await res.json()) as { entry: AiRequestLogEntryView }).entry);
      })
      .catch(() => setError("The server did not answer."));
  }, [id]);

  return (
    <>
      <LogHeading
        title="AI request"
        back={{ to: AI_REQUEST_LOG_PATH, label: "Back to the AI request log" }}
      />
      <ErrorLine error={error} />
      {entry === undefined || zone === undefined ? null : (
        <AiRequestLogEntryReport
          entry={entry}
          zone={zone}
          today={calendarDateIn(new Date(), zone)}
        />
      )}
    </>
  );
}
