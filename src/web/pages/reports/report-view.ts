import { useEffect, useState } from "react";

// What the reports share: loading a report's view, and a table cell's link.

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

// A report's filter: a short label that never wraps, and a select in the app's field look, as
// tall as the range pills.
export const FILTER_LABEL =
  "flex min-w-0 shrink items-center gap-2 text-small whitespace-nowrap text-muted";
export const FILTER_SELECT =
  "block h-9 w-auto max-w-[13rem] min-w-0 rounded-control border border-field bg-white px-2.5 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

// A table cell's link to its Transactions: ink, blue and underlined under the pointer.
export const CELL_LINK = "text-ink hover:text-accent hover:underline";
