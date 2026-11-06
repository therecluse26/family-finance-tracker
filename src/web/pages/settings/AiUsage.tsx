import { useEffect, useState } from "react";
import { Link } from "react-router";
import { AI_USE_LABELS, type AiUsageView } from "../../../ai/ai-view.ts";
import { callCost, capLine } from "../../../ai/usage-view.ts";
import { calendarDateIn, dateLabel, timeLabel } from "../../../format.ts";
import { api } from "../../api.ts";
import { ErrorLine } from "../../components/Fields.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import { todayHere } from "./Ai.tsx";

// Settings → AI → AI usage (spec 08, AI usage page): each AI call this month, the month's total
// against the AI cost cap, and the month's total per use. It shows metadata only: the app keeps no
// prompt text or reply text.

const count = (tokens: number) => tokens.toLocaleString("en-US");

const CELL = "border-b border-gray-200 px-2 py-1 text-left";

// The page once the usage has loaded. Times show in `zone`, the Household time zone.
export function AiUsageReport(props: { usage: AiUsageView; zone: string; today: string }) {
  const { usage, zone, today } = props;
  return (
    <>
      <p className="mt-2 font-semibold" role="status">
        {capLine(usage.totalNanos, usage.capCents)} this month
      </p>
      {usage.pausedUntil === null ? null : (
        <p className="mt-1">
          AI paused until {dateLabel(usage.pausedUntil, today)}: AI cost cap reached
        </p>
      )}
      {usage.calls.length === 0 ? (
        <p className="mt-4 text-gray-600">No AI calls this month.</p>
      ) : (
        <>
          <h3 className="mt-6 text-lg font-semibold">This month by use</h3>
          <div className="overflow-x-auto">
            <table className="mt-2">
              <thead>
                <tr>
                  <th className={CELL}>Use</th>
                  <th className={CELL}>Calls</th>
                  <th className={CELL}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.byUse.map((row) => (
                  <tr key={row.use}>
                    <td className={CELL}>{AI_USE_LABELS[row.use]}</td>
                    <td className={CELL}>{count(row.calls)}</td>
                    <td className={CELL}>{callCost(row.costNanos)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3 className="mt-6 text-lg font-semibold">Each call</h3>
          <div className="overflow-x-auto">
            <table className="mt-2">
              <thead>
                <tr>
                  <th className={CELL}>Time</th>
                  <th className={CELL}>Use</th>
                  <th className={CELL}>Model</th>
                  <th className={CELL}>Input without cache</th>
                  <th className={CELL}>Cache read</th>
                  <th className={CELL}>Cache write</th>
                  <th className={CELL}>Output</th>
                  <th className={CELL}>Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.calls.map((call) => {
                  const at = new Date(call.at);
                  return (
                    <tr key={call.id}>
                      <td className={CELL}>
                        {dateLabel(calendarDateIn(at, zone), today)}, {timeLabel(at, zone)}
                      </td>
                      <td className={CELL}>{AI_USE_LABELS[call.use]}</td>
                      <td className={CELL}>{call.model}</td>
                      <td className={CELL}>{count(call.noCacheTokens)}</td>
                      <td className={CELL}>{count(call.cacheReadTokens)}</td>
                      <td className={CELL}>{count(call.cacheWriteTokens)}</td>
                      <td className={CELL}>{count(call.outputTokens)}</td>
                      <td className={CELL}>{callCost(call.costNanos)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
      <h2 className="text-xl font-semibold">AI usage</h2>
      <p className="mt-1">
        <Link className="text-blue-700 underline" to="/settings/ai">
          Back to AI settings
        </Link>
      </p>
      <ErrorLine error={error} />
      {usage === undefined || zone === undefined ? null : (
        <AiUsageReport usage={usage} zone={zone} today={todayHere(new Date(), zone)} />
      )}
    </>
  );
}
