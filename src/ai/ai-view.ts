// The Household's AI provider, as Settings → AI sees it (spec 08, AI settings page). The API key
// and the gateway token are never in it: only whether each is set. This file imports nothing, so
// the web app's type check can follow it.

export const AI_PROVIDERS = ["anthropic", "openai", "openrouter", "openai-compatible"] as const;

export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const AI_PROVIDER_LABELS: Record<AiProviderName, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible endpoint",
};

// Spec 08, Model tiers.
export type AiTier = "quick" | "writer" | "chat";

export const AI_TIERS = ["quick", "writer", "chat"] as const satisfies readonly AiTier[];

export type TierModels = Record<AiTier, string>;

// Haiku 5.5, Opus 5.5 and Sonnet 5.5, and GPT-6 Luna and GPT-6.1 Terra, by each provider's
// published model ID (plan call 13, D44). OpenRouter serves the Anthropic models under its own IDs.
// OpenAI's Chat model is its Writer model. An OpenAI-compatible endpoint has no defaults: the
// Member names each model, and the Chat model starts as the Writer model. This is the one place
// the app names a model; change the defaults here.
export const DEFAULT_MODELS: Record<AiProviderName, TierModels | undefined> = {
  anthropic: { quick: "claude-haiku-5-5", writer: "claude-opus-5-5", chat: "claude-sonnet-5-5" },
  openai: { quick: "gpt-6-luna", writer: "gpt-6.1-terra", chat: "gpt-6.1-terra" },
  openrouter: {
    quick: "anthropic/claude-haiku-5.5",
    writer: "anthropic/claude-opus-5.5",
    chat: "anthropic/claude-sonnet-5.5",
  },
  "openai-compatible": undefined,
};

// Where the Member sets a monthly usage limit at the AI provider. The app does not check it.
export const USAGE_LIMIT_LINKS: Record<AiProviderName, { label: string; url: string } | undefined> =
  {
    anthropic: {
      label: "Anthropic workspace limit",
      url: "https://platform.claude.com/settings/workspaces",
    },
    openai: {
      label: "OpenAI project limit",
      url: "https://platform.openai.com/settings/organization/projects",
    },
    openrouter: { label: "OpenRouter key limit", url: "https://openrouter.ai/settings/keys" },
    "openai-compatible": undefined,
  };

// A base URL on this host is a Cloudflare AI Gateway.
export const GATEWAY_HOST = "gateway.ai.cloudflare.com";

// Only over https: the gateway token goes nowhere else. The host may end in one dot, as a fully
// written DNS name does, so the gateway still gets the header that keeps prompts out of its logs.
export function onGateway(baseUrl: string | null): boolean {
  if (baseUrl === null) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname.replace(/\.$/, "") === GATEWAY_HOST;
  } catch {
    return false;
  }
}

// Why the app refuses a base URL. "link-local": the host is a link-local address, such as a cloud
// metadata address, which can hand out the server's own credentials. "plain http": http:// to a
// host that is not on this computer or a private network, so the key would cross the internet
// unencrypted. http:// stays open for a local model server, such as Ollama. "unclear host": an
// address whose destination the app cannot judge, such as 0.0.0.0, or one behind the local-use
// NAT64 prefix 64:ff9b:1::/48, which can map to any IPv4 address.
export type BaseUrlProblem = "link-local" | "plain http" | "unclear host";

// Judged on the host as written, with no DNS lookup. The URL parser has already turned other ways
// of writing an IPv4 address, such as 2852039166, into a.b.c.d.
export function baseUrlProblem(baseUrl: string): BaseUrlProblem | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const kind = hostKind(url.hostname);
  if (kind === "link-local") return "link-local";
  if (kind === "unclear") return "unclear host";
  if (url.protocol === "http:" && kind !== "local") return "plain http";
  return undefined;
}

type HostKind = "link-local" | "local" | "public" | "unclear";

// Names of cloud metadata services, which answer on a link-local address.
const METADATA_NAMES = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);

// Name endings kept for private networks: mDNS, ICANN's private-use .internal, and home networks.
const PRIVATE_NAME_ENDINGS = [".localhost", ".local", ".internal", ".home.arpa"];

function hostKind(hostname: string): HostKind {
  const v6 = ipv6Of(hostname);
  if (v6 !== undefined) return ipv6Kind(v6);
  const v4 = ipv4Of(hostname);
  if (v4 !== undefined) return ipv4Kind(v4);
  const name = hostname.replace(/\.$/, "");
  if (METADATA_NAMES.has(name)) return "link-local";
  // A name with no dot, such as a Docker Compose service, resolves only on a private network.
  if (name === "localhost" || !name.includes(".")) return "local";
  return PRIVATE_NAME_ENDINGS.some((ending) => name.endsWith(ending)) ? "local" : "public";
}

function ipv4Of(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
  return parts.map(Number);
}

function ipv4Kind([a = 0, b = 0]: number[]): HostKind {
  if (a === 0) return "unclear";
  if (a === 169 && b === 254) return "link-local";
  const local =
    a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return local ? "local" : "public";
}

// The eight 16-bit words of an IPv6 host, which the URL parser writes as [hex words with ::].
function ipv6Of(host: string): number[] | undefined {
  if (!host.startsWith("[") || !host.endsWith("]")) return undefined;
  const halves = host.slice(1, -1).split("::");
  if (halves.length > 2) return undefined;
  const words = (text: string) =>
    text === "" ? [] : text.split(":").map((word) => Number.parseInt(word, 16));
  const front = words(halves[0] ?? "");
  if (halves.length === 1) return front.length === 8 ? front : undefined;
  const back = words(halves[1] ?? "");
  return [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
}

// AWS's metadata service on IPv6.
const AWS_METADATA_V6 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x0254];

function ipv6Kind(words: number[]): HostKind {
  const [first = 0, , , , , sixth = 0, seventh = 0, eighth = 0] = words;
  const zeroUpTo = (count: number) => words.slice(0, count).every((word) => word === 0);
  // An IPv4 address inside IPv6, ::ffff:a.b.c.d or the old ::a.b.c.d, is judged as that address.
  const loopback = zeroUpTo(7) && eighth === 1;
  // So is one behind NAT64's well-known prefix, 64:ff9b::a.b.c.d.
  const nat64 = first === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((w) => w === 0);
  if ((first === 0x64 && words[1] === 0xff9b && words[2] === 1) || words.every((w) => w === 0)) {
    return "unclear";
  }
  if (nat64 || (zeroUpTo(5) && (sixth === 0xffff || (sixth === 0 && !zeroUpTo(7))))) {
    return ipv4Kind([seventh >> 8, seventh & 0xff, eighth >> 8, eighth & 0xff]);
  }
  if (loopback) return "local";
  if (words.every((word, index) => word === AWS_METADATA_V6[index])) return "link-local";
  if ((first & 0xffc0) === 0xfe80) return "link-local";
  if ((first & 0xfe00) === 0xfc00) return "local";
  return "public";
}

// Every AI use (spec 08, Every AI use), and the check on save and the key test, which also count
// toward the month's cost. The db module stores the same names.
export const AI_USES = [
  "category fix",
  "line item category",
  "merchant cleanup",
  "merchant lookup",
  "unclear transfer",
  "reimbursement linking",
  "reading a goal",
  "alert advice",
  "budget tailoring",
  "insight cards",
  "monthly review",
  "chat",
  "check on save",
  "key test",
] as const;

export type AiUse = (typeof AI_USES)[number];

export const AI_USE_LABELS: Record<AiUse, string> = {
  "category fix": "Category fix",
  "line item category": "Line item Category",
  "merchant cleanup": "Merchant cleanup",
  "merchant lookup": "Merchant lookup",
  "unclear transfer": "Unclear Transfer",
  "reimbursement linking": "Reimbursement linking",
  "reading a goal": "Reading a Goal",
  "alert advice": "Alert advice",
  "budget tailoring": "Budget tailoring",
  "insight cards": "Insight cards",
  "monthly review": "Monthly review",
  chat: "Chat",
  "check on save": "Check on save",
  "key test": "Key test",
};

// Spec 08, Model tiers. The check on save calls each tier's model, and the key test the Quick
// tier.
export type ModelUse = Exclude<AiUse, "check on save" | "key test">;

export const USE_TIERS: Record<ModelUse, AiTier> = {
  "category fix": "quick",
  "line item category": "quick",
  "merchant cleanup": "quick",
  "merchant lookup": "quick",
  "unclear transfer": "quick",
  "reimbursement linking": "quick",
  "reading a goal": "quick",
  "alert advice": "quick",
  "budget tailoring": "writer",
  "insight cards": "writer",
  "monthly review": "writer",
  chat: "chat",
};

// Background AI is every use except Chat and reading a Goal. A Member starts those two, and at
// the AI cost cap they ask "Send anyway?" first.
export function isBackground(use: ModelUse): boolean {
  return use !== "chat" && use !== "reading a goal";
}

// The AI cost cap a Household starts with: $10 a month.
export const DEFAULT_COST_CAP_CENTS = 1000;

// The highest cap a Member may set: $10,000 a month.
export const MAX_COST_CAP_CENTS = 1_000_000;

// The AI usage page (spec 08, AI usage page): metadata only, never prompt or reply text. Costs
// are in billionths of a dollar. `month` is the calendar month in the Household time zone,
// YYYY-MM, and `at` is a moment in UTC. `logEntryId` is the ID of the call's text in the AI
// request log, only while the log keeps it.
export type AiCallView = {
  id: number;
  use: AiUse;
  model: string;
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  costNanos: number;
  at: string;
  logEntryId?: number;
};

export type AiUsageView = {
  month: string;
  totalNanos: number;
  capCents: number;
  // The date background AI starts again, YYYY-MM-DD, while the month is at the cap.
  pausedUntil: string | null;
  // The month's Merchant lookups against their cap (spec 08, Merchant web lookup).
  lookups: { count: number; cap: number };
  byUse: { use: AiUse; calls: number; costNanos: number }[];
  calls: AiCallView[];
};

// The status line. "cost cap" pauses AI until `until`, a calendar date written YYYY-MM-DD.
export type AiStatus =
  | { state: "on" }
  | { state: "waits for history" }
  | { state: "cost cap"; until: string }
  | { state: "key rejected" };

// How the app prices a model: from its price table, from prices a Member entered, or not at all.
// The app makes no call with a model that has no price.
export type PriceSource =
  | { source: "table" }
  | { source: "member"; input: number; output: number }
  | { source: "none" };

// The Web lookup's switch (spec 08, Merchant web lookup). "no web search" when the AI provider has
// none, such as an OpenAI-compatible endpoint: the app makes no lookup, whatever the switch says.
export type WebLookupView = {
  on: boolean;
  // Why no lookup runs: the AI provider has no web search, or it refused the Quick model's.
  unavailable: "no web search" | "model has no web search" | null;
};

// The most Merchant lookups in a month, in Household time. A kept answer does not count.
export const MERCHANT_LOOKUPS_A_MONTH = 200;

export type AiView = {
  provider: AiProviderName;
  keySet: boolean;
  baseUrl: string | null;
  gatewayTokenSet: boolean;
  quickModel: string;
  writerModel: string;
  chatModel: string;
  prices: Record<AiTier, PriceSource>;
  status: AiStatus;
  webLookup: WebLookupView;
};

// Input and output prices a Member enters for a model not in the price table, each in millionths
// of a dollar per million tokens. Cache reads and writes then count at the input price.
export type EnteredPrice = { input: number; output: number };

// What a Member saves. An API key or gateway token left out keeps the one stored; a gateway token
// of null removes it. A change of AI provider or base URL keeps neither, so a stored key never goes
// to a host it was not entered for.
export type AiSettingsInput = {
  provider: AiProviderName;
  apiKey?: string;
  baseUrl: string | null;
  gatewayToken?: string | null;
  quickModel: string;
  writerModel: string;
  // Left out, Chat uses the Writer model.
  chatModel?: string;
  // For a model not in the price table. Left out, the prices stored for that model stay. A tier
  // left out takes the prices entered for another tier with the same model.
  prices?: Partial<Record<AiTier, EnteredPrice>>;
};

// What the one call to a model on save did.
export type ModelCheck = "worked" | "key rejected" | "failed";

export type AiSave =
  | { saved: true; check: Record<AiTier, ModelCheck>; ai: AiView }
  // The AI provider needs an API key, and none is given or kept.
  | { saved: false; refusal: "key needed" }
  // The stored gateway token cannot be read, and no new one is given.
  | { saved: false; refusal: "token needed" }
  // A Remove AI provider or another save changed the settings while this save checked them.
  | { saved: false; refusal: "changed" }
  // A model is not in the price table, and has no prices from a Member.
  | { saved: false; refusal: "price needed"; tier: AiTier };

// What "Test the key" found (spec 08, Test the key). "model unknown" is the AI provider's 404.
// "no answer" is any other AI error, such as a network failure, no reply within 120 seconds, or a
// server error. With "no key", no AI provider is saved, and the app made no call.
export type KeyTestResult =
  | "works"
  | "key rejected"
  | "rate limit"
  | "model unknown"
  | "no answer"
  | "no key";

export type KeyTest =
  // `ai` is the AI settings after the test, whose status line it may have changed.
  | { tested: true; result: KeyTestResult; ai: AiView | null }
  // Another test is running.
  | { tested: false; refusal: "busy" }
  // The last test started less than 10 seconds ago.
  | { tested: false; refusal: "too soon"; waitSeconds: number }
  // The stored key or gateway token cannot be read, such as after a restore with another Master
  // key, or the Quick model has no price. The app made no call.
  | { tested: false; refusal: "key unreadable" | "token unreadable" | "price needed" }
  // A save or a Remove AI provider changed the settings while the AI provider answered. The call
  // counted, and the AI status did not change. `ai` is the AI settings as they are now.
  | { tested: false; refusal: "changed"; ai: AiView | null };

export type AiSettings = {
  // Undefined when no AI provider is set up.
  view(): Promise<AiView | undefined>;
  // Checks both models with one call each, then saves.
  save(input: AiSettingsInput): Promise<AiSave>;
  // Deletes the AI provider and its key. Every use falls back to its no-AI path.
  remove(): Promise<void>;
  // "Test the key": one call to the saved Quick model, with no Household data. One test runs at a
  // time, at least 10 seconds after the last one started.
  testKey(): Promise<KeyTest>;
  // The AI usage page. It holds no prompt text or reply text.
  usage(): Promise<AiUsageView>;
  // Sets the AI cost cap, in cents. A cap above the month's total starts background AI again.
  setCostCap(capCents: number): Promise<AiUsageView>;
  // Turns the Web lookup on or off. Undefined with no AI provider set up.
  setWebLookup(on: boolean): Promise<AiView | undefined>;
};
