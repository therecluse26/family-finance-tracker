import { useCallback, useEffect, useState } from "react";
import { dateLabel, dollarsAndCents } from "../../format.ts";
import type {
  ShoppingPlanDealView,
  ShoppingPlanLineView,
  ShoppingPlanUncheckedView,
  ShoppingPlanView,
} from "../../server/shopping-plan-views.ts";
import { api } from "../api.ts";
import { buttonClass } from "../components/Button.tsx";
import { Card } from "../components/Card.tsx";
import { ErrorLine } from "../components/Fields.tsx";
import { SectionHeading } from "../components/Page.tsx";

// The Shopping plan on the Shopping list page (spec 15, What the plan shows): one section per
// Store, the total and the trips, the saving against the best one-Store plan, each Deal with
// "Use this Deal", the Deals at other Stores, each price's date, and the Stores that could not be
// read. The Shopping list page shows it under the List items.

export const PLAN_NOTE = "Prices can change. Sales tax is not included.";

export const shoppingPlanRequests = {
  load: () => api["shopping-plan"].$get(),
  takeDeal: (deal: { planId: string; place: number; productId: string }) =>
    api["shopping-plan"].deals.$post({ json: deal }),
  dropDeal: (line: { planId: string; place: number }) =>
    api["shopping-plan"].deals.stop.$post({ json: line }),
  chooseMatch: (choice: {
    listItemId: string;
    productId: string;
    choice: "confirmed" | "rejected";
  }) => api["shopping-plan"].matches.$post({ json: choice }),
};

const trips = (count: number) => (count === 1 ? "1 trip" : `${count} trips`);
const packages = (count: number) => (count === 1 ? "1 package" : `${count} packages`);

// "Deal: $3.59 at Target until Nov 14, saves $0.90".
export function dealLine(deal: ShoppingPlanDealView, today: string): string {
  const until = deal.endsOn === null ? "" : ` until ${dateLabel(deal.endsOn, today)}`;
  return `Deal: ${dollarsAndCents(deal.price)} at ${deal.storeName}${until}, saves ${dollarsAndCents(deal.saves)}`;
}

// "2 packages × $5.49 = $10.98 · Price from Nov 10".
export function priceLine(line: ShoppingPlanLineView, today: string): string {
  const kind =
    line.priceKind === "online"
      ? " · Online price"
      : line.priceKind === "deal"
        ? line.dealEndsOn === null
          ? " · Deal"
          : ` · Deal until ${dateLabel(line.dealEndsOn, today)}`
        : "";
  return `${packages(line.packages)} × ${dollarsAndCents(line.price)} = ${dollarsAndCents(line.total)} · Price from ${dateLabel(line.readOn, today)}${kind}`;
}

type Actions = {
  busy: boolean;
  takeDeal(place: number, productId: string): void;
  dropDeal(place: number): void;
  chooseMatch(listItemId: string, productId: string, choice: "confirmed" | "rejected"): void;
};

// "Jif Creamy Peanut Butter · 16 oz · $3.49 at Walmart".
function foundLine(product: ShoppingPlanUncheckedView["products"][number]): string {
  const name = product.brand === null ? product.name : `${product.brand} ${product.name}`;
  const size = product.size === null ? "" : ` · ${product.size}`;
  const price = product.price === null ? "" : ` · ${dollarsAndCents(product.price)}`;
  return `${name}${size}${price} at ${product.storeName}`;
}

// The found Products no one has answered: without AI, a Member picks each List item's Products by
// hand (spec 15, Works without AI). The next plan uses each one confirmed.
function UncheckedSection(props: { unchecked: ShoppingPlanUncheckedView[] } & Actions) {
  return (
    <section className="mt-4" aria-label="Pick the Products">
      <h3 className="font-semibold">Pick the Products</h3>
      <p className="text-small text-muted">
        Confirm each Product that is right for the List item. The next plan uses it.
      </p>
      {props.unchecked.map((item) => (
        <div key={item.listItemId} className="mt-2">
          <p className="text-sm font-semibold">{item.words}</p>
          <ul>
            {item.products.map((product) => (
              <li
                key={product.productId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-small"
              >
                <span className="break-words tabular-nums">{foundLine(product)}</span>
                <DealButton
                  busy={props.busy}
                  onClick={() => props.chooseMatch(item.listItemId, product.productId, "confirmed")}
                >
                  Confirm
                </DealButton>
                <DealButton
                  busy={props.busy}
                  onClick={() => props.chooseMatch(item.listItemId, product.productId, "rejected")}
                >
                  Reject
                </DealButton>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function DealButton(props: { onClick(): void; busy: boolean; children: string }) {
  return (
    <button
      type="button"
      className={buttonClass("outlined", "small")}
      disabled={props.busy}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

function PlanLine(props: { line: ShoppingPlanLineView; today: string } & Actions) {
  const { line, today } = props;
  return (
    <li className="border-t border-line-soft py-3 text-sm first:border-t-0">
      <span className="block font-semibold">{line.words}</span>
      <span className="block break-words">{line.productName}</span>
      <span className="block text-small text-muted tabular-nums">{priceLine(line, today)}</span>
      {line.priceKind === "deal" ? (
        <span className="mt-2 block">
          <DealButton busy={props.busy} onClick={() => props.dropDeal(line.place)}>
            Use the regular price
          </DealButton>
        </span>
      ) : null}
      {line.deals.map((deal) => (
        <span
          key={`${deal.storeId}|${deal.productId}`}
          className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <span className="tabular-nums">{dealLine(deal, today)}</span>
          <DealButton busy={props.busy} onClick={() => props.takeDeal(line.place, deal.productId)}>
            Use this Deal
          </DealButton>
        </span>
      ))}
    </li>
  );
}

// The plan itself, with no request of its own.
export function ShoppingPlanSections(props: { plan: ShoppingPlanView } & Actions) {
  const { plan } = props;
  return (
    <Card aria-labelledby="shopping-plan">
      <SectionHeading id="shopping-plan">Shopping plan</SectionHeading>
      <p className="mt-1 text-small text-muted">
        Built {dateLabel(plan.builtOn, plan.today)}. {PLAN_NOTE}
      </p>
      {plan.dietaryDisclaimer === null ? null : (
        <p className="mt-1 text-small font-semibold">{plan.dietaryDisclaimer}</p>
      )}
      <p className="mt-3 font-semibold tabular-nums">
        Total {dollarsAndCents(plan.total)} · {trips(plan.trips)}
      </p>
      {plan.saving !== null && plan.saving > 0 ? (
        <p className="text-small tabular-nums">
          Saves {dollarsAndCents(plan.saving)} against the best one-Store plan.
        </p>
      ) : null}
      {plan.stores.map((store) => (
        <section key={store.storeId} className="mt-4" aria-label={store.name}>
          <h3 className="font-semibold">
            {store.name}
            {store.kind === "online" ? " (online)" : ""}
          </h3>
          <ul>
            {store.lines.map((line) => (
              <PlanLine key={line.place} line={line} today={plan.today} {...props} />
            ))}
          </ul>
          <p className="text-small tabular-nums">
            Subtotal {dollarsAndCents(store.subtotal)}
            {store.deliveryFee > 0 ? ` · Delivery fee ${dollarsAndCents(store.deliveryFee)}` : ""}
          </p>
        </section>
      ))}
      {plan.notFound.length > 0 ? (
        <section className="mt-4" aria-label="Not found">
          <h3 className="font-semibold">Not found</h3>
          <ul className="text-sm">
            {plan.notFound.map((line) => (
              <li key={line.place}>{line.words}</li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.unchecked.length > 0 ? (
        <UncheckedSection unchecked={plan.unchecked} {...props} />
      ) : null}
      {plan.elsewhere.length > 0 ? (
        <section className="mt-4" aria-label="Deals at other Stores">
          <h3 className="font-semibold">Deals at other Stores</h3>
          {plan.elsewhere.map((store) => (
            <div key={store.storeId} className="mt-2">
              <p className="text-sm tabular-nums">
                {store.name}: saves {dollarsAndCents(store.saving)}
                {store.paysForTrip
                  ? ""
                  : `. An extra trip must save more than ${dollarsAndCents(plan.tripSaving)}.`}
              </p>
              <ul>
                {store.deals.map((deal) => (
                  <li
                    key={`${deal.place}|${deal.productId}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-small"
                  >
                    <span className="tabular-nums">
                      {deal.words}: {deal.productName}. {dealLine(deal, plan.today)}
                    </span>
                    {store.paysForTrip ? (
                      <DealButton
                        busy={props.busy}
                        onClick={() => props.takeDeal(deal.place, deal.productId)}
                      >
                        Use this Deal
                      </DealButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ) : null}
      {plan.failures.length > 0 ? (
        <section className="mt-4" aria-label="Stores not read">
          <h3 className="font-semibold">Stores not read</h3>
          <ul className="text-small">
            {plan.failures.map((failure) => (
              <li key={failure.storeId}>
                {failure.name}: {failure.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// The last plan, read when the page opens and again when `version` changes, such as after a plan
// run. Shows nothing before the first plan.
export function ShoppingPlan(props: { version?: number }) {
  const [plan, setPlan] = useState<ShoppingPlanView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const send = useCallback(async (request: () => Promise<Response>) => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await request();
      if (!res.ok) {
        setError(await refusal(res));
        return;
      }
      setPlan(((await res.json()) as { plan: ShoppingPlanView | null }).plan);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a new read.
  useEffect(() => {
    void send(shoppingPlanRequests.load);
  }, [send, props.version]);

  if (plan === null) return <ErrorLine error={error} />;
  return (
    <>
      <ErrorLine error={error} />
      <ShoppingPlanSections
        plan={plan}
        busy={busy}
        takeDeal={(place, productId) =>
          void send(() => shoppingPlanRequests.takeDeal({ planId: plan.planId, place, productId }))
        }
        dropDeal={(place) =>
          void send(() => shoppingPlanRequests.dropDeal({ planId: plan.planId, place }))
        }
        chooseMatch={(listItemId, productId, choice) =>
          void send(() => shoppingPlanRequests.chooseMatch({ listItemId, productId, choice }))
        }
      />
    </>
  );
}
