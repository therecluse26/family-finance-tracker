import { useEffect, useState } from "react";

// What Spending over time and Cash flow share: loading a report's view, and the table cells.

// A report's view, loaded again whenever `key` changes, such as its range and filter. Until it
// loads, the view is undefined.
export function useReportView<View>(
  key: string,
  request: () => Promise<Response>,
): { view: View | undefined; error: string | undefined } {
  const [view, setView] = useState<View | undefined>();
  const [error, setError] = useState<string | undefined>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names everything `request` sends.
  useEffect(() => {
    let current = true;
    setView(undefined);
    void (async () => {
      try {
        const res = await request();
        if (!current) return;
        if (!res.ok) return setError("That did not work.");
        const found = (await res.json()) as View;
        if (!current) return;
        setView(found);
        setError(undefined);
      } catch {
        if (current) setError("The server did not answer.");
      }
    })();
    return () => {
      current = false;
    };
  }, [key]);
  return { view, error };
}

// A report table's head and cells.
export const TABLE = "w-full border-collapse text-sm";
const HEAD = "border-b border-line px-3 py-2 text-xs font-semibold text-muted";
export const TH = `${HEAD} text-left`;
export const TH_NUMBER = `${HEAD} text-right`;
export const TD = "border-b border-line-soft px-3 py-2";
export const TD_NUMBER = `${TD} text-right tabular-nums`;
export const CELL_LINK = "text-ink hover:text-accent hover:underline";
