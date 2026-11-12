import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import {
  FIND_STORES_MILES,
  type FindStoresMiles,
  type KeyedPriceSource,
  MAX_PRICE_SOURCE_COST_CAP_CENTS,
  type PriceSourceCheck,
  type PriceSourceStoreView,
  type PriceSourcesView,
  type StoreChanges,
  WALMART_SEARCH_NANOS,
} from "../../../deal-finder/view.ts";
import { calendarDateIn, dateLabel, dollarsAndCents, wholeDollars } from "../../../format.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { Meter } from "../../components/Meter.tsx";
import { StatusText } from "../../components/Status.tsx";
import { useHouseholdZone } from "../../household-zone.ts";
import { centsOfText } from "./Ai.tsx";
import {
  ADD_PANEL,
  BOX,
  BUTTONS,
  CHOICE,
  DoneLine,
  Field,
  HINT,
  INPUT,
  Lead,
  ROW,
  SettingCard,
  SUBHEADING,
  TabHeading,
} from "./settings-ui.tsx";

// Settings → Price sources (spec 15, The Price sources page in Settings): the Keys, the month's
// cost against the cost cap, the Stores with the ZIP code switch and Find Stores near us, and
// "Delete all deal finder data". A saved key shows only its last 4 characters.

// Each request the page sends. Every one takes and answers JSON.
const priceSources = api["price-sources"];
export const loadPriceSources = () => priceSources.$get();
export const saveApifyToken = (token: string) => priceSources.apify.$put({ json: { token } });
export const saveKrogerKeys = (clientId: string, clientSecret: string) =>
  priceSources.kroger.$put({ json: { clientId, clientSecret } });
// A route with a path parameter and a JSON body takes the body through a variable: the client's
// type names only the parameter.
export const testPriceSource = (source: KeyedPriceSource) => {
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

// What the last Test found, on a key's line.
const CHECK_WORDS: Record<KeyedPriceSource, Record<PriceSourceCheck, string>> = {
  apify: {
    passed: "Working",
    refused: "Apify refused the token",
    "usage limit": "Apify usage limit reached",
    "no answer": "Apify did not answer",
  },
  kroger: {
    passed: "Working",
    refused: "Kroger refused the keys",
    "usage limit": "Kroger's usage limit reached",
    "no answer": "Kroger did not answer",
  },
};

// A short select on one line with its label, with no space above it.
const INLINE_SELECT = BOX.replace("mt-1.5 block", "").replace("w-full", "w-32");

function dayOf(at: string, zone: string, now: Date): string {
  return dateLabel(calendarDateIn(new Date(at), zone), calendarDateIn(now, zone));
}

// A distance as the page shows it: one decimal, and none on a whole number, so 6.380895023524989
// is "6.4 mi" and 50 is "50 mi". The stored distance keeps every digit.
export function milesText(miles: number): string {
  const tenths = Math.round(miles * 10) / 10;
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)} mi`;
}

// An amount on a delivery line: "$35" for whole dollars, "$6.99" otherwise.
const amountText = (cents: number) =>
  cents % 100 === 0 ? wholeDollars(cents) : dollarsAndCents(cents);

// An online Store's delivery amounts, as its line shows them (spec 15, Trip setting).
export function deliveryText(
  store: Pick<PriceSourceStoreView, "deliveryFee" | "freeDeliveryFrom">,
): string {
  if (store.deliveryFee === null || store.deliveryFee === 0) return "Free delivery";
  const fee = `Delivery ${amountText(store.deliveryFee)}`;
  return store.freeDeliveryFrom === null
    ? fee
    : `${fee}, free from ${amountText(store.freeDeliveryFrom)}`;
}

// The two delivery amounts a Member typed, in cents. An empty field is none; anything else that is
// not dollars gives undefined.
export function deliveryChangesOf(fee: string, free: string): StoreChanges | undefined {
  const amountOf = (text: string) => (text.trim() === "" ? null : centsOfText(text));
  const deliveryFee = amountOf(fee);
  const freeDeliveryFrom = amountOf(free);
  if (deliveryFee === undefined || freeDeliveryFrom === undefined) return undefined;
  return { deliveryFee, freeDeliveryFrom };
}

const centsField = (cents: number | null) => (cents === null ? "" : String(cents / 100));

// What a key's line says about it: not set, not tested, or what the last Test found and when.
function KeyState(props: {
  source: KeyedPriceSource;
  last4: string | null;
  check: PriceSourceCheck | null;
  checkedAt: string | null;
  zone: string;
  now: Date;
}) {
  if (props.last4 === null) return <span className="text-muted">Not set</span>;
  if (props.check === null || props.checkedAt === null) {
    return <span className="text-muted">Not tested yet</span>;
  }
  return (
    <>
      <StatusText tone={props.check === "passed" ? "good" : "serious"}>
        {CHECK_WORDS[props.source][props.check]}
      </StatusText>
      <span className="text-muted"> · tested {dayOf(props.checkedAt, props.zone, props.now)}</span>
    </>
  );
}

type KeyProps = {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  zone: string;
  now: Date;
  // The key's fields start open, as after Change.
  editing?: boolean | undefined;
};

// One key's line on the Keys card: its name, its last 4 characters, what the last Test found,
// Test, and Change, which opens the key's fields in place under the line.
function KeyLine(props: {
  source: KeyedPriceSource;
  name: string;
  last4: string | null;
  check: PriceSourceCheck | null;
  checkedAt: string | null;
  zone: string;
  now: Date;
  busy: boolean;
  act: Act;
  editing: boolean;
  onEditing: (editing: boolean) => void;
  children: ReactNode;
}) {
  const formId = `${props.source}-key-form`;
  return (
    <li className={ROW}>
      <span className="w-32 font-semibold">{props.name}</span>
      <span className="w-14 font-mono text-small text-muted">
        {props.last4 === null ? null : (
          <>
            <span className="sr-only">ending in </span>…{props.last4}
          </>
        )}
      </span>
      <span className="min-w-40 flex-1 text-small">
        <KeyState {...props} />
      </span>
      <span className="flex gap-2">
        {props.last4 === null ? null : (
          <Button
            type="button"
            variant="outlined"
            size="small"
            disabled={props.busy}
            onClick={() => void props.act(() => testPriceSource(props.source))}
          >
            Test
          </Button>
        )}
        <Button
          type="button"
          variant="outlined"
          size="small"
          aria-expanded={props.editing}
          aria-controls={formId}
          onClick={() => props.onEditing(!props.editing)}
        >
          {props.last4 === null ? "Add" : "Change"}
        </Button>
      </span>
      {props.editing ? (
        <div id={formId} className="basis-full">
          {props.children}
        </div>
      ) : null}
    </li>
  );
}

function ApifyKey(props: KeyProps) {
  const { apify } = props.view;
  const [editing, setEditing] = useState(props.editing ?? false);
  const [token, setToken] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    if (await props.act(() => saveApifyToken(token.trim()), "The Apify token is saved.")) {
      setToken("");
      setEditing(false);
    }
  }

  return (
    <KeyLine
      {...props}
      source="apify"
      name="Apify token"
      last4={apify.tokenLast4}
      check={apify.check}
      checkedAt={apify.checkedAt}
      editing={editing}
      onEditing={setEditing}
    >
      <form onSubmit={save}>
        <Field
          label="API token"
          type="password"
          value={token}
          onChange={setToken}
          required
          autoComplete="off"
        />
        <p className={HINT}>
          Apify reads Products, prices and weekly ads for every Store without a free API. Its Free
          plan gives $5 of usage each month.
        </p>
        <div className={BUTTONS}>
          <Button type="submit" size="small" disabled={props.busy}>
            Save token
          </Button>
          <Button type="button" variant="outlined" size="small" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </KeyLine>
  );
}

function KrogerKeys(props: KeyProps) {
  const { kroger } = props.view;
  const [editing, setEditing] = useState(props.editing ?? false);
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
      setEditing(false);
    }
  }

  return (
    <KeyLine
      {...props}
      source="kroger"
      name="Kroger keys"
      last4={kroger.clientSecretLast4}
      check={kroger.check}
      checkedAt={kroger.checkedAt}
      editing={editing}
      onEditing={setEditing}
    >
      <form onSubmit={save}>
        <Field label="Client ID" type="password" value={clientId} onChange={setClientId} required />
        <Field
          label="Client secret"
          type="password"
          value={clientSecret}
          onChange={setClientSecret}
          required
        />
        <p className={HINT}>
          Kroger's free public API reads Kroger and its brands. Its Home store is on the Stores
          card.
        </p>
        <div className={BUTTONS}>
          <Button type="submit" size="small" disabled={props.busy}>
            Save keys
          </Button>
          <Button type="button" variant="outlined" size="small" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </KeyLine>
  );
}

// The Keys card: one line for each Price source.
export function KeysCard(props: KeyProps) {
  return (
    <SettingCard id="price-source-keys" title="Keys">
      <Lead>Each key is stored encrypted. The page shows only its last 4 characters.</Lead>
      <ul className="mt-2">
        <ApifyKey {...props} />
        <KrogerKeys {...props} />
        <li className={ROW}>
          <span className="w-32 font-semibold">Open Food Facts</span>
          <span className="min-w-40 flex-1 text-small text-muted">
            Ingredients and allergens by barcode. It needs no key, and gets only the barcode.
          </span>
          <label className={`${CHOICE} mt-0`}>
            <input
              type="checkbox"
              checked={props.view.openFoodFacts}
              disabled={props.busy}
              onChange={(e) => void props.act(() => setOpenFoodFacts(e.target.checked))}
            />
            On<span className="sr-only">: use Open Food Facts</span>
          </label>
        </li>
      </ul>
    </SettingCard>
  );
}

// The month's Price source cost against the cost cap, with Change cap in place.
export function CostCard(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  editing?: boolean | undefined;
}) {
  const { view } = props;
  const [editing, setEditing] = useState(props.editing ?? false);
  const [cap, setCap] = useState(String(view.costCap / 100));
  const [capError, setCapError] = useState<string | undefined>();

  async function saveCap(event: FormEvent) {
    event.preventDefault();
    const cents = centsOfText(cap);
    if (cents === undefined || cents > MAX_PRICE_SOURCE_COST_CAP_CENTS) {
      return setCapError("Enter the Price source cost cap in dollars, from $0 to $10,000.");
    }
    setCapError(undefined);
    if (
      await props.act(() => setPriceSourceCostCap(cents), "The Price source cost cap is saved.")
    ) {
      setEditing(false);
    }
  }

  const spent = Math.round(view.monthCostNanos / NANOS_PER_CENT);
  const share = view.costCap === 0 ? (spent > 0 ? 1 : 0) : spent / view.costCap;
  return (
    <SettingCard id="price-source-cost" title="Cost this month">
      <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <p className="tabular-nums">
          {dollarsAndCents(spent)} of {dollarsAndCents(view.costCap)} cap
        </p>
        <Meter
          share={share}
          tone={share >= 1 ? "serious" : "accent"}
          className="min-w-24 max-w-[320px] flex-1"
        />
        <Button
          type="button"
          variant="outlined"
          size="small"
          aria-expanded={editing}
          aria-controls="cost-cap-form"
          onClick={() => setEditing(!editing)}
        >
          Change cap
        </Button>
      </div>
      {editing ? (
        <form id="cost-cap-form" onSubmit={saveCap}>
          <Field
            label="Price source cost cap, in dollars a month"
            value={cap}
            onChange={setCap}
            required
            className="max-w-36 tabular-nums"
          />
          <div className={BUTTONS}>
            <Button type="submit" size="small" disabled={props.busy}>
              Save cap
            </Button>
            <Button type="button" variant="outlined" size="small" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          <ErrorLine error={capError} />
        </form>
      ) : null}
      <p className={HINT}>At the cap, plan runs use stored prices only, until the 1st.</p>
    </SettingCard>
  );
}

// A short tag on a Store's line for one problem, and its full words.
export type StoreTag = { word: string; tone: "serious" | "muted"; why: string };

// The tags on a Store's line (spec 15, Find Stores near us). With the ZIP code switch on, a Store
// the last lookup did not find says why, and a Store the lookup failed for says it shows the
// earlier result.
export function storeTagsOf(
  store: PriceSourceStoreView,
  zipOn: boolean,
  miles: FindStoresMiles,
): StoreTag[] {
  const notFound = zipOn ? store.notFound : null;
  if (notFound === "none") {
    return [
      {
        word: `None within ${miles} miles`,
        tone: "muted",
        why: `The last lookup found none within ${miles} miles.`,
      },
    ];
  }
  if (notFound === "failed") {
    return [
      {
        word: "Lookup failed",
        tone: "serious",
        why: "Could not look it up. Try Find Stores again later.",
      },
    ];
  }
  if (notFound === "no key") {
    const keyed = store.reader === "Store API";
    return [
      {
        word: `Save the ${keyed ? "Kroger keys" : "Apify token"} first`,
        tone: "serious",
        why: `Not looked up: save the ${keyed ? "Kroger API keys" : "Apify token"} first.`,
      },
    ];
  }
  if (notFound === "unknown") {
    return [
      {
        word: "Find again",
        tone: "serious",
        why: "Not found by the last lookup. Find Stores near us again.",
      },
    ];
  }
  const tags: StoreTag[] = [];
  if (store.needsZip) {
    tags.push({
      word: "Needs ZIP code",
      tone: "serious",
      why: 'Needs your ZIP code: turn on "Use our ZIP code to find stores".',
    });
  }
  if (store.findAgain) {
    tags.push({
      word: "Find again",
      tone: "serious",
      why: "Its Home store is made up. Find Stores near us again.",
    });
  }
  if (zipOn && store.earlierResult) {
    tags.push({
      word: "Earlier result",
      tone: "serious",
      why: "The last lookup failed; this is the earlier result.",
    });
  }
  if (store.id === "walmart") {
    const cost = dollarsAndCents(Math.round(WALMART_SEARCH_NANOS / 10_000_000));
    tags.push({
      word: `About ${cost} a search`,
      tone: "muted",
      why: `Each Walmart search costs about ${cost} on Apify. It is off until a Member ticks it.`,
    });
  }
  return tags;
}

function Tag(props: { tag: StoreTag }) {
  const { tag } = props;
  return (
    <span className="text-small" title={tag.why}>
      {tag.tone === "muted" ? (
        <span className="text-muted">{tag.word}</span>
      ) : (
        <StatusText tone="serious">{tag.word}</StatusText>
      )}
    </span>
  );
}

// A Home store's name without the Store's own name before it: "Kroger, Maple Avenue" on Kroger's
// line is "Maple Avenue".
const placeName = (store: PriceSourceStoreView, name: string) =>
  name.startsWith(`${store.name}, `) ? name.slice(store.name.length + 2) : name;

// Where a Store is read, on its line. A Store the last lookup did not find, or that needs the ZIP
// code, shows only its tag.
function placeOf(store: PriceSourceStoreView, zipOn: boolean): string | null {
  if (zipOn && store.notFound !== null) return null;
  if (store.kind === "online") return `Online. ${deliveryText(store)}`;
  if (store.needsZip) return null;
  if (!zipOn) return "Its default store";
  if (store.findAgain) return "No Home store";
  if (store.homeStore === null) return "Priced by ZIP code";
  const name = placeName(store, store.homeStore.name);
  return store.distanceMiles === null ? name : `${name}, ${milesText(store.distanceMiles)}`;
}

export type StoreLineProps = {
  store: PriceSourceStoreView;
  busy: boolean;
  act: Act;
  now: Date;
  zone: string;
  zipOn: boolean;
  // The distance the last Find Stores near us looked within.
  miles: FindStoresMiles;
  // What starts open under the line, as after Change or Edit.
  opened?: "home store" | "delivery";
};

// A Store's tick with its name, and anything after the name. A Store not found, or that needs the
// ZIP code, cannot be ticked on.
function StoreTick(props: StoreLineProps & { className: string; children?: ReactNode }) {
  const { store } = props;
  const blocked = store.needsZip || (props.zipOn && store.notFound !== null);
  return (
    <label className={props.className}>
      <input
        type="checkbox"
        checked={store.on}
        disabled={props.busy || (blocked && !store.on)}
        onChange={(e) => void props.act(() => changeStore(store.id, { on: e.target.checked }))}
      />
      {store.name}
      {props.children}
    </label>
  );
}

// One Store on the Stores card: its tick, where it is read, its tags, its last good read, and
// Change for its Home store, or Edit for an online Store's delivery amounts.
export function StoreLine(props: StoreLineProps) {
  const { store } = props;
  const [opened, setOpened] = useState(props.opened);
  const tags = storeTagsOf(store, props.zipOn, props.miles);
  const place = placeOf(store, props.zipOn);
  const found = !(props.zipOn && store.notFound !== null);
  const canChange = found && store.locations.length > 1;
  const canEdit = found && store.kind === "online";
  const panelId = `store-${store.id}-panel`;
  const toggle = (what: "home store" | "delivery") => setOpened(opened === what ? undefined : what);
  return (
    <li className={ROW}>
      <StoreTick {...props} className={`${CHOICE} mt-0 w-28 font-semibold`} />
      <span className="flex min-w-40 flex-1 flex-wrap items-baseline gap-x-2.5">
        {place === null ? null : <span className="text-muted">{place}</span>}
        {tags.map((tag) => (
          <Tag key={tag.word} tag={tag} />
        ))}
      </span>
      {found ? (
        <span className="text-small text-muted">
          {store.lastGoodReadAt === null
            ? "Not read yet"
            : `Read ${dayOf(store.lastGoodReadAt, props.zone, props.now)}`}
        </span>
      ) : null}
      {canChange ? (
        <Button
          type="button"
          variant="outlined"
          size="small"
          aria-expanded={opened === "home store"}
          aria-controls={panelId}
          onClick={() => toggle("home store")}
        >
          Change
        </Button>
      ) : null}
      {canEdit ? (
        <Button
          type="button"
          variant="outlined"
          size="small"
          aria-expanded={opened === "delivery"}
          aria-controls={panelId}
          onClick={() => toggle("delivery")}
        >
          Edit
        </Button>
      ) : null}
      {canChange && opened === "home store" ? (
        <HomeStoreSelect {...props} id={panelId} onDone={() => setOpened(undefined)} />
      ) : null}
      {canEdit && opened === "delivery" ? (
        <DeliveryForm {...props} id={panelId} onDone={() => setOpened(undefined)} />
      ) : null}
    </li>
  );
}

function HomeStoreSelect(props: StoreLineProps & { id: string; onDone: () => void }) {
  const { store } = props;
  return (
    <div id={props.id} className="basis-full">
      <label className="block text-sm font-semibold">
        Home store
        <select
          className={INPUT}
          value={store.homeStore?.id ?? ""}
          disabled={props.busy}
          onChange={async (e) => {
            const homeStoreId = e.target.value;
            if (await props.act(() => changeStore(store.id, { homeStoreId }))) props.onDone();
          }}
        >
          {store.locations.map((place) => (
            <option key={place.id} value={place.id}>
              {placeName(store, place.name)}, {milesText(place.distanceMiles)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// An online Store's delivery amounts, in place under its line. A Store visited in person has none:
// the plan adds a delivery fee only to an online order (spec 15, Trip setting).
function DeliveryForm(props: StoreLineProps & { id: string; onDone: () => void }) {
  const { store } = props;
  const [fee, setFee] = useState(centsField(store.deliveryFee));
  const [free, setFree] = useState(centsField(store.freeDeliveryFrom));
  const [error, setError] = useState<string | undefined>();

  async function save(event: FormEvent) {
    event.preventDefault();
    const changes = deliveryChangesOf(fee, free);
    if (changes === undefined) {
      return setError("Enter each amount in dollars, or leave it empty for none.");
    }
    setError(undefined);
    const saved = await props.act(
      () => changeStore(store.id, changes),
      `${store.name}'s delivery amounts are saved.`,
    );
    if (saved) props.onDone();
  }

  return (
    <form id={props.id} onSubmit={save} className="basis-full">
      <div className="flex flex-wrap items-end gap-x-4">
        <Field
          label="Delivery fee per order"
          value={fee}
          onChange={setFee}
          inputMode="decimal"
          className="max-w-32 tabular-nums"
        />
        <Field
          label="Free delivery on orders of"
          value={free}
          onChange={setFree}
          inputMode="decimal"
          className="max-w-32 tabular-nums"
        />
      </div>
      <p className={HINT}>
        The plan adds the fee to {store.name} orders below the free-delivery amount. Leave both
        empty if your delivery is free, such as with Prime.
      </p>
      <div className={BUTTONS}>
        <Button type="submit" size="small" disabled={props.busy}>
          Save
        </Button>
        <Button type="button" variant="outlined" size="small" onClick={props.onDone}>
          Cancel
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}

// A Store that gives only a weekly ad, as one tick in a wrapped row.
function WeeklyAdTick(props: StoreLineProps) {
  const tags = storeTagsOf(props.store, props.zipOn, props.miles);
  return (
    <li>
      <StoreTick {...props} className={`${CHOICE} mt-0`}>
        {tags.map((tag) => (
          <Tag key={tag.word} tag={tag} />
        ))}
      </StoreTick>
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
  // After the ZIP code switch turns on, Find Stores near us runs.
  onTurnedOn: () => void;
}) {
  const { view } = props;
  const { zip } = view;
  const lineProps = {
    busy: props.busy,
    act: props.act,
    now: props.now,
    zone: props.zone,
    zipOn: zip.on,
    miles: view.findDistanceMiles,
  };
  const stores = view.stores.filter((store) => store.kind !== "weekly ad only");
  const weeklyAds = view.stores.filter((store) => store.kind === "weekly ad only");
  // Each problem tag's full words, once, under the Stores.
  const whys = new Map<string, string>();
  for (const store of view.stores) {
    for (const tag of storeTagsOf(store, zip.on, view.findDistanceMiles)) {
      if (tag.tone === "serious") whys.set(tag.why, tag.word);
    }
  }
  return (
    <SettingCard id="stores" title="Stores">
      <Lead>
        Tick the Stores to read. A Store that is not ticked is never read, and costs nothing.
      </Lead>
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
        Use our ZIP code to find stores{zip.zipCode === null ? null : ` (${zip.zipCode})`}
      </label>
      {zip.zipCode === null ? (
        <p className={HINT}>Add the Household's ZIP code in Settings → Household first.</p>
      ) : zip.on ? null : (
        <p className={HINT}>
          Off, Walmart, Target and Costco are read at their default stores, and Amazon online.
          Kroger, Aldi and the weekly ads need the ZIP code.
        </p>
      )}
      {zip.changed && zip.on ? (
        <p className="mt-2 text-small">
          <StatusText tone="serious">Your ZIP code changed. Find Stores near us again.</StatusText>
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor="find-stores-miles" className="text-sm font-semibold">
          Stores within
        </label>
        <select
          id="find-stores-miles"
          className={INLINE_SELECT}
          value={props.miles}
          onChange={(e) =>
            props.onMiles(FIND_STORES_MILES.find((miles) => String(miles) === e.target.value) ?? 25)
          }
        >
          {FIND_STORES_MILES.map((miles) => (
            <option key={miles} value={miles}>
              {miles} miles
            </option>
          ))}
        </select>
        <Button type="button" disabled={props.busy || !zip.on} onClick={props.onFind}>
          Find Stores near us
        </Button>
      </div>
      {zip.on && view.storesFoundAt !== null ? (
        <p className={HINT}>Last looked up {dayOf(view.storesFoundAt, props.zone, props.now)}</p>
      ) : null}
      {view.stores.length === 0 ? (
        <p className="mt-3">No Stores found yet.</p>
      ) : (
        <ul className="mt-3 border-t border-line-soft">
          {stores.map((store) => (
            <StoreLine key={store.id} store={store} {...lineProps} />
          ))}
        </ul>
      )}
      {weeklyAds.length === 0 ? null : (
        <>
          <h4 className={SUBHEADING}>Weekly ads (Deals only)</h4>
          <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
            {weeklyAds.map((store) => (
              <WeeklyAdTick key={store.id} store={store} {...lineProps} />
            ))}
          </ul>
        </>
      )}
      {[...whys].map(([why, word]) => (
        <p key={why} className={HINT}>
          {word}: {why}
        </p>
      ))}
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

// Every card, from a view: what the page and its tests paint. `editing` opens the key and cost cap
// fields, as after Change.
export function PriceSourcesCards(props: {
  view: PriceSourcesView;
  busy: boolean;
  act: Act;
  zone: string;
  now?: Date;
  onFind?: (miles: FindStoresMiles) => void;
  editing?: boolean;
}) {
  const now = props.now ?? new Date();
  const [miles, setMiles] = useState<FindStoresMiles>(props.view.findDistanceMiles);
  const find = (chosen: FindStoresMiles) => props.onFind?.(chosen);
  const cardProps = { view: props.view, busy: props.busy, act: props.act };
  return (
    <>
      <KeysCard {...cardProps} zone={props.zone} now={now} editing={props.editing} />
      <CostCard {...cardProps} editing={props.editing} />
      <StoresCard
        {...cardProps}
        zone={props.zone}
        now={now}
        miles={miles}
        onMiles={setMiles}
        onFind={() => find(miles)}
        onTurnedOn={() => find(miles)}
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
