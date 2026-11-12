import { type ReactNode, useEffect, useState } from "react";
import type { PlanRunCost, PlanRunView } from "../../deal-finder/run-view.ts";
import { api } from "../api.ts";
import { Button } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { type PollState, usePolling } from "../polling.ts";
import { PlanRunConfirm } from "./PlanRunConfirm.tsx";
import { PlanRunProgress } from "./PlanRunProgress.tsx";

// "Find the best prices" on the Shopping list page (spec 15, The Shopping plan): it starts a plan
// run, or joins the one that runs, asks a Member to confirm the cost before a full search, and
// shows each Store's progress while the job works, in a panel under the page's heading.

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

// The plan run's state, shared by its two places on the Shopping list page: the button beside the
// heading, and the panel under the heading. The panel spans the page, so the heading keeps its
// height while a run works.
export function usePlanRun(onDone?: () => void): { button: ReactNode; panel: ReactNode } {
  const [run, setRun] = useState<PlanRunView | null>(null);
  const [cost, setCost] = useState<PlanRunCost | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const read = async () => {
    const res = await loadPlanRun();
    if (!res.ok) return true;
    const next = (await res.json()).run;
    setRun(next);
    if (next !== null && !next.running) onDone?.();
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

  return {
    button: (
      <PlanRunControls
        run={run}
        busy={busy}
        confirming={cost !== undefined}
        onStart={() => void start()}
      />
    ),
    panel: (
      <PlanRunPanel
        run={run}
        cost={cost}
        busy={busy}
        error={error}
        poll={poll}
        onConfirm={(nanos) => void start(nanos)}
        onCancel={() => setCost(undefined)}
      />
    ),
  };
}

// The button. It is off while a run works, and while its cost waits to be confirmed.
export function PlanRunControls(props: {
  run: PlanRunView | null;
  busy: boolean;
  confirming: boolean;
  onStart: () => void;
}) {
  const running = props.run?.running ?? false;
  return (
    <Button
      type="button"
      disabled={props.busy || running || props.confirming}
      onClick={props.onStart}
    >
      {running ? "Finding the best prices…" : "Find the best prices"}
    </Button>
  );
}

// The panel under the heading: the cost to confirm before a full search, the error of the last
// start, and each Store's progress. With none of them, it shows nothing.
export function PlanRunPanel(props: {
  run: PlanRunView | null;
  cost: PlanRunCost | undefined;
  busy: boolean;
  error: string | undefined;
  poll: PollState;
  onConfirm: (costNanos: number) => void;
  onCancel: () => void;
}) {
  const { cost, run } = props;
  if (cost === undefined && props.error === undefined && run === null) return null;
  return (
    <Card as="div" className="flex flex-col gap-3">
      {cost === undefined ? null : (
        <PlanRunConfirm
          cost={cost}
          busy={props.busy}
          onConfirm={() => props.onConfirm(cost.costNanos)}
          onCancel={props.onCancel}
        />
      )}
      <ErrorLine error={props.error} />
      {run === null ? null : <PlanRunProgress run={run} poll={props.poll} />}
    </Card>
  );
}
