import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  type AiProviderName,
  type AiStatus,
  type AiTier,
  type AiUsageView,
  type AiView,
  DEFAULT_MODELS,
  type EnteredPrice,
  MAX_COST_CAP_CENTS,
  type ModelCheck,
  onGateway,
  USAGE_LIMIT_LINKS,
} from "../../../ai/ai-view.ts";
import { tablePrice } from "../../../ai/prices.ts";
import { capLine } from "../../../ai/usage-view.ts";
import { calendarDateIn, dateLabel } from "../../../format.ts";
import type { HouseholdFactsView } from "../../../server/household-views.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD } from "../../components/Fields.tsx";

// Settings → AI: the Household's one AI provider (spec 08, AI settings page). The API key and the
// gateway token are write-only: the page shows only whether each is set.

// The words to show for a refused request: the server's own, such as "Enter the API key.".
async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// Today as a calendar date in the Household time zone, or in this browser's time zone while the
// Household facts are loading. Never the date in UTC, which is tomorrow in the US each evening.
export function todayHere(
  now = new Date(),
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  return calendarDateIn(now, zone);
}

export function statusLine(status: AiStatus, today: string): string {
  switch (status.state) {
    case "on":
      return "AI is on";
    case "waits for history":
      return "AI waits for history to load";
    case "cost cap":
      return `AI paused until ${dateLabel(status.until, today)}: AI cost cap reached`;
    case "key rejected":
      return "AI paused: the AI provider rejected the key";
  }
}

// What the app sends each AI provider so it does not train on the Household's data or keep it.
export function dataUseLine(provider: AiProviderName, baseUrl: string | null): string {
  const gateway = onGateway(baseUrl)
    ? " Through Cloudflare AI Gateway, the app also asks Cloudflare to keep no prompt text."
    : "";
  switch (provider) {
    case "anthropic":
      return `Anthropic does not train on API data, and the app never sends it feedback.${gateway}`;
    case "openai":
      return `The app asks OpenAI not to store each call (store: false).${gateway}`;
    case "openrouter":
      return `The app asks OpenRouter to use only providers that do not collect data (data_collection: deny).${gateway}`;
    case "openai-compatible":
      return `The app cannot check this endpoint's data use.${gateway}`;
  }
}

const CHECK_WORDS: Record<ModelCheck, string> = {
  worked: "worked",
  "key rejected": "the AI provider rejected the key",
  failed: "did not work",
};

const TIER_LABELS: Record<AiTier, string> = { quick: "Quick model", writer: "Writer model" };

// A price as a Member types it, in dollars per million tokens, such as "0.50", in millionths of
// a dollar per million tokens. Undefined when it is not $0 or more with at most 6 decimals.
export function priceOfText(text: string): number | undefined {
  const plain = text.trim().replace(/^\$/, "");
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(plain)) return undefined;
  return Math.round(Number(plain) * 1_000_000);
}

function textOfPrice(millionths: number): string {
  return String(millionths / 1_000_000);
}

// An amount in dollars as a Member types it, such as "10" or "12.50", in cents.
export function centsOfText(text: string): number | undefined {
  const plain = text.trim().replace(/^\$/, "");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(plain)) return undefined;
  return Math.round(Number(plain) * 100);
}

type PriceText = { input: string; output: string };

function storedPriceText(ai: AiView | null, tier: AiTier): PriceText {
  const price = ai?.prices[tier];
  return price?.source === "member"
    ? { input: textOfPrice(price.input), output: textOfPrice(price.output) }
    : { input: "", output: "" };
}

// The prices to send for each model not in the price table. Fields left empty keep the stored
// prices. "bad" when a field holds no price.
export function enteredPrices(
  provider: AiProviderName,
  models: Record<AiTier, string>,
  texts: Record<AiTier, PriceText>,
): Partial<Record<AiTier, EnteredPrice>> | "bad" {
  const prices: Partial<Record<AiTier, EnteredPrice>> = {};
  for (const tier of ["quick", "writer"] as const) {
    const text = texts[tier];
    if (tablePrice(provider, models[tier]) !== undefined) continue;
    if (text.input.trim() === "" && text.output.trim() === "") continue;
    const input = priceOfText(text.input);
    const output = priceOfText(text.output);
    if (input === undefined || output === undefined) return "bad";
    prices[tier] = { input, output };
  }
  return prices;
}

function Field(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="mt-3 block">
      {props.label}
      <input
        className={FIELD}
        type={props.type ?? "text"}
        autoComplete={props.autoComplete ?? "off"}
        placeholder={props.placeholder}
        required={props.required ?? false}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}

export function AiProviderForm(props: { ai: AiView | null; onSaved: (ai: AiView | null) => void }) {
  const { ai } = props;
  const [provider, setProvider] = useState<AiProviderName>(ai?.provider ?? "anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(ai?.baseUrl ?? "");
  const [gatewayToken, setGatewayToken] = useState("");
  const [removeToken, setRemoveToken] = useState(false);
  const [quickModel, setQuickModel] = useState(
    ai?.quickModel ?? DEFAULT_MODELS.anthropic?.quick ?? "",
  );
  const [writerModel, setWriterModel] = useState(
    ai?.writerModel ?? DEFAULT_MODELS.anthropic?.writer ?? "",
  );
  const [prices, setPrices] = useState<Record<AiTier, PriceText>>({
    quick: storedPriceText(ai, "quick"),
    writer: storedPriceText(ai, "writer"),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [check, setCheck] = useState<Record<AiTier, ModelCheck> | undefined>();

  const sameDestination =
    ai !== null && ai.provider === provider && ai.baseUrl === (baseUrl.trim() || null);
  const gateway = onGateway(baseUrl.trim() || null);
  const limit = USAGE_LIMIT_LINKS[provider];

  function chooseProvider(next: AiProviderName) {
    setProvider(next);
    setQuickModel(DEFAULT_MODELS[next]?.quick ?? "");
    setWriterModel(DEFAULT_MODELS[next]?.writer ?? "");
  }

  const models: Record<AiTier, string> = { quick: quickModel.trim(), writer: writerModel.trim() };
  const unpriced = (["quick", "writer"] as const).filter(
    (tier) => models[tier] !== "" && tablePrice(provider, models[tier]) === undefined,
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setCheck(undefined);
    const entered = enteredPrices(provider, models, prices);
    if (entered === "bad") {
      return setError("Enter each price in dollars per million tokens, such as 0.50.");
    }
    setBusy(true);
    try {
      const res = await api.ai.settings.$post({
        json: {
          provider,
          ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
          baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(),
          ...(gateway && gatewayToken.trim() !== "" ? { gatewayToken: gatewayToken.trim() } : {}),
          ...(gateway && removeToken ? { gatewayToken: null } : {}),
          quickModel: models.quick,
          writerModel: models.writer,
          ...(Object.keys(entered).length === 0 ? {} : { prices: entered }),
        },
      });
      if (!res.ok) return setError(await refusal(res));
      const body = (await res.json()) as { check: Record<AiTier, ModelCheck>; ai: AiView };
      setApiKey("");
      setGatewayToken("");
      setRemoveToken(false);
      setCheck(body.check);
      props.onSaved(body.ai);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-4" onSubmit={submit}>
      <label className="mt-3 block">
        AI provider
        <select
          className={FIELD}
          value={provider}
          onChange={(e) => chooseProvider(e.target.value as AiProviderName)}
        >
          {AI_PROVIDERS.map((name) => (
            <option key={name} value={name}>
              {AI_PROVIDER_LABELS[name]}
            </option>
          ))}
        </select>
      </label>
      <p className="mt-2 text-gray-600">{dataUseLine(provider, baseUrl.trim() || null)}</p>
      <Field
        label="API key"
        type="password"
        value={apiKey}
        onChange={setApiKey}
        placeholder={
          sameDestination && ai.keySet ? "Set. Enter a new key to change it." : "Not set"
        }
      />
      <Field
        label={
          provider === "openai-compatible"
            ? "Base URL"
            : "Base URL (optional, for a Cloudflare AI Gateway or another proxy)"
        }
        value={baseUrl}
        onChange={setBaseUrl}
        required={provider === "openai-compatible"}
      />
      {gateway ? (
        <>
          <Field
            label="Gateway token (optional)"
            type="password"
            value={gatewayToken}
            onChange={setGatewayToken}
            placeholder={
              sameDestination && ai.gatewayTokenSet
                ? "Set. Enter a new token to change it."
                : "Not set"
            }
          />
          {sameDestination && ai.gatewayTokenSet ? (
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={removeToken}
                onChange={(e) => setRemoveToken(e.target.checked)}
              />
              Remove the gateway token
            </label>
          ) : null}
        </>
      ) : null}
      <Field label="Quick model" value={quickModel} onChange={setQuickModel} required />
      <Field label="Writer model" value={writerModel} onChange={setWriterModel} required />
      {unpriced.length === 0 ? null : (
        <fieldset className="mt-4">
          <legend className="font-semibold">Prices, in dollars per million tokens</legend>
          <p className="mt-1 text-gray-600">
            The app has no price for this model. Cache reads and writes count at the input price. A
            local model may be $0. The app makes no call with a model that has no price.
          </p>
          {unpriced.map((tier) => (
            <div key={tier}>
              <Field
                label={`${TIER_LABELS[tier]} (${models[tier]}): input price`}
                value={prices[tier].input}
                onChange={(input) => setPrices({ ...prices, [tier]: { ...prices[tier], input } })}
                placeholder="0.50"
              />
              <Field
                label={`${TIER_LABELS[tier]} (${models[tier]}): output price`}
                value={prices[tier].output}
                onChange={(output) => setPrices({ ...prices, [tier]: { ...prices[tier], output } })}
                placeholder="2.50"
              />
            </div>
          ))}
        </fieldset>
      )}
      {limit === undefined ? null : (
        <p className="mt-3">
          Set a monthly usage limit at the AI provider too:{" "}
          <a className="text-blue-700 underline" href={limit.url} target="_blank" rel="noreferrer">
            {limit.label}
          </a>
          . The app does not check it.
        </p>
      )}
      <button className={BUTTON} type="submit" disabled={busy}>
        Check and save
      </button>
      <ErrorLine error={error} />
      {check === undefined ? null : (
        <ul className="mt-3">
          {(["quick", "writer"] as const).map((tier) => (
            <li key={tier}>
              {TIER_LABELS[tier]}: {CHECK_WORDS[check[tier]]}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

export function AiStatusLine(props: { ai: AiView; today: string }) {
  return (
    <p className="mt-2 font-semibold" role="status">
      {statusLine(props.ai.status, props.today)}
    </p>
  );
}

function RemoveAiProvider(props: { onRemoved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function remove() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api.ai.remove.$post({ json: {} });
      if (!res.ok) return setError(await refusal(res));
      props.onRemoved();
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button className={BUTTON} type="button" disabled={busy} onClick={remove}>
        Remove AI provider
      </button>
      <p className="mt-2 text-gray-600">
        This deletes the key. Every AI use falls back to its no-AI path.
      </p>
      <ErrorLine error={error} />
    </div>
  );
}

// The AI cost cap, per Household, whatever the AI provider (spec 08, The AI cost cap).
export function CostCapForm(props: { usage: AiUsageView; onSaved: (usage: AiUsageView) => void }) {
  const { usage } = props;
  const [cap, setCap] = useState(String(usage.capCents / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setDone(undefined);
    const capCents = centsOfText(cap);
    if (capCents === undefined || capCents > MAX_COST_CAP_CENTS) {
      return setError("Enter the AI cost cap in dollars, from $0 to $10,000.");
    }
    setBusy(true);
    try {
      const res = await api.ai["cost-cap"].$put({ json: { capCents } });
      if (!res.ok) return setError(await refusal(res));
      props.onSaved(((await res.json()) as { usage: AiUsageView }).usage);
      setDone("The AI cost cap is saved.");
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-6" onSubmit={submit}>
      <h3 className="text-lg font-semibold">AI cost cap</h3>
      <p className="mt-1">This month: {capLine(usage.totalNanos, usage.capCents)}</p>
      <p className="mt-1 text-gray-600">
        At the cap, background AI pauses until the 1st. Chat and Goals ask before each call.
      </p>
      <Field label="AI cost cap, in dollars a month" value={cap} onChange={setCap} required />
      <button className={BUTTON} type="submit" disabled={busy}>
        Save cap
      </button>
      <ErrorLine error={error} />
      {done === undefined ? null : <p className="mt-3">{done}</p>}
      <p className="mt-3">
        <Link className="text-blue-700 underline" to="/settings/ai/usage">
          AI usage
        </Link>
      </p>
    </form>
  );
}

// The AI settings page's fields, which Settings, AI shows (spec 08, AI settings page). The first-run
// wizard's Finish step links here as an optional extra.
export function AiSettingsFields() {
  const [ai, setAi] = useState<AiView | null | undefined>();
  const [usage, setUsage] = useState<AiUsageView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [zone, setZone] = useState<string | undefined>();
  const today = todayHere(new Date(), zone);

  // The check on save counts toward the month's cost, so a save loads the total again.
  const loadUsage = useCallback(() => {
    api.ai.usage
      .$get()
      .then(async (res) => {
        if (res.ok) setUsage(((await res.json()) as { usage: AiUsageView }).usage);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadUsage();
    // The AI provider is set only after the wizard's step 4, so the Household has a time zone.
    api.household
      .$get()
      .then(async (res) => {
        if (!res.ok) return;
        setZone(((await res.json()) as { facts: HouseholdFactsView | null }).facts?.timeZone);
      })
      .catch(() => {});
    api.ai.settings
      .$get()
      .then(async (res) => {
        if (!res.ok) return setError(await refusal(res));
        setAi(((await res.json()) as { ai: AiView | null }).ai);
      })
      .catch(() => setError("The server did not answer."));
  }, [loadUsage]);

  return (
    <>
      <ErrorLine error={error} />
      {ai === undefined ? null : (
        <>
          {ai === null ? (
            <p className="mt-2">No AI provider yet. Every AI use takes its no-AI path.</p>
          ) : (
            <AiStatusLine ai={ai} today={today} />
          )}
          <AiProviderForm
            key={ai === null ? "none" : "set"}
            ai={ai}
            onSaved={(saved) => {
              setAi(saved);
              loadUsage();
            }}
          />
          {usage === undefined ? null : <CostCapForm usage={usage} onSaved={setUsage} />}
          {ai === null ? null : <RemoveAiProvider onRemoved={() => setAi(null)} />}
        </>
      )}
    </>
  );
}

export function Ai() {
  return (
    <>
      <h2 className="text-xl font-semibold">AI</h2>
      <AiSettingsFields />
    </>
  );
}
