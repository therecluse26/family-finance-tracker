import type { PlanRunCost } from "../../deal-finder/run-view.ts";
import { dollarsAndCents } from "../../format.ts";
import { Button } from "../components/Button.tsx";

// The cost-confirm step of "Find the best prices" (spec 15, Search once, then re-read): before a
// plan run that holds a full search at a Store that charges, the page shows its expected cost, and
// the run starts only when a Member confirms it. It saves nothing by itself.

// Billionths of a dollar in a cent.
const NANOS_PER_CENT = 10_000_000;

// A cost in billionths of a dollar as dollars and cents, rounded up, so a cost under a cent shows
// as $0.01 and never as nothing.
export const costWords = (nanos: number) => dollarsAndCents(Math.ceil(nanos / NANOS_PER_CENT));

export function PlanRunConfirm(props: {
  cost: PlanRunCost;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { cost } = props;
  const left = Math.max(0, cost.capCents * NANOS_PER_CENT - cost.monthCostNanos);
  return (
    <section aria-label="Confirm the cost">
      <p>
        This plan run searches each Store for new List items. It should cost about{" "}
        <strong>{costWords(cost.costNanos)}</strong> in Price source fees.
      </p>
      <p className="mt-1 text-small text-muted">
        {costWords(cost.monthCostNanos)} spent this month, {costWords(left)} left under the{" "}
        {dollarsAndCents(cost.capCents)} cap.
      </p>
      <div className="mt-3 flex gap-2">
        <Button type="button" disabled={props.busy} onClick={props.onConfirm}>
          Find the best prices for {costWords(cost.costNanos)}
        </Button>
        <Button type="button" variant="outlined" disabled={props.busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
