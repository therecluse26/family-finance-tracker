import * as z from "zod";
import { type AiTools, aiTool, type HouseholdAi } from "../ai/index.ts";
import type { Database } from "../db/index.ts";
import { propose } from "../proposals/index.ts";

// Chat's two Proposal tools (spec 08, Proposal tools). Each hands the AI's Proposal to the
// proposals module, which checks every guardrail in code and stores it open: nothing changes until
// a Member accepts it. Each answers "shown", or an error that names the broken guardrail, as
// app-built text through the privacy filter. The run is the answer: at most 2 Proposals in one.

export type ProposalToolOptions = {
  database: Database;
  ai: Pick<HouseholdAi, "forScreen" | "toolResult">;
  // The answer's run ID, which ties its Proposals to it and to its thread.
  runId: string;
  now?: () => Date;
};

const DOLLARS = z.number().nonnegative().max(1_000_000_000);
const REASON = z.string().min(1).max(300).describe("Why, in one sentence");

// Every control character, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/gu;

export function proposalTools({
  database,
  ai,
  runId,
  now = () => new Date(),
}: ProposalToolOptions): AiTools {
  // The AI's words as the card shows them: one plain line, in the one plain voice, with each
  // Member's name in place of their label. A newline in the tool's input is a space.
  const shown = async (text: string) =>
    (await ai.forScreen(text.toWellFormed().replace(CONTROL, " "))).trim();
  const answer = async (result: Awaited<ReturnType<typeof propose>>) =>
    ai.toolResult(result.outcome === "shown" ? { result: "shown" } : { error: result.guardrail });

  const propose_budget_change = aiTool({
    description:
      "Propose a new monthly Budget amount for one Category. A Member sees it as a card and decides: nothing changes until a Member accepts it. Answers shown, or an error that names the rule the Proposal broke.",
    input: z.object({
      category: z.string().min(1).max(100).describe("The Category's exact name"),
      newAmount: DOLLARS.describe("The new Budget amount in dollars"),
      reason: REASON,
    }),
    async run(input) {
      const reason = await shown(input.reason);
      const budgets = [{ category: input.category, amount: Math.round(input.newAmount * 100) }];
      return answer(
        await propose(
          database,
          { kind: "Budget change", source: "Chat", runId, reason, budgets },
          now(),
        ),
      );
    },
  });

  const propose_goal = aiTool({
    description:
      "Propose a new Goal. A Member sees it as a card and decides: nothing changes until a Member accepts it. Answers shown, or an error that names the rule the Proposal broke.",
    input: z.object({
      words: z
        .string()
        .min(1)
        .max(200)
        .describe("The Goal in a Member's plain words, under 15 words"),
      reason: REASON,
    }),
    async run(input) {
      const reason = await shown(input.reason);
      const words = await shown(input.words);
      return answer(
        await propose(database, { kind: "new Goal", source: "Chat", runId, reason, words }, now()),
      );
    },
  });

  return { propose_budget_change, propose_goal };
}
