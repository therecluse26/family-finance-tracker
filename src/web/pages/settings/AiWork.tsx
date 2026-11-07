import { useCallback, useEffect, useState } from "react";
import { calendarDateIn, dateLabel, type StatusTone, timeLabel } from "../../../format.ts";
import {
  AI_WORK_WAIT_LINES,
  type AiWorkKind,
  type AiWorkView,
  type AiWorkWait,
} from "../../../redo/work-view.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import { ADD_PANEL, BUTTONS, HINT, Lead, SettingCard } from "./settings-ui.tsx";

// Settings → AI: AI work on your Transactions (spec 08, AI work on your Transactions). "Finish AI
// work now" runs the redo of no-AI work at once, and "Run AI on all history", after its confirm
// step, runs the first AI run's work again on the last 18 months. The status line says whether the
// work runs, why it waits, or what the last run did, in Household time.

// How often the page reads the line again while a run goes on.
const RUNNING_POLL_MS = 3_000;

// The tone of each reason AI work waits: its icon and color beside the words.
const WAIT_TONE: Record<AiWorkWait, StatusTone> = {
  "no AI provider": "muted",
  "key rejected": "critical",
  "cost cap": "serious",
  "waits for history": "accent",
  "no price": "critical",
};

const items = (n: number) => `${n} ${n === 1 ? "item" : "items"}`;
const categories = (n: number) => `${n} ${n === 1 ? "Category" : "Categories"}`;

// "Nov 6 at 3:12 PM", in `zone`, the Household time zone.
function momentLabel(at: string, zone: string, now: Date): string {
  const moment = new Date(at);
  return `${dateLabel(calendarDateIn(moment, zone), calendarDateIn(now, zone))} at ${timeLabel(moment, zone)}`;
}

// The status line: a run going on first, then why AI work waits, then the last run.
export function aiWorkLine(
  work: AiWorkView,
  zone: string,
  now: Date,
): { tone: StatusTone; text: string } {
  if (work.running !== null) {
    return { tone: "accent", text: `AI work is running: ${work.running.step}` };
  }
  if (work.waits !== null)
    return { tone: WAIT_TONE[work.waits], text: AI_WORK_WAIT_LINES[work.waits] };
  const last = work.lastRun;
  if (last === null) return { tone: "muted", text: "No AI work has run yet" };
  const when = momentLabel(last.at, zone, now);
  const did = `${items(last.items)} decided, and the AI answered ${categories(last.aiCategories)}`;
  return last.outcome === "finished"
    ? { tone: "good", text: `Last run ${when}: ${did}` }
    : { tone: "serious", text: `Last run ${when} stopped: ${did}` };
}

export function AiWorkLine(props: { work: AiWorkView; zone: string; now: Date }) {
  const line = aiWorkLine(props.work, props.zone, props.now);
  return (
    <p className="mt-3 font-semibold" role="status" data-slot="ai-work">
      <StatusText tone={line.tone}>{line.text}</StatusText>
    </p>
  );
}

// The confirm step's words (spec 08): what the run does, and its cost against the cap.
export const ALL_HISTORY_CONFIRM =
  "The AI looks again at the Category of each Transaction in the last 18 months, even one the bank or the Merchant's history chose. Hand-set Categories and Category rules still win. It costs about $0.10, and the cost counts against the AI cost cap.";

// The confirm step "Run AI on all history" opens: the AI runs only on its second press.
export function AllHistoryConfirm(props: { busy: boolean; onRun(): void; onCancel(): void }) {
  return (
    <section
      id="run-ai-on-all-history"
      aria-labelledby="run-ai-on-all-history-title"
      className={ADD_PANEL}
    >
      <h4 id="run-ai-on-all-history-title" className="font-semibold">
        Run AI on all history?
      </h4>
      <p className="mt-1.5 text-small text-ink-soft">{ALL_HISTORY_CONFIRM}</p>
      <div className={BUTTONS}>
        <Button type="button" disabled={props.busy} onClick={props.onRun}>
          Run AI on all history
        </Button>
        <Button type="button" variant="outlined" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}

// Presses one of the two buttons: the status line after it, or the server's words for a refusal,
// such as "AI work is running. Wait for it to finish.".
export async function pressAiWork(
  kind: AiWorkKind,
): Promise<{ work: AiWorkView } | { error: string }> {
  const route = kind === "finish" ? api.ai.work.finish : api.ai.work["all-history"];
  const res = await route.$post({ json: {} });
  const body = (await res.json().catch(() => ({}))) as { work?: AiWorkView; error?: unknown };
  if (!res.ok || body.work === undefined) {
    return { error: typeof body.error === "string" ? body.error : "That did not work." };
  }
  return { work: body.work };
}

// The part under the AI provider card. `ai` and `usage` are the AI settings and the month's cost as
// the page last read them: a save, a test, Remove AI provider, or a new cost cap may change why AI
// work waits, so the line loads again.
export function AiWorkCard(props: { ai?: unknown; usage?: unknown }) {
  const [work, setWork] = useState<AiWorkView | undefined>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const zone = useHouseholdZone();

  const load = useCallback(() => {
    api.ai.work
      .$get()
      .then(async (res) => {
        if (res.ok) setWork(((await res.json()) as { work: AiWorkView }).work);
      })
      .catch(() => {});
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ai` and `usage` only say when to load again.
  useEffect(load, [load, props.ai, props.usage]);

  // While a run goes on, the line follows its steps.
  const running = work?.running != null;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(load, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  async function press(kind: AiWorkKind) {
    setBusy(true);
    setError(undefined);
    try {
      const answer = await pressAiWork(kind);
      if ("error" in answer) {
        setError(answer.error);
        load();
        return;
      }
      setWork(answer.work);
      setAsking(false);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingCard id="ai-work" title="AI work on your Transactions">
      <Lead>
        The AI looks at your history once it has loaded, and again for work the app did without AI.
        You can start that work here.
      </Lead>
      {work === undefined || zone === undefined ? null : (
        <>
          <AiWorkLine work={work} zone={zone} now={new Date()} />
          {work.waiting === 0 || running ? null : (
            <p className={HINT}>{items(work.waiting)} wait for the AI.</p>
          )}
        </>
      )}
      <div className={BUTTONS}>
        <Button type="button" disabled={busy || running} onClick={() => press("finish")}>
          Finish AI work now
        </Button>
        <Button
          type="button"
          variant="outlined"
          disabled={busy || running || asking}
          aria-expanded={asking}
          aria-controls="run-ai-on-all-history"
          onClick={() => {
            setError(undefined);
            setAsking(true);
          }}
        >
          Run AI on all history
        </Button>
      </div>
      <p className={HINT}>
        Finish AI work now sends the items the app decided without AI. A Category or answer you set
        by hand stays.
      </p>
      {asking ? (
        <AllHistoryConfirm
          busy={busy}
          onRun={() => press("all history")}
          onCancel={() => setAsking(false)}
        />
      ) : null}
      <ErrorLine error={error} />
    </SettingCard>
  );
}
