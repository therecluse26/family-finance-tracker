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
  type KeyTestResult,
  MAX_COST_CAP_CENTS,
  type ModelCheck,
  onGateway,
  USAGE_LIMIT_LINKS,
} from "../../../ai/ai-view.ts";
import { tablePrice } from "../../../ai/prices.ts";
import { capLine } from "../../../ai/usage-view.ts";
import { calendarDateIn, dateLabel, type StatusTone } from "../../../format.ts";
import type { HouseholdFactsView } from "../../../server/household-views.ts";
import { api } from "../../api.ts";
import { Button } from "../../components/Button.tsx";
import { ErrorLine } from "../../components/Fields.tsx";
import { Meter } from "../../components/Meter.tsx";
import { StatusText } from "../../components/Status.tsx";
import {
  BUTTONS,
  CHOICE,
  DoneLine,
  Field,
  HINT,
  INPUT,
  LABEL,
  Lead,
  SettingCard,
  SUBHEADING,
  TabHeading,
  TEXT_LINK,
} from "./settings-ui.tsx";

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

// The tone of each AI status: its icon and color beside the words.
const STATUS_TONE: Record<AiStatus["state"], StatusTone> = {
  on: "good",
  "waits for history": "accent",
  "cost cap": "serious",
  "key rejected": "critical",
};

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

const CHECK_TONE: Record<ModelCheck, StatusTone> = {
  worked: "good",
  "key rejected": "critical",
  failed: "critical",
};

const TIER_LABELS: Record<AiTier, string> = { quick: "Quick model", writer: "Writer model" };

// What "Test the key" found, as its line shows it (spec 08, Test the key).
export const KEY_TEST_WORDS: Record<KeyTestResult, string> = {
  works: "The key works",
  "key rejected": "The AI provider rejected the key",
  "rate limit": "The AI provider is limiting calls. Wait a minute, then test again",
  "model unknown": "The AI provider does not know the Quick model. Check the model names",
  "no answer": "The AI provider did not answer. Try again later",
  "no key": "No key is saved",
};

const KEY_TEST_TONE: Record<KeyTestResult, StatusTone> = {
  works: "good",
  "key rejected": "critical",
  "rate limit": "serious",
  "model unknown": "critical",
  "no answer": "serious",
  "no key": "muted",
};

// Presses "Test the key": the result with the AI settings after it, or the server's refusal, such
// as "Wait 4 seconds, then test the key again.". A refusal because the settings changed during the
// test comes with the AI settings as they are now, for the status line.
export async function testTheKey(): Promise<
  { result: KeyTestResult; ai: AiView | null } | { error: string; ai?: AiView | null }
> {
  const res = await api.ai.test.$post({ json: {} });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; ai?: AiView | null };
    const error = typeof body.error === "string" ? body.error : "That did not work.";
    return body.ai === undefined ? { error } : { error, ai: body.ai };
  }
  return (await res.json()) as { result: KeyTestResult; ai: AiView | null };
}

// The line under the buttons: what the last test found, with its icon, color, and words.
export function KeyTestLine(props: { result: KeyTestResult }) {
  return (
    <p className="mt-3 text-small" role="status" data-slot="key-test">
      <StatusText tone={KEY_TEST_TONE[props.result]}>{KEY_TEST_WORDS[props.result]}</StatusText>
    </p>
  );
}

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

export function AiProviderForm(props: {
  ai: AiView | null;
  onSaved: (ai: AiView | null) => void;
  // After a test, with the AI settings it read. The form keeps what the Member typed.
  onTested?: (ai: AiView | null) => void;
}) {
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
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<KeyTestResult | undefined>();
  const [testError, setTestError] = useState<string | undefined>();

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
    // A save checks the key again, so the last test's line no longer holds.
    setTested(undefined);
    setTestError(undefined);
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

  // "Test the key" tests the saved settings, not the fields as typed. Its call counts toward the
  // month's cost, and it may change the status line, so the page loads both again.
  async function testKey() {
    setTestError(undefined);
    setTested(undefined);
    // The test checks the key again, so the last save's check lines no longer hold.
    setCheck(undefined);
    setTesting(true);
    const tested = props.onTested ?? props.onSaved;
    try {
      const answer = await testTheKey();
      if ("error" in answer) {
        setTestError(answer.error);
        if (answer.ai !== undefined) tested(answer.ai);
        return;
      }
      setTested(answer.result);
      tested(answer.ai);
    } catch {
      setTestError("The server did not answer.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label className={LABEL}>
        AI provider
        <select
          className={INPUT}
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
      <p className={HINT}>{dataUseLine(provider, baseUrl.trim() || null)}</p>
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
            <label className={CHOICE}>
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
      <h4 className={SUBHEADING}>Models</h4>
      <p className={HINT}>
        The Quick model makes the small choices during sync. The Writer model writes the Insight
        cards, the Monthly review, Chat, and Budget tailoring.
      </p>
      <div className="grid gap-x-5 sm:grid-cols-2">
        <Field
          label="Quick model"
          value={quickModel}
          onChange={setQuickModel}
          required
          className="max-w-none"
        />
        <Field
          label="Writer model"
          value={writerModel}
          onChange={setWriterModel}
          required
          className="max-w-none"
        />
      </div>
      {unpriced.length === 0 ? null : (
        <fieldset className="mt-5">
          <legend className="text-sm font-semibold">Prices, in dollars per million tokens</legend>
          <p className={HINT}>
            The app has no price for this model. Cache reads and writes count at the input price. A
            local model may be $0. The app makes no call with a model that has no price.
          </p>
          {unpriced.map((tier) => (
            <div key={tier} className="grid gap-x-5 sm:grid-cols-2">
              <Field
                label={`${TIER_LABELS[tier]} (${models[tier]}): input price`}
                value={prices[tier].input}
                onChange={(input) => setPrices({ ...prices, [tier]: { ...prices[tier], input } })}
                placeholder="0.50"
                className="max-w-36 tabular-nums"
              />
              <Field
                label={`${TIER_LABELS[tier]} (${models[tier]}): output price`}
                value={prices[tier].output}
                onChange={(output) => setPrices({ ...prices, [tier]: { ...prices[tier], output } })}
                placeholder="2.50"
                className="max-w-36 tabular-nums"
              />
            </div>
          ))}
        </fieldset>
      )}
      {limit === undefined ? null : (
        <p className="mt-4 text-small text-muted">
          Set a monthly usage limit at the AI provider too:{" "}
          <a className={TEXT_LINK} href={limit.url} target="_blank" rel="noreferrer">
            {limit.label}
          </a>
          . The app does not check it.
        </p>
      )}
      <div className={BUTTONS}>
        <Button type="submit" disabled={busy}>
          Check and save
        </Button>
        <Button type="button" variant="outlined" disabled={testing} onClick={testKey}>
          Test the key
        </Button>
      </div>
      <ErrorLine error={error} />
      <ErrorLine error={testError} />
      {tested === undefined ? null : <KeyTestLine result={tested} />}
      {check === undefined ? null : (
        <ul className="mt-3 text-small">
          {(["quick", "writer"] as const).map((tier) => (
            <li key={tier}>
              <StatusText tone={CHECK_TONE[check[tier]]}>
                {TIER_LABELS[tier]}: {CHECK_WORDS[check[tier]]}
              </StatusText>
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

export function AiStatusLine(props: { ai: AiView; today: string }) {
  return (
    <p className="font-semibold" role="status">
      <StatusText tone={STATUS_TONE[props.ai.status.state]}>
        {statusLine(props.ai.status, props.today)}
      </StatusText>
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
    <SettingCard id="remove-ai-provider" title="Remove AI provider">
      <Lead>This deletes the key. Every AI use falls back to its no-AI path.</Lead>
      <div className={BUTTONS}>
        <Button type="button" variant="outlined" disabled={busy} onClick={remove}>
          Remove AI provider
        </Button>
      </div>
      <ErrorLine error={error} />
    </SettingCard>
  );
}

export const COST_CAP_SAVED = "The AI cost cap is saved.";

// Saves the AI cost cap typed in dollars. Answers the new usage with the saved message, or the
// words for a cap the app or the server refuses.
export async function saveCostCap(
  typed: string,
): Promise<{ usage: AiUsageView; saved: string } | { error: string }> {
  const capCents = centsOfText(typed);
  if (capCents === undefined || capCents > MAX_COST_CAP_CENTS) {
    return { error: "Enter the AI cost cap in dollars, from $0 to $10,000." };
  }
  const res = await api.ai["cost-cap"].$put({ json: { capCents } });
  if (!res.ok) return { error: await refusal(res) };
  return { usage: ((await res.json()) as { usage: AiUsageView }).usage, saved: COST_CAP_SAVED };
}

// Billionths of a dollar in a cent: the unit of an AI call's cost against the cap's unit.
const NANOS_PER_CENT = 1_000_000_000 / 100;

// How much of the AI cost cap this month's calls spent, for the bar beside the words. It compares
// the exact amounts the server's cap check does (`atCap`): billionths of a dollar against the cap,
// so the bar is full just when AI pauses. A $0 cap is full at once.
export function spentShare(usage: AiUsageView): number {
  if (usage.capCents === 0) return 1;
  return usage.totalNanos / (usage.capCents * NANOS_PER_CENT);
}

// The AI cost cap, per Household, whatever the AI provider (spec 08, The AI cost cap).
export function CostCapForm(props: {
  usage: AiUsageView;
  today: string;
  onSaved: (usage: AiUsageView) => void;
}) {
  const { usage } = props;
  const [cap, setCap] = useState(String(usage.capCents / 100));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    setDone(undefined);
    setBusy(true);
    try {
      const answer = await saveCostCap(cap);
      if ("error" in answer) return setError(answer.error);
      props.onSaved(answer.usage);
      setDone(answer.saved);
    } catch {
      setError("The server did not answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingCard
      id="ai-cost-cap"
      title="AI cost cap"
      status={
        usage.pausedUntil === null ? undefined : (
          <StatusText tone="serious">
            AI paused until {dateLabel(usage.pausedUntil, props.today)}
          </StatusText>
        )
      }
    >
      <form onSubmit={submit}>
        <p className="mt-1.5 tabular-nums">
          This month: {capLine(usage.totalNanos, usage.capCents)}
        </p>
        <Meter
          share={spentShare(usage)}
          tone={usage.pausedUntil === null ? "accent" : "serious"}
          className="mt-2.5 max-w-[520px]"
        />
        <Field
          label="AI cost cap, in dollars a month"
          value={cap}
          onChange={setCap}
          required
          className="max-w-36 tabular-nums"
        />
        <p className={HINT}>
          At the cap, background AI pauses until the 1st. Chat and Goals ask before each call.
        </p>
        <div className={BUTTONS}>
          <Button type="submit" disabled={busy}>
            Save cap
          </Button>
        </div>
        <ErrorLine error={error} />
        <DoneLine done={done} />
        <p className="mt-3 text-sm">
          <Link className={TEXT_LINK} to="/settings/ai/usage">
            AI usage
          </Link>
        </p>
      </form>
    </SettingCard>
  );
}

// What the privacy filter takes out of each call (spec 08, Privacy filter), on a grey card.
function AiPrivacyNote() {
  return (
    <section
      aria-labelledby="what-the-ai-never-sees"
      className="rounded-card border border-line bg-page p-4 min-[900px]:px-[22px] min-[900px]:py-5"
    >
      <h3 id="what-the-ai-never-sees" className="font-bold">
        What the AI never sees
      </h3>
      <p className="mt-1.5 text-small text-ink-soft">
        The ZIP code and ages are never sent. In the text the app writes for each call, "Member A",
        "Member B", and so on replace the names of the Household's current Members, and Member email
        addresses and Account and card numbers are removed. The filter does not look for a removed
        Member's name. What you type in Chat is best effort: the app hides names and numbers it
        spots, but not all of them.
      </p>
    </section>
  );
}

// The AI settings page's fields, which Settings, AI shows (spec 08, AI settings page). The first-run
// wizard's Finish step links here as an optional extra.
export function AiSettingsFields() {
  const [ai, setAi] = useState<AiView | null | undefined>();
  // The form starts again, with the saved fields, only on a load, a save, or a Remove AI provider:
  // never on a test, so a test keeps what the Member typed and its own line.
  const [formKey, setFormKey] = useState<"none" | "set">("none");
  const showSaved = useCallback((saved: AiView | null) => {
    setAi(saved);
    setFormKey(saved === null ? "none" : "set");
  }, []);
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
        showSaved(((await res.json()) as { ai: AiView | null }).ai);
      })
      .catch(() => setError("The server did not answer."));
  }, [loadUsage, showSaved]);

  return (
    <>
      <ErrorLine error={error} />
      {ai === undefined ? null : (
        <>
          <SettingCard
            id="ai-provider"
            title="AI provider"
            status={ai === null ? undefined : <AiStatusLine ai={ai} today={today} />}
          >
            {ai === null ? (
              <Lead>No AI provider yet. Every AI use takes its no-AI path.</Lead>
            ) : null}
            <AiProviderForm
              key={formKey}
              ai={ai}
              onSaved={(saved) => {
                showSaved(saved);
                loadUsage();
              }}
              onTested={(tested) => {
                setAi(tested);
                loadUsage();
              }}
            />
          </SettingCard>
          {usage === undefined ? null : (
            <CostCapForm usage={usage} today={today} onSaved={setUsage} />
          )}
          <AiPrivacyNote />
          {ai === null ? null : <RemoveAiProvider onRemoved={() => showSaved(null)} />}
        </>
      )}
    </>
  );
}

export function Ai() {
  return (
    <>
      <TabHeading>AI</TabHeading>
      <AiSettingsFields />
    </>
  );
}
