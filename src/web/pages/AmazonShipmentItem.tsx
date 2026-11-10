import type { ReviewItemView } from "../../server/review-views.ts";
import { keepAmountsWhole } from "../components/Amounts.tsx";
import { buttonClass } from "../components/Button.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import type { ItemActions, ItemState } from "./ReviewList.tsx";
import { KIND_LABEL, transactionLine } from "./ReviewList.tsx";

// An Amazon shipment that fits two or more Transactions, on the Review list page (spec 14, Review
// list items): one card per shipment, with "This one" on each Transaction it fits, and "None of
// these". Picking one links the shipment by hand.

// The Review list kind, as the server names it.
export const AMAZON_SHIPMENT = "Amazon shipment";

// The value of "This one" on a Transaction, as the server's choices name it.
export const pickValue = (transactionId: string) => `link|${transactionId}`;

export function AmazonShipmentItem(props: {
  item: ReviewItemView;
  state: ItemState;
  today: string;
  actions: ItemActions;
}) {
  const { item, state, actions } = props;
  const busy = state.busy === true;
  return (
    <li
      className="rounded-card border border-line bg-white px-4 py-4 min-[900px]:px-5 min-[900px]:py-[18px]"
      data-kind={item.kind}
    >
      <p className="text-xs font-semibold uppercase tracking-[.05em] text-muted">
        {KIND_LABEL[item.kind]}
      </p>
      <p className="mt-1 font-semibold">{item.decided}</p>
      <p className="mt-0.5 text-small text-muted">Which charge paid for it?</p>
      <ul className="mt-2">
        {item.transactions.map((txn) => (
          <li
            key={txn.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft py-2 text-sm first:border-t-0"
          >
            <span className="min-w-0 flex-[1_1_240px] break-words">
              {keepAmountsWhole(transactionLine(txn, props.today))}
            </span>
            <button
              type="button"
              className={buttonClass("outlined", "small")}
              disabled={busy}
              onClick={() => actions.answer(item, pickValue(txn.id))}
            >
              This one
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass("outlined")}
          disabled={busy}
          onClick={() => actions.answer(item, item.bestAnswer.value)}
        >
          {item.bestAnswer.label}
        </button>
      </div>
      {state.error === undefined ? null : (
        <div className="mt-2">
          <ErrorLine error={state.error} />
        </div>
      )}
    </li>
  );
}
