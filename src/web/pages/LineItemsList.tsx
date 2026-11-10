import { useEffect, useState } from "react";
import { dateLabel, dollarsAndCents } from "../../format.ts";
import type { LineItemView } from "../../server/amazon-views.ts";
import { api } from "../api.ts";
import { Card } from "../components/Card.tsx";
import { SectionHeading } from "../components/Page.tsx";

// The Line items linked to a Transaction, on its detail view (spec 14, Pages): each item's name,
// quantity, total, and Category, under its order's ID, date, and link kind. Read only for now:
// Change, "only this item", and Undo come with the tickets that link and categorize Line items.

// "1 item", "3 items": the count a Transactions row shows.
export const itemsLabel = (count: number) => (count === 1 ? "1 item" : `${count} items`);

const LINK_KIND: Record<NonNullable<LineItemView["linkKind"]>, string> = {
  app: "Linked by the app",
  hand: "Linked by hand",
};

export const readLineItems = (transactionId: string) =>
  api.transactions[":id"]["line-items"].$get({ param: { id: transactionId } });

const orderKey = (item: LineItemView) => `${item.orderId}|${item.linkKind ?? ""}`;

// The Line items by order, in the order they came.
function byOrder(items: readonly LineItemView[]): LineItemView[][] {
  const orders = new Map<string, LineItemView[]>();
  for (const item of items) {
    const order = orders.get(orderKey(item));
    if (order === undefined) orders.set(orderKey(item), [item]);
    else order.push(item);
  }
  return [...orders.values()];
}

export function LineItemsCard(props: { items: readonly LineItemView[]; today: string }) {
  return (
    <Card aria-labelledby="line-items">
      <SectionHeading id="line-items">Items · {itemsLabel(props.items.length)}</SectionHeading>
      {byOrder(props.items).map((order) => {
        const first = order[0];
        if (first === undefined) return null;
        return (
          <div key={orderKey(first)} className="mt-3">
            <p className="text-small text-muted">
              Amazon order {first.orderId} · {dateLabel(first.orderDate, props.today)}
              {first.linkKind === null ? "" : ` · ${LINK_KIND[first.linkKind]}`}
            </p>
            <ul className="mt-1">
              {order.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-wrap items-baseline gap-x-3 border-t border-line-soft py-2 text-sm first:border-t-0"
                >
                  <span className="min-w-0 flex-[1_1_220px] break-words">
                    {item.quantity === 1 ? "" : `${item.quantity} × `}
                    {item.name}
                    <span className="block text-small text-muted">
                      {item.category ?? "No Category yet"}
                    </span>
                  </span>
                  <span className="whitespace-nowrap tabular-nums">
                    {dollarsAndCents(item.total)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </Card>
  );
}

// Reads the Line items only when the Transaction has some.
export function LineItemsList(props: { transactionId: string; itemCount: number; today: string }) {
  const [items, setItems] = useState<LineItemView[] | undefined>();
  const { transactionId, itemCount } = props;

  useEffect(() => {
    setItems(undefined);
    if (itemCount === 0) return;
    let current = true;
    readLineItems(transactionId)
      .then(async (res) => {
        if (res.ok && current) setItems((await res.json()).lineItems);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [transactionId, itemCount]);

  if (items === undefined || items.length === 0) return null;
  return <LineItemsCard items={items} today={props.today} />;
}
