import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AI_USE_LABELS, type AiUsageView } from "../../../ai/ai-view.ts";
import { callCost, capLine } from "../../../ai/usage-view.ts";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import { api } from "../../api.ts";
import { Card } from "../../components/Card.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import { todayHere } from "./Ai.tsx";
import { TEXT_LINK } from "./settings-ui.tsx";

// Settings → AI → AI usage (spec 08, AI usage page): each AI call this month, the month's total
// against the AI cost cap, and the month's total per use. It shows metadata only: the app keeps no
// prompt text or reply text.

const count = (tokens: number) => tokens.toLocaleString("en-US");

const HEAD = "border-b border-line px-3 py-2.5 text-left text-xs font-semibold text-muted";
const CELL = "border-b border-line-soft px-3 py-[11px] tabular-nums";
// A number column, at the right.
const NUMBER = `${CELL} text-right`;
const NUMBER_HEAD = `${HEAD} text-right`;

// The page once the usage has loaded. Times show in `zone`, the Household time zone.
export function AiUsageReport(props: { usage: AiUsageView; zone: string; today: string }) {
  const { usage, zone, today } = props;
  return (
    <>
      <Card>
        <p className="text-heading font-bold tabular-nums" role="status">
          {capLine(usage.totalNanos, usage.capCents)} this month
        </p>
        {usage.pausedUntil === null ? null : (
          <p className="mt-1.5">
            <StatusText tone="serious">
              AI paused until {dateLabel(usage.pausedUntil, today)}: AI cost cap reached
            </StatusText>
          </p>
        )}
        {usage.calls.length === 0 ? (
          <p className="mt-1.5 text-muted">No AI calls this month.</p>
        ) : null}
      </Card>
      {usage.calls.length === 0 ? null : (
        <>
          <Card aria-labelledby="ai-usage-by-use">
            <h3 id="ai-usage-by-use" className="text-heading font-bold">
              This month by use
            </h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={HEAD}>Use</th>
                    <th className={NUMBER_HEAD}>Calls</th>
                    <th className={NUMBER_HEAD}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byUse.map((row) => (
                    <tr key={row.use}>
                      <td className={CELL}>{AI_USE_LABELS[row.use]}</td>
                      <td className={NUMBER}>{count(row.calls)}</td>
                      <td className={NUMBER}>{callCost(row.costNanos)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card aria-labelledby="ai-usage-each-call">
            <h3 id="ai-usage-each-call" className="text-heading font-bold">
              Each call
            </h3>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={HEAD}>Time</th>
                    <th className={HEAD}>Use</th>
                    <th className={HEAD}>Model</th>
                    <th className={NUMBER_HEAD}>Input without cache</th>
                    <th className={NUMBER_HEAD}>Cache read</th>
                    <th className={NUMBER_HEAD}>Cache write</th>
                    <th className={NUMBER_HEAD}>Output</th>
                    <th className={NUMBER_HEAD}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.calls.map((call) => {
                    const at = new Date(call.at);
                    return (
                      <tr key={call.id}>
                        <td className={`${CELL} whitespace-nowrap`}>
                          {dateLabel(calendarDateIn(at, zone), today)}, {timeLabel(at, zone)}
                        </td>
                        <td className={CELL}>{AI_USE_LABELS[call.use]}</td>
                        <td className={CELL}>{call.model}</td>
                        <td className={NUMBER}>{count(call.noCacheTokens)}</td>
                        <td className={NUMBER}>{count(call.cacheReadTokens)}</td>
                        <td className={NUMBER}>{count(call.cacheWriteTokens)}</td>
                        <td className={NUMBER}>{count(call.outputTokens)}</td>
                        <td className={NUMBER}>{callCost(call.costNanos)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </>
  );
}

export function AiUsage() {
  const [usage, setUsage] = useState<AiUsageView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const zone = useHouseholdZone();

  useEffect(() => {
    api.ai.usage
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError("The AI usage did not load.");
        setUsage(((await res.json()) as { usage: AiUsageView }).usage);
      })
      .catch(() => setError("The server did not answer."));
  }, []);

  return (
    <>
      <div>
        <h2 className="text-heading font-bold">AI usage</h2>
        <p className="mt-1 text-sm">
          <Link className={TEXT_LINK} to="/settings/ai">
            Back to AI settings
          </Link>
        </p>
      </div>
      <ErrorLine error={error} />
      {usage === undefined || zone === undefined ? null : (
        <AiUsageReport usage={usage} zone={zone} today={todayHere(new Date(), zone)} />
      )}
    </>
  );
}
