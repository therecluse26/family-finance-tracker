import { dateLabel } from "../format.ts";
import type { AiBoxView } from "../server/ai-box-views.ts";
import { api } from "./api.ts";

// The dashboard's AI box, "This week" (spec 07, 1. AI box). The notes, their groups and their
// order come from the AI box route; these are the box's own words.

export const NOTHING_NEW = "Nothing new this week.";
export const SET_UP_AI = "Set up AI for insights";

// "3 things worth acting on": the notes in "Worth acting on" that are not Done.
export const worthActingOnHeading = (count: number) =>
  `${count} ${count === 1 ? "thing" : "things"} worth acting on`;

// "AI paused until Dec 1" or "AI paused: check the AI key", while background AI is paused.
export function pausedLine(paused: AiBoxView["paused"], today: string): string | undefined {
  if (paused === null) return undefined;
  if (paused.reason === "key rejected") return "AI paused: check the AI key";
  return `AI paused until ${dateLabel(paused.until, today)}`;
}

export async function loadAiBox(): Promise<AiBoxView> {
  const res = await api["ai-box"].$get();
  if (!res.ok) throw new Error(`The AI box's request answered ${res.status}.`);
  return (await res.json()) as AiBoxView;
}

// The words of a refusal, or undefined when the request worked.
async function refusal(send: () => Promise<Response>): Promise<string | undefined> {
  let res: Response;
  try {
    res = await send();
  } catch {
    return "The server did not answer.";
  }
  if (res.ok) return undefined;
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  return typeof body.error === "string" ? body.error : "That did not work.";
}

// Done on an Alert note, for every Member, or "Done ✓" tapped again to clear it. The words of a
// refusal, or undefined when it worked.
export function markAlertNoteDone(id: string, done: boolean): Promise<string | undefined> {
  // The route reads its JSON body itself, so the typed client does not list `json`.
  const mark = { param: { id }, json: { done } };
  return refusal(() => api["ai-box"]["alert-notes"][":id"].done.$put(mark));
}

// Done on an Insight card, for every Member, or "Done ✓" tapped again to clear it.
export function markInsightCardDone(id: string, done: boolean): Promise<string | undefined> {
  const mark = { param: { id }, json: { done } };
  return refusal(() => api["ai-box"]["insight-cards"][":id"].done.$put(mark));
}
