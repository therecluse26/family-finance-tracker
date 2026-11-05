import { listMemberNamesById, markAiKeyRejected } from "../db/index.ts";
import { log } from "../log.ts";
import { isBackground } from "./ai-view.ts";
import { AiCallError, type AiFailure, callModel, readPrivacyFacts } from "./call.ts";
import { type AiPause, AiPausedError } from "./outbound.ts";
import { memberLabel, privacyFilter } from "./privacy.ts";
import { type AiCall, filterBatch, plainData } from "./prompt.ts";
import { aiRetries } from "./retries.ts";
import { type AiOptions, aiCalls, KEY_REJECTED_CONDITION, noticesOf } from "./settings.ts";
import { plainVoice } from "./voice.ts";

// The AI's reply, or why the use has none.
// - pause: no call went out, such as with no AI provider, at the AI cost cap, or with a rejected
//   key. The use takes its no-AI path.
// - retryAt: a background use's call failed with an AI error, or its retry is not due yet. The use
//   leaves its work, and its AI retry starts the work again at retryAt (src/ai/retries.ts). In the
//   follow-up job, the step leaves those Transactions unhandled and stops the job.
// - failed: an AI error with no retry left. A background use takes its no-AI path. Chat and
//   reading a Goal never retry by themselves: the screen shows the error with "Try again".
export type AiReply<OUTPUT = undefined> =
  | { ready: true; text: string; output: OUTPUT }
  | { ready: false; pause: AiPause }
  | { ready: false; retryAt: Date }
  | { ready: false; failed: AiFailure };

// The one way other modules call the AI. Every call goes out through the privacy filter (spec 08,
// Privacy filter), then the cost gate, and its cost counts (src/ai/call.ts). AI text comes back
// with "Member A" labels, which forScreen turns into names for the screen.
export type HouseholdAi = {
  // A pause, such as no AI provider or the AI cost cap, makes no call: the use takes its no-AI
  // path. At the cap, Chat and reading a Goal pause with "send anyway?" until the Member says
  // yes with `sendAnyway`. A 401 or 403 from the AI provider pauses AI until a Member fixes the
  // key, with a System notice. Throws when the privacy filter refuses the call, which then does
  // not go out and does not count.
  generate<OUTPUT = undefined>(
    call: AiCall<OUTPUT>,
    options?: { sendAnyway?: boolean },
  ): Promise<AiReply<OUTPUT>>;
  // AI text for the screen, in the one plain voice: no emoji, "!" turned into ".", and each
  // Member's name in place of their label.
  forScreen(aiText: string): Promise<string>;
  // Each Account's label, such as "Ally checking", by its ID, for the text of a call.
  accountLabels(): Promise<ReadonlyMap<string, string>>;
  // Each Member's label, such as "Member A", by their ID: the label the privacy filter gives the
  // Member's name, by the order Members joined. App-built text names a Member by it, never by name.
  memberLabels(): Promise<ReadonlyMap<string, string>>;
  // A tool's result as the AI reads it (spec 08, Privacy filter): plain JSON data, with each text
  // made plain, then filtered as app-built text. Its typed values, such as amounts and dates, pass
  // as the app built them (src/ai/typed.ts). Throws when the filter cannot pass it.
  toolResult(data: unknown): Promise<unknown>;
};

export function householdAi(options: AiOptions): HouseholdAi {
  const { database, logger = log } = options;
  const calls = aiCalls(options);
  const retries = aiRetries(database);
  const notices = noticesOf(options);
  const filter = async () => privacyFilter(await readPrivacyFacts(database));

  // Spec 08, Failures: a rejected key pauses AI until a Member fixes it, with one System notice.
  async function keyRejected(generation: number): Promise<void> {
    if (!(await markAiKeyRejected(database, generation, new Date()))) return;
    try {
      await notices.raise({
        kind: "condition",
        condition: KEY_REJECTED_CONDITION,
        text: "AI paused: the AI provider rejected the key. A Member can enter a new key in Settings, AI.",
      });
    } catch (error) {
      logger.warn("The rejected AI key System notice could not be raised", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return {
    async generate<OUTPUT>(
      call: AiCall<OUTPUT>,
      { sendAnyway = false } = {},
    ): Promise<AiReply<OUTPUT>> {
      const { use } = call;
      const background = isBackground(use);
      // The use checks its own retry time, whatever started it.
      if (background) {
        const retryAt = await retries.waitsUntil(use, new Date());
        if (retryAt !== undefined) return { ready: false, retryAt };
      }
      const found = await calls.modelFor(use, { sendAnyway });
      if (!found.ready) return found;
      try {
        const sent = call.batch === undefined ? call : filterBatch(call, (await filter()).text);
        const reply = await callModel(found.model, sent);
        if (background) await retries.ended(use);
        return { ready: true, ...reply };
      } catch (error) {
        // The gate closed between modelFor and the call, such as at the AI cost cap.
        if (error instanceof AiPausedError) return { ready: false, pause: error.pause };
        if (!(error instanceof AiCallError)) throw error;
        const { failure, status } = error;
        // Never the prompt or the reply: only the use and what failed.
        logger.warn("An AI call failed", { use, failure, status: status ?? null });
        if (failure === "key rejected") {
          if (background) await retries.ended(use);
          await keyRejected(found.generation);
          return { ready: false, pause: "key rejected" };
        }
        if (!background) return { ready: false, failed: failure };
        const retryAt = await retries.failed(use, new Date());
        return retryAt === undefined
          ? { ready: false, failed: failure }
          : { ready: false, retryAt };
      }
    },
    // The voice first, so a Member's own name stays as written.
    forScreen: async (aiText) => (await filter()).showMemberNames(plainVoice(aiText)),
    accountLabels: async () => (await filter()).accountLabels,
    memberLabels: async () =>
      new Map(
        (await listMemberNamesById(database)).map(({ id }, index) => [id, memberLabel(index)]),
      ),
    toolResult: async (data) => (await filter()).json(plainData(data)),
  };
}
