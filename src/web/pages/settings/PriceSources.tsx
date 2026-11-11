import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  FIND_STORES_MILES,
  type FindStoresMiles,
  MAX_PRICE_SOURCE_COST_CAP_CENTS,
  type PriceSourceCheck,
  type PriceSourceStoreView,
  type PriceSourcesView,
  type StoreChanges,
} from "../../../deal-finder/view.ts";
import { calendarDateIn, dateLabel, dollarsAndCents } from "../../../format.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { StatusText } from "../../components/Status.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import { centsOfText } from "./Ai.tsx";
import {
  ADD_PANEL,
  BUTTONS,
  CHOICE,
  DoneLine,
  Field,
  HINT,
  INPUT,
  LABEL,
  Lead,
  ROW,
  SettingCard,
  SUBHEADING,
  TabHeading,
} from "./settings-ui.tsx";

// Settings → Price sources (spec 15, The Price sources page in Settings): the Scraping service, the
// Kroger API, Open Food Facts, the ZIP code switch, the Stores with Find Stores near us, and
// "Delete all deal finder data". A saved key shows only its last 4 characters.

// Each request the page sends. Every one takes and answers JSON.
const priceSources = api["price-sources"];
export const loadPriceSources = () => priceSources.$get();
export const saveApifyToken = (token: string) => priceSources.apify.$put({ json: { token } });
export const saveKrogerKeys = (clientId: string, clientSecret: string) =>
  priceSources.kroger.$put({ json: { clientId, clientSecret } });
// A route with a path parameter and a JSON body takes the body through a variable: the client's
// type names only the parameter.
export const testPriceSource = (source: "apify" | "kroger") => {
  const request = { param: { source }, json: {} };
  return priceSources[":source"].test.$post(request);
};
export const setOpenFoodFacts = (on: boolean) =>
  priceSources["open-food-facts"].$put({ json: { on } });
export const setUseZip = (on: boolean) => priceSources.zip.$put({ json: { on } });
export const findStores = (distanceMiles: FindStoresMiles) =>
  priceSources["find-stores"].$post({ json: { distanceMiles } });
export const changeStore = (id: string, changes: StoreChanges) => {
  const request = { param: { id }, json: changes };
  return priceSources.stores[":id"].$put(request);
};
export const setPriceSourceCostCap = (capCents: number) =>
  priceSources["cost-cap"].$put({ json: { capCents } });
export const deleteDealFinderData = () => priceSources["delete-all"].$post({ json: {} });

// One request from a card: the page sends it, shows its error or its done line, and takes the new
// view from its answer.
export type Act = (request: () => Promise<Response>, done?: string) => Promise<boolean>;

const DELETE_QUESTION =
  "Delete every Product, price, match and Shopping plan? The Shopping list, the Stores and the keys stay.";

// Billionths of a dollar in a cent.
const NANOS_PER_CENT = 10_000_000;

const CHECK_WORDS: Record<"apify" | "kroger", Record<PriceSourceCheck, string>> = {
  apify: {
    passed: "Apify accepted the token",
    refused: "Apify refused the token",
    "usage limit": "Apify usage limit reached",
    "no answer": "Apify did not answer",
  },
  kroger: {
    passed: "Kroger accepted the keys",
    refused: "Kroger refused the keys",
    "usage limit": "Kroger's usage limit reached",
    "no answer": "Kroger did not answer",
  },
};

function dayOf(at: string, zone: string, now: Date): string {
  return dateLabel(calendarDateIn(new Date(at), zone), calendarDateIn(now, zone));
}

function CheckLine(props: {
  source: "apify" | "kroger";
  check: PriceSourceCheck | null;
  checkedAt: string | null;
  zone: string;
  now: Date;
}) {
  if (props.check === null || props.checkedAt === null) {
    return <p className={HINT}>Not tested yet.</p>;
  }
  return (
    <p className="mt-1.5 text-small">
      <StatusText tone={props.check === "passed" ? "good" : "serious"}>
        {CHECK_WORDS[props.source][props.check]}
      </StatusText>{" "}
      <span className="text-muted">on {dayOf(props.checkedAt, props.zone, props.now)}.</span>
    </p>
  );
}

const savedKey = (last4: string | null) =>
  last4 === null ? "None saved." : `Saved, ending in ${last4}.`;

export function ScrapingServiceCard(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  zone: string;
  now: Date;
}) {
  const { view } = props;
  const [token, setToken] = useState("");
  const [cap, setCap] = useState(String(view.costCap / 100));
  const [capError, setCapError] = useState<string | undefined>();

  async function saveToken(event: FormEvent) {
    event.preventDefault();
    if (await props.act(() => saveApifyToken(token.trim()), "The Apify token is saved.")) {
      setToken("");
    }
  }

  async function saveCap(event: FormEvent) {
    event.preventDefault();
    const cents = centsOfText(cap);
    if (cents === undefined || cents > MAX_PRICE_SOURCE_COST_CAP_CENTS) {
      return setCapError("Enter the Price source cost cap in dollars, from $0 to $10,000.");
    }
    setCapError(undefined);
    await props.act(() => setPriceSourceCostCap(cents), "The Price source cost cap is saved.");
  }

  const spent = Math.round(view.monthCostNanos / NANOS_PER_CENT);
  return (
    <SettingCard id="scraping-service" title="Scraping service: Apify">
      <Lead>
        Apify reads Products, prices and weekly ads for every Store without a free API. Its Free
        plan gives $5 of usage each month.
      </Lead>
      <form onSubmit={saveToken}>
        <Field
          label="API token"
          type="password"
          value={token}
          onChange={setToken}
          required
          autoComplete="off"
        />
        <p className={HINT}>{savedKey(view.apify.tokenLast4)}</p>
        <div className={BUTTONS}>
          <Button type="submit" disabled={props.busy}>
            Save token
          </Button>
          {view.apify.tokenLast4 === null ? null : (
            <Button
              type="button"
              variant="outlined"
              disabled={props.busy}
              onClick={() => void props.act(() => testPriceSource("apify"))}
            >
              Test
            </Button>
          )}
        </div>
      </form>
      {view.apify.tokenLast4 === null ? null : (
        <CheckLine
          source="apify"
          check={view.apify.check}
          checkedAt={view.apify.checkedAt}
          zone={props.zone}
          now={props.now}
        />
      )}
      <h4 className={SUBHEADING}>Cost</h4>
      <p className="mt-1.5 tabular-nums">
        This month: {dollarsAndCents(spent)} of {dollarsAndCents(view.costCap)}
      </p>
      <form onSubmit={saveCap}>
        <Field
          label="Price source cost cap, in dollars a month"
          value={cap}
          onChange={setCap}
          required
          className="max-w-36 tabular-nums"
        />
        <p className={HINT}>At the cap, plan runs use stored prices only, until the 1st.</p>
        <div className={BUTTONS}>
          <Button type="submit" disabled={props.busy}>
            Save cap
          </Button>
        </div>
        <ErrorLine error={capError} />
      </form>
    </SettingCard>
  );
}

export function KrogerCard(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  zone: string;
  now: Date;
}) {
  const { kroger } = props.view;
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    const saved = await props.act(
      () => saveKrogerKeys(clientId.trim(), clientSecret.trim()),
      "The Kroger keys are saved.",
    );
    if (saved) {
      setClientId("");
      setClientSecret("");
    }
  }

  return (
    <SettingCard id="kroger" title="Kroger">
      <Lead>
        Kroger's free public API reads Kroger and its brands. Its Home store is on the Stores card.
      </Lead>
      <form onSubmit={save}>
        <Field label="Client ID" type="password" value={clientId} onChange={setClientId} required />
        <p className={HINT}>{savedKey(kroger.clientIdLast4)}</p>
        <Field
          label="Client secret"
          type="password"
          value={clientSecret}
          onChange={setClientSecret}
          required
        />
        <p className={HINT}>{savedKey(kroger.clientSecretLast4)}</p>
        <div className={BUTTONS}>
          <Button type="submit" disabled={props.busy}>
            Save keys
          </Button>
          {kroger.clientSecretLast4 === null ? null : (
            <Button
              type="button"
              variant="outlined"
              disabled={props.busy}
              onClick={() => void props.act(() => testPriceSource("kroger"))}
            >
              Test
            </Button>
          )}
        </div>
      </form>
      {kroger.clientSecretLast4 === null ? null : (
        <CheckLine
          source="kroger"
          check={kroger.check}
          checkedAt={kroger.checkedAt}
          zone={props.zone}
          now={props.now}
        />
      )}
    </SettingCard>
  );
}

export function OpenFoodFactsCard(props: { view: PriceSourcesView; busy: boolean; act: Act }) {
  return (
    <SettingCard id="open-food-facts" title="Open Food Facts">
      <Lead>
        Ingredients and allergens by barcode, for the dietary check. It needs no key, and gets only
        a Product's barcode.
      </Lead>
      <label className={CHOICE}>
        <input
          type="checkbox"
          checked={props.view.openFoodFacts}
          disabled={props.busy}
          onChange={(e) => void props.act(() => setOpenFoodFacts(e.target.checked))}
        />
        Use Open Food Facts
      </label>
    </SettingCard>
  );
}

export function ZipCard(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  // After the switch turns on, Find Stores near us runs.
  onTurnedOn: () => void;
}) {
  const { zip } = props.view;
  return (
    <SettingCard id="zip-code" title="ZIP code">
      <label className={CHOICE}>
        <input
          type="checkbox"
          checked={zip.on}
          disabled={props.busy || zip.zipCode === null}
          onChange={async (e) => {
            const on = e.target.checked;
            if ((await props.act(() => setUseZip(on))) && on) props.onTurnedOn();
          }}
        />
        Use our ZIP code to find stores
      </label>
      <p className={HINT}>
        {zip.zipCode === null
          ? "Add the Household's ZIP code in Settings → Household first."
          : `Your ZIP code: ${zip.zipCode}. Off, the deal finder reads only Stores that give a price with no location.`}
      </p>
    </SettingCard>
  );
}

function StoreRow(props: {
  store: PriceSourceStoreView;
  busy: boolean;
  act: Act;
  now: Date;
  zone: string;
}) {
  const { store } = props;
  const [fee, setFee] = useState(store.deliveryFee === null ? "" : String(store.deliveryFee / 100));
  const [free, setFree] = useState(
    store.freeDeliveryFrom === null ? "" : String(store.freeDeliveryFrom / 100),
  );
  const [error, setError] = useState<string | undefined>();
  const amountOf = (text: string) => (text.trim() === "" ? null : centsOfText(text));

  async function saveDelivery(event: FormEvent) {
    event.preventDefault();
    const deliveryFee = amountOf(fee);
    const freeDeliveryFrom = amountOf(free);
    if (deliveryFee === undefined || freeDeliveryFrom === undefined) {
      return setError("Enter each amount in dollars, or leave it empty for none.");
    }
    setError(undefined);
    await props.act(
      () => changeStore(store.id, { deliveryFee, freeDeliveryFrom }),
      `${store.name}'s delivery amounts are saved.`,
    );
  }

  return (
    <li className={`${ROW} block`}>
      <label className={`${CHOICE} mt-0 font-semibold`}>
        <input
          type="checkbox"
          checked={store.on}
          disabled={props.busy}
          onChange={(e) => void props.act(() => changeStore(store.id, { on: e.target.checked }))}
        />
        {store.name}
      </label>
      <p className="mt-1 text-small text-muted">
        {store.kind === "online"
          ? "Online"
          : store.kind === "weekly ad only"
            ? "Weekly ad only"
            : store.homeStore === null
              ? "The reader picks the store from the ZIP code"
              : `Home store: ${store.homeStore.name}${store.distanceMiles === null ? "" : `, ${store.distanceMiles} miles`}`}
        {" · "}
        {store.reader === "Store API" ? "Kroger API" : "Scraping service"}
        {" · "}
        {store.lastGoodReadAt === null
          ? "Not read yet"
          : `Last good read ${dayOf(store.lastGoodReadAt, props.zone, props.now)}`}
      </p>
      {store.needsZip ? (
        <p className="mt-1 text-small">
          <StatusText tone="serious">Needs your ZIP code</StatusText>
        </p>
      ) : null}
      {store.locations.length > 1 ? (
        <label className={LABEL}>
          Change Home store
          <select
            className={INPUT}
            value={store.homeStore?.id ?? ""}
            disabled={props.busy}
            onChange={(e) =>
              void props.act(() => changeStore(store.id, { homeStoreId: e.target.value }))
            }
          >
            {store.locations.map((place) => (
              <option key={place.id} value={place.id}>
                {place.name}, {place.distanceMiles} miles
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <form onSubmit={saveDelivery} className="flex flex-wrap items-end gap-3">
        <Field label="Delivery fee" value={fee} onChange={setFee} className="max-w-28" />
        <Field label="Free delivery from" value={free} onChange={setFree} className="max-w-28" />
        <Button type="submit" variant="outlined" size="small" disabled={props.busy}>
          Save
        </Button>
      </form>
      <p className={HINT}>Empty means no fee.</p>
      <ErrorLine error={error} />
    </li>
  );
}

export function StoresCard(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  zone: string;
  now: Date;
  miles: FindStoresMiles;
  onMiles: (miles: FindStoresMiles) => void;
  onFind: () => void;
}) {
  const { view } = props;
  return (
    <SettingCard id="stores" title="Stores">
      <Lead>
        Find Stores near us looks up every supported Store near your ZIP code, once. Tick the Stores
        to read: a Store that is not ticked is never read, and costs nothing.
      </Lead>
      {view.zip.changed && view.zip.on ? (
        <p className="mt-2">
          <StatusText tone="serious">Your ZIP code changed. Find Stores near us again.</StatusText>
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-3">
        <label className={LABEL}>
          Distance
          <select
            className={`${INPUT} max-w-40`}
            value={props.miles}
            onChange={(e) =>
              props.onMiles(
                FIND_STORES_MILES.find((miles) => String(miles) === e.target.value) ?? 25,
              )
            }
          >
            {FIND_STORES_MILES.map((miles) => (
              <option key={miles} value={miles}>
                {miles} miles
              </option>
            ))}
          </select>
        </label>
        <Button type="button" disabled={props.busy || !view.zip.on} onClick={props.onFind}>
          Find Stores near us
        </Button>
      </div>
      {view.zip.on ? null : (
        <p className={HINT}>Turn on "Use our ZIP code to find stores" to find Stores near you.</p>
      )}
      {view.stores.length === 0 ? (
        <p className="mt-3">No Stores found yet.</p>
      ) : (
        <ul className="mt-3">
          {view.stores.map((store) => (
            <StoreRow
              key={store.id}
              store={store}
              busy={props.busy}
              act={props.act}
              now={props.now}
              zone={props.zone}
            />
          ))}
        </ul>
      )}
    </SettingCard>
  );
}

export function DeleteDealFinderCard(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  confirming?: boolean;
}) {
  const [confirming, setConfirming] = useState(props.confirming ?? false);
  const { data } = props.view;
  return (
    <SettingCard id="delete-deal-finder" title="Delete all deal finder data">
      <Lead>
        Removes every Product, price, match and Shopping plan: {data.products} Products,{" "}
        {data.priceReads} price reads, {data.matches} matches and {data.plans} plans. It keeps the
        Shopping list, the Stores and the keys.
      </Lead>
      {confirming ? (
        <div className={ADD_PANEL}>
          <p id="deal-finder-delete-confirm" className="font-semibold">
            {DELETE_QUESTION}
          </p>
          <div className={BUTTONS}>
            <Button
              type="button"
              aria-describedby="deal-finder-delete-confirm"
              disabled={props.busy}
              onClick={() => {
                setConfirming(false);
                void props.act(deleteDealFinderData, "All deal finder data is deleted.");
              }}
            >
              Delete all deal finder data
            </Button>
            <Button
              type="button"
              variant="outlined"
              disabled={props.busy}
              onClick={() => setConfirming(false)}
            >
              Keep it
            </Button>
          </div>
        </div>
      ) : (
        <div className={BUTTONS}>
          <Button
            type="button"
            variant="outlined"
            disabled={props.busy}
            onClick={() => setConfirming(true)}
          >
            Delete all deal finder data
          </Button>
        </div>
      )}
    </SettingCard>
  );
}

// Every card, from a view: what the page and its tests paint.
export function PriceSourcesCards(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  zone: string;
  now?: Date;
  onFind?: (miles: FindStoresMiles) => void;
}) {
  const now = props.now ?? new Date();
  const [miles, setMiles] = useState<FindStoresMiles>(props.view.findDistanceMiles);
  const find = (chosen: FindStoresMiles) => props.onFind?.(chosen);
  const cardProps = { view: props.view, busy: props.busy, act: props.act };
  return (
    <>
      <ScrapingServiceCard {...cardProps} zone={props.zone} now={now} />
      <KrogerCard {...cardProps} zone={props.zone} now={now} />
      <OpenFoodFactsCard {...cardProps} />
      <ZipCard {...cardProps} onTurnedOn={() => find(miles)} />
      <StoresCard
        {...cardProps}
        zone={props.zone}
        now={now}
        miles={miles}
        onMiles={setMiles}
        onFind={() => find(miles)}
      />
      <DeleteDealFinderCard {...cardProps} />
    </>
  );
}

async function answerOf(
  res: Response,
): Promise<{ error?: string; words?: string; view?: PriceSourcesView }> {
  try {
    const body = (await res.json()) as { error?: unknown; words?: unknown; priceSources?: unknown };
    return {
      ...(typeof body.error === "string" ? { error: body.error } : {}),
      ...(typeof body.words === "string" ? { words: body.words } : {}),
      ...(typeof body.priceSources === "object" && body.priceSources !== null
        ? { view: body.priceSources as PriceSourcesView }
        : {}),
    };
  } catch {
    return {};
  }
}

export function PriceSources() {
  const [view, setView] = useState<PriceSourcesView | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const zone = useHouseholdZone();
  // Find Stores near us runs again once a visit when the ZIP code changed.
  const refound = useRef(false);

  const act: Act = async (request, doneWords) => {
    setError(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      const res = await request();
      const answer = await answerOf(res);
      if (!res.ok) {
        setError(answer.error ?? "That did not work.");
        return false;
      }
      if (answer.view !== undefined) setView(answer.view);
      setDone(answer.words ?? doneWords);
      return true;
    } catch {
      setError("The server did not answer.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const find = (miles: FindStoresMiles) =>
    void act(() => findStores(miles), "The Stores near you are listed below.");

  useEffect(() => {
    loadPriceSources()
      .then(async (res) =>
        res.ok ? setView((await res.json()).priceSources) : setError("The page did not load."),
      )
      .catch(() => setError("The server did not answer."));
  }, []);

  useEffect(() => {
    if (view === undefined || refound.current || !view.zip.on || !view.zip.changed) return;
    refound.current = true;
    find(view.findDistanceMiles);
  });

  return (
    <>
      <TabHeading>Price sources</TabHeading>
      <p className="text-muted">
        The deal finder reads Store prices through these sources. It never buys, and never signs in
        to a Store.
      </p>
      <ErrorLine error={error} />
      <DoneLine done={done} />
      {view === undefined || zone === undefined ? null : (
        <PriceSourcesCards view={view} busy={busy} act={act} zone={zone} onFind={find} />
      )}
    </>
  );
}
