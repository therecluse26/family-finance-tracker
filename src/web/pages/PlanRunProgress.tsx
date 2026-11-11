import type { PlanRunPhase, PlanRunStoreState, PlanRunView } from "../../deal-finder/run-view.ts";
import type { StatusTone } from "../../format.ts";
import { StatusText } from "../components/Status.tsx";
import type { PollState } from "../polling.ts";

// Each Store's progress while a plan run works (spec 15, The Shopping plan), and how the run
// ended.

const STATE_WORDS: Record<PlanRunStoreState, { tone: StatusTone; word: string }> = {
  waiting: { tone: "muted", word: "Waiting" },
  reading: { tone: "accent", word: "Reading prices" },
  read: { tone: "good", word: "Prices read" },
  "stored prices": { tone: "good", word: "Prices read in the last 24 hours" },
  skipped: { tone: "muted", word: "Skipped" },
  failed: { tone: "serious", word: "Failed" },
};

const PHASE_WORDS: Record<PlanRunPhase, string> = {
  reading: "Reading Store prices.",
  matching: "Matching List items to Products.",
  building: "Building the Shopping plan.",
  done: "The plan run is done.",
  failed: "The plan run failed. Press Find the best prices to try again.",
};

export function PlanRunProgress(props: { run: PlanRunView; poll: PollState }) {
  const { run } = props;
  return (
    <section className="mt-3" aria-label="Plan run progress">
      <p className={run.phase === "failed" ? "text-critical" : undefined} aria-live="polite">
        {PHASE_WORDS[run.phase]}
      </p>
      {run.running && props.poll === "gave up" ? (
        <p className="text-small text-muted">Still working. Reload the page to see its progress.</p>
      ) : null}
      <ul className="mt-2 flex flex-col gap-1">
        {run.stores.map((store) => {
          const words = STATE_WORDS[store.state];
          return (
            <li key={store.storeId} className="flex flex-wrap gap-x-2">
              <span>{store.name}</span>
              <StatusText tone={words.tone}>{words.word}</StatusText>
              {store.reason === null ? null : (
                <span className="text-small text-muted">{store.reason}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
