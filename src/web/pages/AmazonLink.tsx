import { useEffect, useState } from "react";
import { dateLabel, dollarsAndCents } from "../../format.ts";
import type { AmazonShipmentView } from "../../server/amazon-links-views.ts";
import { api } from "../api.ts";
import { buttonClass } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { SectionHeading } from "../components/Page.tsx";
import { LineItemsList } from "./LineItemsList.tsx";

// A Transaction's Amazon links, on its detail view (spec 14, Hand links): its Line items with
// Undo, or, on a posted Spending Transaction with none, "Link Amazon items" with the unlinked
// shipments ordered around its purchase date. Each edit goes through `done`, which reads the
// Transaction again.

export type AmazonLinkEdit = { notice?: string; error?: string };

export const amazonLinkRequests = {
  shipments: (transactionId: string) =>
    api.transactions[":id"]["amazon-shipments"].$get({ param: { id: transactionId } }),
  link: (transactionId: string, shipment: { orderId: string; shipTime: string }) => {
    const edit = { param: { id: transactionId }, json: shipment };
    return api.transactions[":id"]["amazon-link"].$post(edit);
  },
  undo: (transactionId: string) =>
    api.transactions[":id"]["amazon-link"].$delete({ param: { id: transactionId } }),
};

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

async function send(run: () => Promise<Response>, notice: string): Promise<AmazonLinkEdit> {
  try {
    const res = await run();
    return res.ok ? { notice } : { error: await refusal(res) };
  } catch {
    return { error: "The server did not answer." };
  }
}

// "Order 111-2223334-4445556 · shipped Oct 9 · 3 items · $42.50".
export function shipmentLine(shipment: AmazonShipmentView, today: string): string {
  return [
    `Order ${shipment.orderId}`,
    `shipped ${dateLabel(shipment.shipDate, today)}`,
    shipment.items === 1 ? "1 item" : `${shipment.items} items`,
    dollarsAndCents(shipment.total),
  ].join(" · ");
}

// The unlinked shipments, each with "Link". Folded, as most Transactions are not Amazon's.
export function ShipmentsToLink(props: {
  shipments: readonly AmazonShipmentView[];
  today: string;
  busy: boolean;
  link(shipment: AmazonShipmentView): void;
}) {
  return (
    <Card aria-labelledby="link-amazon-items">
      <SectionHeading id="link-amazon-items">Link Amazon items</SectionHeading>
      <details className="mt-1">
        <summary className="cursor-pointer text-small text-muted">
          {props.shipments.length === 1
            ? "1 unlinked Amazon shipment was ordered around this date."
            : `${props.shipments.length} unlinked Amazon shipments were ordered around this date.`}
        </summary>
        <ul className="mt-2">
          {props.shipments.map((shipment) => (
            <li
              key={`${shipment.orderId}|${shipment.shipTime}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft py-3 text-sm first:border-t-0"
            >
              <span className="min-w-0 flex-[1_1_240px] break-words">
                <span className="block font-semibold tabular-nums">
                  {shipmentLine(shipment, props.today)}
                </span>
                <span className="block text-small text-muted">
                  {shipment.names.slice(0, 3).join(", ")}
                  {shipment.names.length > 3 ? `, and ${shipment.names.length - 3} more` : ""}
                  {shipment.giftCard ? " · paid in part by gift card" : ""}
                </span>
              </span>
              <button
                type="button"
                className={buttonClass("outlined", "small")}
                disabled={props.busy}
                onClick={() => props.link(shipment)}
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      </details>
    </Card>
  );
}

// Undo under the Line items: it unlinks them all.
export function UndoAmazonLink(props: { busy: boolean; undo(): void }) {
  return (
    <Card aria-labelledby="amazon-link">
      <SectionHeading id="amazon-link">Amazon link</SectionHeading>
      <p className="mt-1 text-small text-muted">
        Undo unlinks these items. The app will not link them to this Transaction again.
      </p>
      <button
        type="button"
        className={`${buttonClass("outlined", "small")} mt-3`}
        disabled={props.busy}
        onClick={props.undo}
      >
        Undo
      </button>
    </Card>
  );
}

export function AmazonLink(props: {
  transactionId: string;
  itemCount: number;
  // A posted Spending Transaction with every part Spending.
  linkable: boolean;
  today: string;
  done(edit: AmazonLinkEdit): void;
}) {
  const { transactionId, itemCount, linkable } = props;
  const [shipments, setShipments] = useState<AmazonShipmentView[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setShipments([]);
    if (itemCount > 0 || !linkable) return;
    let current = true;
    amazonLinkRequests
      .shipments(transactionId)
      .then(async (res) => {
        if (res.ok && current) setShipments((await res.json()).shipments);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [transactionId, itemCount, linkable]);

  const run = async (request: () => Promise<Response>, notice: string) => {
    setBusy(true);
    const edit = await send(request, notice);
    setBusy(false);
    props.done(edit);
  };

  if (itemCount > 0) {
    return (
      <>
        <LineItemsList transactionId={transactionId} itemCount={itemCount} today={props.today} />
        <UndoAmazonLink
          busy={busy}
          undo={() =>
            void run(
              () => amazonLinkRequests.undo(transactionId),
              "Undone. The app will not link those items to this Transaction again.",
            )
          }
        />
      </>
    );
  }
  if (shipments.length === 0) return null;
  return (
    <ShipmentsToLink
      shipments={shipments}
      today={props.today}
      busy={busy}
      link={(shipment) =>
        void run(
          () =>
            amazonLinkRequests.link(transactionId, {
              orderId: shipment.orderId,
              shipTime: shipment.shipTime,
            }),
          "Linked by hand.",
        )
      }
    />
  );
}
