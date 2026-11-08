import type { AiPause } from "../ai/index.ts";
import { type Database, listMemberNamesById, readAiSettings } from "../db/index.ts";
import {
  GOAL_WORDS_LENGTH,
  type GoalSaveRefusal,
  type GoalWriting,
  listGoalsWithProgress,
  markGoal,
} from "../goals/index.ts";
import type { GoalRoutes, GoalSaveRefusalView, GoalView } from "./goals-views.ts";

// The Goal routes (spec 05, Goals): every Goal with its progress and its author's name, a Member's
// mark of done or dropped, and a new Goal or new words with the AI's reading, through the goals
// module. Without the goals module's writing, as in a test app with no AI, no Goal is added.

export const NEEDS_AI_PROVIDER = "Goals need an AI provider";
export const GOALS_WAIT_FOR_HISTORY = "Goals open when your history has loaded.";

const PAUSE_WORDS: Record<AiPause, string> = {
  "no AI provider": NEEDS_AI_PROVIDER,
  "waits for history": GOALS_WAIT_FOR_HISTORY,
  "key rejected":
    "AI paused: the AI provider rejected the key. A Member can enter a new key in Settings, AI.",
  "cost cap": "AI is paused at the AI cost cap.",
  "send anyway?": "Reading this Goal is past the AI cost cap. Send anyway?",
  "no price": "The AI model has no price, so the app cannot count its cost. Choose another model.",
};

function refusalView(refusal: GoalSaveRefusal): GoalSaveRefusalView {
  switch (refusal.refused) {
    case "empty":
      return { status: 400, error: `Write the Goal in up to ${GOAL_WORDS_LENGTH} characters.` };
    case "not found":
      return { status: 404, error: "No Goal has this ID." };
    case "not active":
      return { status: 409, error: "Only an active Goal's words can be edited." };
    case "busy":
      return { status: 409, error: "The AI is still reading this Goal." };
    case "past deadline":
      return {
        status: 400,
        error: "The deadline in these words has passed. Write a date from today on.",
      };
    case "rate cap":
      return {
        status: 429,
        error: "You saved many Goals this hour. Wait a few minutes, then save it again.",
      };
    case "paused":
      return { status: 409, error: PAUSE_WORDS[refusal.pause], pause: refusal.pause };
    case "failed":
      switch (refusal.failure) {
        case "timeout":
          return {
            status: 504,
            error: "The AI did not answer within 120 seconds.",
            tryAgain: true,
          };
        case "rate limit":
          return { status: 429, error: "The AI provider is busy.", tryAgain: true };
        case "network":
          return {
            status: 502,
            error: "The app could not reach the AI provider.",
            tryAgain: true,
          };
        case "bad reply":
          return { status: 502, error: "The AI's reading did not make sense.", tryAgain: true };
        case "server error":
          return { status: 502, error: "The AI provider did not answer.", tryAgain: true };
      }
  }
}

export function goalRoutes(database: Database, writing?: GoalWriting): GoalRoutes {
  async function list(): Promise<GoalView[]> {
    const goals = await listGoalsWithProgress(database);
    const names = new Map((await listMemberNamesById(database)).map(({ id, name }) => [id, name]));
    return goals.map((goal) => ({
      ...goal,
      // A removed Member's Goals keep their name (spec 09, Members).
      author: (goal.authorId === null ? undefined : names.get(goal.authorId)) ?? goal.authorName,
    }));
  }

  return {
    list,
    async aiProvider() {
      return (await readAiSettings(database)) !== undefined;
    },
    async waitsForHistory() {
      return writing !== undefined && (await writing.pause()) === "waits for history";
    },
    async save(memberId, { goalId, words, sendAnyway }) {
      if (writing === undefined) return refusalView({ refused: "paused", pause: "no AI provider" });
      const saved =
        goalId === null
          ? await writing.add(memberId, { words, sendAnyway })
          : await writing.edit(memberId, goalId, { words, sendAnyway });
      if ("refused" in saved) return refusalView(saved);
      const goal = (await list()).find((each) => each.id === saved.goalId);
      return goal === undefined ? refusalView({ refused: "not found" }) : { goal };
    },
    async mark(id, status, memberId) {
      const marked = await markGoal(database, id, status, memberId);
      if (marked !== "marked") return marked;
      return (await list()).find((goal) => goal.id === id);
    },
  };
}
