import type { LanguageModel } from "ai";
import { aiMayRun } from "../bank/index.ts";
import {
  AI_SETTINGS_ROW,
  type AiUseName,
  type Database,
  readAiSettings,
  readAiSettingsVersion,
  readMemberPrice,
  removeAiSettings,
  type StoredAiSettings,
  storeAiSettings,
  storeMemberPrice,
} from "../db/index.ts";
import { type Logger, log, registerSecretValue } from "../log.ts";
import { endCondition, type NewNotice, raiseNotice } from "../notify/index.ts";
import type { SecretPlace, Secrets } from "../secrets/index.ts";
import {
  type AiProviderName,
  type AiSettings,
  type AiStatus,
  type AiTier,
  type AiUse,
  type AiView,
  baseUrlProblem,
  type EnteredPrice,
  isBackground,
  type ModelCheck,
  type ModelUse,
  onGateway,
  type PriceSource,
  USE_TIERS,
} from "./ai-view.ts";
import { checkModel, privateModels } from "./call.ts";
import type { AiCost } from "./cost.ts";
import type { AiPause } from "./outbound.ts";
import { type ModelPrice, memberPrice, tablePrice } from "./prices.ts";
import type { AiConnection, AiModelMaker } from "./providers.ts";

// The Household's one AI provider (spec 08, AI settings page). The API key and the gateway token
// are Master-key secrets: the app encrypts them, and never shows or logs them again.

// The ai module's use names and the db module's are one list.
type SameUses = [AiUse, AiUseName] extends [AiUseName, AiUse] ? true : never;
const sameUses: SameUses = true;
void sameUses;

// Each ciphertext decrypts only in ai_settings' one row, in its own column.
const KEY_PLACE: SecretPlace = { rowId: AI_SETTINGS_ROW, column: "ai_settings.api_key" };
const TOKEN_PLACE: SecretPlace = { rowId: AI_SETTINGS_ROW, column: "ai_settings.gateway_token" };

const TIERS = ["quick", "writer"] as const;

// What stops AI besides the key.
export type AiGates = {
  // False while the first history load holds back AI (spec 08, When AI does not run).
  historyLoaded(): Promise<boolean>;
  // The date background AI starts again, YYYY-MM-DD, while the month's cost is at the AI cost cap.
  costCapPausedUntil(): Promise<string | undefined>;
};

// AI waits until every Connection's history has loaded, through the bank module's gate.
export function defaultGates(database: Database, cost: AiCost): AiGates {
  return {
    historyLoaded: () => aiMayRun(database),
    costCapPausedUntil: () => cost.pausedUntil(),
  };
}

// A model's price: from the price table, or else from a Member's prices, or none.
async function priceOf(
  database: Database,
  provider: AiProviderName,
  model: string,
  entered?: EnteredPrice,
): Promise<ModelPrice | undefined> {
  const listed = tablePrice(provider, model);
  if (listed !== undefined) return listed;
  const member = entered ?? (await readMemberPrice(database, provider, model));
  return member === undefined ? undefined : memberPrice(member.input, member.output);
}

function decryptConnection(stored: StoredAiSettings, secrets: Secrets): AiConnection {
  return {
    provider: stored.provider,
    apiKey: stored.apiKey === null ? undefined : secrets.decrypt(stored.apiKey, KEY_PLACE),
    baseUrl: stored.baseUrl,
    gatewayToken:
      stored.gatewayToken === null ? undefined : secrets.decrypt(stored.gatewayToken, TOKEN_PLACE),
  };
}

export type AiOptions = {
  database: Database;
  secrets: Secrets;
  makeModels?: AiModelMaker;
  // The month's cost and the AI cost cap, with the Household time zone.
  cost: AiCost;
  gates?: AiGates;
  logger?: Logger;
  // System notices: the notify module's, unless a test gives its own.
  notices?: Partial<AiNotices>;
};

export type AiNotices = {
  raise(notice: NewNotice): Promise<unknown>;
  end(condition: string): Promise<void>;
};

export function noticesOf(options: Pick<AiOptions, "notices">): AiNotices {
  return {
    raise: options.notices?.raise ?? raiseNotice,
    end: options.notices?.end ?? endCondition,
  };
}

// The condition of the System notice that a rejected key raises. It ends when a Member saves a key
// that works, or removes the AI provider.
export const KEY_REJECTED_CONDITION = "ai key rejected";

export function aiSettings(options: AiOptions): AiSettings {
  const { database, secrets, cost, makeModels, logger = log } = options;
  const gates = options.gates ?? defaultGates(database, cost);
  const notices = noticesOf(options);

  // Undefined when the ciphertext does not decrypt, such as after a restore with another Master key.
  function readSecret(ciphertext: string, place: SecretPlace): string | undefined {
    try {
      return secrets.decrypt(ciphertext, place);
    } catch {
      logger.warn("A stored AI secret cannot be read", { column: place.column });
      return undefined;
    }
  }

  async function status(stored: StoredAiSettings): Promise<AiStatus> {
    if (stored.keyRejectedAt !== null) return { state: "key rejected" };
    const until = await gates.costCapPausedUntil();
    if (until !== undefined) return { state: "cost cap", until };
    if (!(await gates.historyLoaded())) return { state: "waits for history" };
    return { state: "on" };
  }

  // A failed notice never fails the save or the removal that led to it.
  async function endKeyRejected(): Promise<void> {
    try {
      await notices.end(KEY_REJECTED_CONDITION);
    } catch (error) {
      logger.warn("The rejected AI key System notice could not be ended", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  async function priceSource(provider: AiProviderName, model: string): Promise<PriceSource> {
    if (tablePrice(provider, model) !== undefined) return { source: "table" };
    const member = await readMemberPrice(database, provider, model);
    return member === undefined ? { source: "none" } : { source: "member", ...member };
  }

  async function view(): Promise<AiView | undefined> {
    const stored = await readAiSettings(database);
    if (stored === undefined) return undefined;
    return {
      provider: stored.provider,
      keySet: stored.apiKey !== null,
      baseUrl: stored.baseUrl,
      gatewayTokenSet: stored.gatewayToken !== null,
      quickModel: stored.quickModel,
      writerModel: stored.writerModel,
      prices: {
        quick: await priceSource(stored.provider, stored.quickModel),
        writer: await priceSource(stored.provider, stored.writerModel),
      },
      status: await status(stored),
    };
  }

  return {
    view,

    async save(input, { freshCode }) {
      const { settings: stored, generation } = await readAiSettingsVersion(database);
      // A stored key or token goes only to the AI provider and base URL it was entered for.
      const sameDestination =
        stored !== undefined &&
        stored.provider === input.provider &&
        stored.baseUrl === input.baseUrl;
      const gateway = onGateway(input.baseUrl);
      if (!gateway && typeof input.gatewayToken === "string") {
        throw new TypeError("A gateway token needs a Cloudflare AI Gateway base URL.");
      }
      if (input.provider === "openai-compatible" && input.baseUrl === null) {
        throw new TypeError("An OpenAI-compatible endpoint needs a base URL.");
      }
      if (input.baseUrl !== null && baseUrlProblem(input.baseUrl) !== undefined) {
        throw new TypeError("The app does not send a key to this base URL.");
      }

      // The app makes no call with a model that has no price, the check on save included.
      const modelOf: Record<AiTier, string> = {
        quick: input.quickModel,
        writer: input.writerModel,
      };
      const prices = {} as Record<AiTier, ModelPrice>;
      for (const tier of TIERS) {
        const price = await priceOf(database, input.provider, modelOf[tier], input.prices?.[tier]);
        if (price === undefined) return { saved: false, refusal: "price needed", tier };
        prices[tier] = price;
      }

      const changesSecrets =
        !sameDestination || input.apiKey !== undefined || typeof input.gatewayToken === "string";
      if (changesSecrets && !freshCode) return { saved: false, refusal: "code needed" };

      // A stored secret is read only when this save keeps it, so a new key replaces one that no
      // longer decrypts. One that is kept but cannot be read must be entered again.
      const storedKey = input.apiKey === undefined && sameDestination ? stored.apiKey : null;
      const keptKey = storedKey === null ? undefined : readSecret(storedKey, KEY_PLACE);
      const apiKey = input.apiKey ?? keptKey;
      if (
        (storedKey !== null && keptKey === undefined) ||
        (apiKey === undefined && input.provider !== "openai-compatible")
      ) {
        return { saved: false, refusal: "key needed" };
      }
      const storedToken =
        gateway && input.gatewayToken === undefined && sameDestination ? stored.gatewayToken : null;
      const keptToken = storedToken === null ? undefined : readSecret(storedToken, TOKEN_PLACE);
      if (storedToken !== null && keptToken === undefined) {
        return { saved: false, refusal: "token needed" };
      }
      const gatewayToken = !gateway ? undefined : (input.gatewayToken ?? keptToken);
      // Before the AI provider sees them, so no log line can hold them.
      for (const secret of [apiKey, gatewayToken]) {
        if (secret !== undefined) registerSecretValue(secret);
      }

      const connection: AiConnection = {
        provider: input.provider,
        apiKey,
        baseUrl: input.baseUrl,
        gatewayToken,
      };
      // The check is the Member's own, so no gate holds it back. It still passes the privacy
      // filter, and its cost still counts.
      const models = privateModels(database, makeModels, connection, modelOf, (tier) => ({
        use: "check on save",
        provider: input.provider,
        model: modelOf[tier],
        price: prices[tier],
        gate: async () => undefined,
        cost,
      }));
      const [quick, writer] = await Promise.all([
        checkModel(models.quick, logger),
        checkModel(models.writer, logger),
      ]);
      const check: Record<AiTier, ModelCheck> = { quick, writer };

      const written = await storeAiSettings(
        database,
        {
          provider: input.provider,
          apiKey: apiKey === undefined ? null : secrets.encrypt(apiKey, KEY_PLACE),
          baseUrl: input.baseUrl,
          gatewayToken:
            gatewayToken === undefined ? null : secrets.encrypt(gatewayToken, TOKEN_PLACE),
          quickModel: input.quickModel,
          writerModel: input.writerModel,
          keyRejectedAt: quick === "key rejected" || writer === "key rejected" ? new Date() : null,
        },
        generation,
      );
      // A Remove AI provider or another save came first while the AI provider answered.
      if (!written) return { saved: false, refusal: "changed" };
      // A key that works ends the paused AI's System notice.
      if (stored?.keyRejectedAt != null && quick !== "key rejected" && writer !== "key rejected") {
        await endKeyRejected();
      }
      for (const tier of TIERS) {
        const entered = input.prices?.[tier];
        if (entered !== undefined && tablePrice(input.provider, modelOf[tier]) === undefined) {
          await storeMemberPrice(database, input.provider, modelOf[tier], entered);
        }
      }
      const ai = await view();
      if (ai === undefined) throw new Error("The AI settings were not saved.");
      return { saved: true, check, ai };
    },

    async remove() {
      const stored = await readAiSettings(database);
      await removeAiSettings(database);
      if (stored?.keyRejectedAt != null) await endKeyRejected();
    },

    usage: () => cost.usage(),

    async setCostCap(capCents) {
      await cost.setCap(capCents);
      return cost.usage();
    },
  };
}

// The model for one AI use, or why that use takes its no-AI path.
// `generation` is the AI settings' generation the model was made from.
export type ModelFor =
  | { ready: true; model: LanguageModel; generation: number }
  | { ready: false; pause: AiPause };

export type AiCalls = {
  // Checks the AI status first. No AI provider, a rejected key, history still loading, the AI
  // cost cap, and a model with no price each give a pause. At the cap, a background use pauses,
  // and Chat and reading a Goal pause with "send anyway?" until the Member says yes. The model
  // passes the same gate again before each call it makes, and counts each call's cost.
  modelFor(use: ModelUse, options?: { sendAnyway?: boolean }): Promise<ModelFor>;
};

// Every AI use gets its model here, and nowhere else, behind the privacy filter and the cost gate
// (src/ai/call.ts). Only householdAi hands its calls to other modules: no model leaves the ai
// module. Decrypting registers the key and the token with the logger, which refuses them from
// then on.
export function aiCalls(options: AiOptions): AiCalls {
  const { database, secrets, cost, makeModels } = options;
  const gates = options.gates ?? defaultGates(database, cost);

  async function gate(use: ModelUse, sendAnyway: boolean): Promise<AiPause | undefined> {
    const stored = await readAiSettings(database);
    if (stored === undefined) return "no AI provider";
    if (stored.keyRejectedAt !== null) return "key rejected";
    if (!(await gates.historyLoaded())) return "waits for history";
    if ((await gates.costCapPausedUntil()) !== undefined) {
      if (isBackground(use)) return "cost cap";
      if (!sendAnyway) return "send anyway?";
    }
    return undefined;
  }

  return {
    async modelFor(use, { sendAnyway = false } = {}) {
      const pause = await gate(use, sendAnyway);
      if (pause !== undefined) return { ready: false, pause };
      const { settings: stored, generation } = await readAiSettingsVersion(database);
      if (stored === undefined) return { ready: false, pause: "no AI provider" };
      const tier = USE_TIERS[use];
      const model = tier === "quick" ? stored.quickModel : stored.writerModel;
      const price = await priceOf(database, stored.provider, model);
      if (price === undefined) return { ready: false, pause: "no price" };
      const models = privateModels(
        database,
        makeModels,
        decryptConnection(stored, secrets),
        { quick: stored.quickModel, writer: stored.writerModel },
        () => ({
          use,
          provider: stored.provider,
          model,
          price,
          gate: () => gate(use, sendAnyway),
          cost,
        }),
      );
      return { ready: true, model: models[tier], generation };
    },
  };
}
