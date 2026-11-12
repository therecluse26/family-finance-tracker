import { useState } from "react";
import { Link } from "react-router";
import type { ShoppingListChangeCardView } from "../../deal-finder/shopping-list-view.ts";
import { answerOf, undoShoppingListChange } from "../shopping-list.ts";
import { Button } from "./Button.tsx";
import { ErrorLine } from "./Fields.tsx";

// A Shopping list change Chat's AI made, as a card in its thread (spec 15, Chat tools): it applied
// at once, and any Member may press Undo until one does. Undo puts each List item it touched back
// as it was, unless a Member changed one since.

export const SHOPPING_LIST_PATH = "/shopping-list";

export function ShoppingListChangeCard(props: {
  change: ShoppingListChangeCardView;
  onChanged: () => void;
  className?: string;
}) {
  const { change } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function undo() {
    setBusy(true);
    setError(undefined);
    try {
      const answer = await answerOf(await undoShoppingListChange(change.id));
      if ("error" in answer) setError(answer.error);
      else props.onChanged();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  const undone = change.undoneAt !== null;
  return (
    <li
      className={`min-w-0 rounded-[10px] border border-line bg-white px-3.5 py-3 text-sm wrap-anywhere ${props.className ?? ""}`}
      data-slot="chat-shopping-list-change"
    >
      <p className="text-small font-semibold text-muted">
        {undone ? "Shopping list change: Undone" : "Shopping list changed"}
      </p>
      <ul className="mt-1">
        {change.lines.map((line, index) => (
          // A line may repeat, such as two adds of the same words.
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines never move.
          <li key={index} className={undone ? "text-muted line-through" : "text-ink-soft"}>
            {line}
          </li>
        ))}
      </ul>
      <ErrorLine error={error} />
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {undone ? null : (
          <Button type="button" variant="outlined" size="small" disabled={busy} onClick={undo}>
            Undo
          </Button>
        )}
        <Link to={SHOPPING_LIST_PATH} className="text-small text-accent underline">
          Open the Shopping list
        </Link>
      </div>
    </li>
  );
}
