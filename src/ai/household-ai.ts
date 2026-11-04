import { type AiCall, callModel, readPrivacyFacts } from "./call.ts";
import { type AiPause, AiPausedError } from "./outbound.ts";
import { privacyFilter } from "./privacy.ts";
import { type AiOptions, aiCalls } from "./settings.ts";

// The AI's reply, or why the use takes its no-AI path.
export type AiReply = { ready: true; text: string } | { ready: false; pause: AiPause };

// The one way other modules call the AI. Every call goes out through the privacy filter (spec 08,
// Privacy filter), then the cost gate, and its cost counts (src/ai/call.ts). AI text comes back
// with "Member A" labels, which showMemberNames turns into names for the screen.
export type HouseholdAi = {
  // A pause, such as no AI provider or the AI cost cap, makes no call: the use takes its no-AI
  // path. At the cap, Chat and reading a Goal pause with "send anyway?" until the Member says
  // yes with `sendAnyway`. Throws when the AI provider fails, or when the privacy filter refuses
  // the call, which then does not go out and does not count.
  generate(call: AiCall, options?: { sendAnyway?: boolean }): Promise<AiReply>;
  // AI text for the screen, with each Member's name in place of their label.
  showMemberNames(aiText: string): Promise<string>;
  // Each Account's label, such as "Ally checking", by its ID, for the text of a call.
  accountLabels(): Promise<ReadonlyMap<string, string>>;
};

export function householdAi(options: AiOptions): HouseholdAi {
  const { database } = options;
  const calls = aiCalls(options);
  const filter = async () => privacyFilter(await readPrivacyFacts(database));
  return {
    async generate(call, { sendAnyway = false } = {}) {
      const found = await calls.modelFor(call.use, { sendAnyway });
      if (!found.ready) return found;
      try {
        return { ready: true, ...(await callModel(found.model, call)) };
      } catch (error) {
        // The gate closed between modelFor and the call, such as at the AI cost cap.
        if (error instanceof AiPausedError) return { ready: false, pause: error.pause };
        throw error;
      }
    },
    showMemberNames: async (aiText) => (await filter()).showMemberNames(aiText),
    accountLabels: async () => (await filter()).accountLabels,
  };
}
