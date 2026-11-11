import { useEffect, useState } from "react";
import type { PlanRunCost, PlanRunView } from "../../deal-finder/run-view.ts";
import { api } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { usePolling } from "../polling.ts";
import { PlanRunConfirm } from "./PlanRunConfirm.tsx";
import { PlanRunProgress } from "./PlanRunProgress.tsx";

// "Find the best prices" on the Shopping list page (spec 15, The Shopping plan): it starts a plan
// run, or joins the one that runs, asks a Member to confirm the cost before a full search, and
// shows each Store's progress while the job works.

// Each request the button sends. Both take and answer JSON.
const planRun = api["shopping-plan"].run;
export const loadPlanRun = () => planRun.$get();
export const startPlanRun = (confirmedCostNanos?: number) =>
  planRun.$post({ json: confirmedCostNanos === undefined ? {} : { confirmedCostNanos } });

// A plan run reads each Store in turn, so the page reads its progress every 2 seconds, for up to
// 10 minutes.
const POLL = { everyMs: 2_000, maxReads: 300 };

type StartAnswer = {
  error?: string;
  outcome?: "started" | "joined" | "confirm";
  run?: PlanRunView;
  cost?: PlanRunCost;
};

export function PlanRunButton(props: { onDone?: () => void }) {
  const [run, setRun] = useState<PlanRunView | null>(null);
  const [cost, setCost] = useState<PlanRunCost | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const read = async () => {
    const res = await loadPlanRun();
    if (!res.ok) return true;
    const next = (await res.json()).run;
    setRun(next);
    if (next !== null && !next.running) props.onDone?.();
    return next?.running ?? false;
  };

  const poll = usePolling(run?.running ?? false, read, POLL);

  useEffect(() => {
    loadPlanRun()
      .then(async (res) => (res.ok ? setRun((await res.json()).run) : undefined))
      .catch(() => setError("The server did not answer."));
  }, []);

  const start = async (confirmedCostNanos?: number) => {
    setError(undefined);
    setBusy(true);
    try {
      const res = await startPlanRun(confirmedCostNanos);
      const answer = (await res.json()) as StartAnswer;
      if (!res.ok) return setError(answer.error ?? "That did not work.");
      if (answer.outcome === "confirm") return setCost(answer.cost);
      setCost(undefined);
      if (answer.run !== undefined) setRun(answer.run);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PlanRunControls
        run={run}
        cost={cost}
        busy={busy}
        onStart={() => void start()}
        onConfirm={(nanos) => void start(nanos)}
        onCancel={() => setCost(undefined)}
      />
      <ErrorLine error={error} />
      {run === null ? null : <PlanRunProgress run={run} poll={poll} />}
    </div>
  );
}

// The button, or the cost to confirm in its place. While a run works, the button is off.
export function PlanRunControls(props: {
  run: PlanRunView | null;
  cost: PlanRunCost | undefined;
  busy: boolean;
  onStart: () => void;
  onConfirm: (costNanos: number) => void;
  onCancel: () => void;
}) {
  const { cost } = props;
  if (cost !== undefined) {
    return (
      <PlanRunConfirm
        cost={cost}
        busy={props.busy}
        onConfirm={() => props.onConfirm(cost.costNanos)}
        onCancel={props.onCancel}
      />
    );
  }
  const running = props.run?.running ?? false;
  return (
    <Button type="button" disabled={props.busy || running} onClick={props.onStart}>
      {running ? "Finding the best prices…" : "Find the best prices"}
    </Button>
  );
}
