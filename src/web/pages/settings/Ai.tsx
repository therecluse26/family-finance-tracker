import { type FormEvent, useEffect, useState } from "react";
import {
  AI_PROVIDER_LABELS,
  AI_PROVIDERS,
  type AiProviderName,
  type AiStatus,
  type AiTier,
  type AiView,
  DEFAULT_MODELS,
  type ModelCheck,
  onGateway,
  USAGE_LIMIT_LINKS,
} from "../../../ai/ai-view.ts";
import { calendarDateIn, dateLabel } from "../../../format.ts";
import type { HouseholdFactsView } from "../../../server/household-views.ts";
import { api } from "../../api.ts";
import { BUTTON, ErrorLine, FIELD } from "../../components/Fields.tsx";

// Settings → AI: the Household's one AI provider (spec 08, AI settings page). The API key and the
// gateway token are write-only: the page shows only whether each is set.

const CODE_LABEL = "A code from your authenticator app, or a backup code";

// The words to show for a refused request: the server's own, such as "Wrong code.".
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
  const [code, setCode] = useState("");
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

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    setCheck(undefined);
    try {
      const res = await api.ai.settings.$post({
        json: {
          provider,
          ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
          baseUrl: baseUrl.trim() === "" ? null : baseUrl.trim(),
          ...(gateway && gatewayToken.trim() !== "" ? { gatewayToken: gatewayToken.trim() } : {}),
          ...(gateway && removeToken ? { gatewayToken: null } : {}),
          quickModel: quickModel.trim(),
          writerModel: writerModel.trim(),
          ...(code.trim() === "" ? {} : { code: code.trim() }),
        },
      });
      setCode("");
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
      <Field
        label={`${CODE_LABEL}, to set or change the key, the token, the AI provider, or the base URL`}
        autoComplete="one-time-code"
        value={code}
        onChange={setCode}
      />
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

export function Ai() {
  const [ai, setAi] = useState<AiView | null | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [zone, setZone] = useState<string | undefined>();
  const today = todayHere(new Date(), zone);

  useEffect(() => {
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
  }, []);

  return (
    <>
      <h2 className="text-xl font-semibold">AI</h2>
      <ErrorLine error={error} />
      {ai === undefined ? null : (
        <>
          {ai === null ? (
            <p className="mt-2">No AI provider yet. Every AI use takes its no-AI path.</p>
          ) : (
            <AiStatusLine ai={ai} today={today} />
          )}
          <AiProviderForm key={ai === null ? "none" : "set"} ai={ai} onSaved={setAi} />
          {ai === null ? null : <RemoveAiProvider onRemoved={() => setAi(null)} />}
        </>
      )}
    </>
  );
}
