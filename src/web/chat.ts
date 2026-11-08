import type { AiBoxInsightCardView, AiBoxNoteView } from "../server/ai-box-views.ts";
import {
  CHAT_NOTE_KINDS,
  type ChatNoteKindView,
  type ChatStatusView,
  type ChatThreadItemView,
  type ChatThreadView,
} from "../server/chat-views.ts";
import type { ProposalView } from "../server/proposals-views.ts";
import { api } from "./api.ts";

// Chat's requests and words (spec 08, Chat; spec 07, Chat page). The answer itself streams through
// @ai-sdk/react's useChat, which posts to /api/chat. Each write but deleting a thread sends a JSON
// body, and the server answers 415 to one sent as anything else.

export const INPUT_PLACEHOLDER = "Ask about your money…";
export const WAITS_FOR_HISTORY = "Chat opens when your history has loaded.";
export const SEND_ANYWAY = "Send anyway?";
export const DROPPED_LINE = "Messages above this line are no longer sent to the AI.";
// What Chat sends (spec 08, What the AI provider gets).
export const PRIVACY_NOTICE =
  "Chat sends your Household's data and your messages to the AI provider.";

// The note "Ask about this" attaches: its kind, ID, and title, which the drafted question names.
export type AskAbout = { kind: Exclude<ChatNoteKindView, "Alert">; id: string; title: string };

export const draftQuestion = (title: string) => `Tell me more about this: ${title}`;

// "Ask about this" opens the Chat page with the note in the page's state, and a drafted question.
// Nothing goes to the server until the Member presses Send.
export const askAboutPath = "/chat";

export const askAboutAlertNote = (note: AiBoxNoteView): AskAbout => ({
  kind: "Alert note",
  id: note.id,
  title: note.title,
});

export const askAboutInsightCard = (card: AiBoxInsightCardView): AskAbout => ({
  kind: "Insight card",
  id: card.id,
  title: card.title,
});

// A Proposal's title is its change, one line each, as the server titles it.
export const askAboutProposal = (proposal: ProposalView): AskAbout => ({
  kind: "Proposal",
  id: proposal.id,
  title: proposal.changes.join("; "),
});

// The note in the page's state, or null when the state holds none.
export function askAboutOf(state: unknown): AskAbout | null {
  if (typeof state !== "object" || state === null) return null;
  const { kind, id, title } = state as Record<string, unknown>;
  const known = CHAT_NOTE_KINDS.find((each) => each === kind);
  if (known === undefined || typeof id !== "string" || typeof title !== "string") return null;
  return { kind: known, id, title };
}

// Why Chat cannot answer now, in the page's words, or undefined when it can, or when it asks
// "Send anyway?" before each message.
export function statusLine(status: ChatStatusView): string | undefined {
  switch (status) {
    case "ready":
    case "send anyway?":
      return undefined;
    case "waits for history":
      return WAITS_FOR_HISTORY;
    case "no AI provider":
      return "Set up an AI provider in Settings, AI, to use Chat.";
    case "key rejected":
      return "AI paused: the AI provider rejected the key. A Member can enter a new key in Settings, AI.";
    case "cost cap":
      return "AI is paused at the AI cost cap.";
    case "no price":
      return "The AI model has no price, so Chat cannot count its cost. Choose another model.";
  }
}

export const chatRequests = {
  list: () => api.chat.$get(),
  thread: (id: string) => api.chat.threads[":id"].$get({ param: { id } }),
  start: (text: string, note: AskAbout | null, sendAnyway: boolean) => {
    const start = {
      json: { text, note: note === null ? null : { kind: note.kind, id: note.id }, sendAnyway },
    };
    return api.chat.threads.$post(start);
  },
  remove: (id: string) => api.chat.threads[":id"].$delete({ param: { id } }),
  // "Ask the AI" on an Alert. The route takes only JSON, and reads no body: the server reads the
  // Alert from its ID.
  askAboutAlert: (id: string) => {
    const press = { param: { id }, json: {} };
    return api.alerts[":id"]["ask-ai"].$post(press);
  },
};

export async function loadChat(): Promise<{
  status: ChatStatusView;
  threads: ChatThreadItemView[];
}> {
  const res = await chatRequests.list();
  if (!res.ok) throw new Error(`The Chat request answered ${res.status}.`);
  return (await res.json()) as { status: ChatStatusView; threads: ChatThreadItemView[] };
}

export async function loadThread(id: string): Promise<ChatThreadView | undefined> {
  const res: Response = await chatRequests.thread(id);
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`The Chat thread's request answered ${res.status}.`);
  return (await res.json()) as ChatThreadView;
}

// A problem's words, whether it asks "Send anyway?", and whether the route refused the message
// before storing it, so the page puts it back in the input.
export type ChatProblem = { error: string; sendAnyway: boolean; notStored: boolean };

// A route's refusal, a JSON body, or a failed answer's words from its stream, such as useChat's
// error message holds, as a problem.
export function problemOf(body: string): ChatProblem {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; pause?: unknown };
    if (typeof parsed.error === "string") {
      return { error: parsed.error, sendAnyway: parsed.pause === "send anyway?", notStored: true };
    }
  } catch {
    // Not JSON: the stream's own words, such as a failed answer's.
  }
  return {
    error: body === "" ? "That did not work." : body,
    sendAnyway: body.endsWith(SEND_ANYWAY),
    notStored: false,
  };
}

// A new thread with its first message: its ID, or why not.
export async function startThread(
  text: string,
  note: AskAbout | null,
  sendAnyway: boolean,
): Promise<{ threadId: string } | ChatProblem> {
  let res: Response;
  try {
    res = await chatRequests.start(text, note, sendAnyway);
  } catch {
    return { error: "The server did not answer.", sendAnyway: false, notStored: true };
  }
  if (res.ok) return (await res.json()) as { threadId: string };
  return problemOf(await res.text());
}

// "Ask the AI" on an Alert (spec 06, "Ask the AI"): the Member's thread about it, or the words for
// why it did not start, such as "Set up an AI provider in Settings, AI, to use Chat."
export async function askAiAbout(
  alertId: string,
): Promise<{ threadId: string } | { error: string }> {
  let res: Response;
  try {
    res = await chatRequests.askAboutAlert(alertId);
  } catch {
    return { error: "The server did not answer." };
  }
  const body = (await res.json().catch(() => ({}))) as { threadId?: unknown; error?: unknown };
  if (res.ok && typeof body.threadId === "string") return { threadId: body.threadId };
  return { error: typeof body.error === "string" ? body.error : "That did not work." };
}

// The words of a refusal, or undefined when it worked.
export async function deleteThread(id: string): Promise<string | undefined> {
  let res: Response;
  try {
    res = await chatRequests.remove(id);
  } catch {
    return "The server did not answer.";
  }
  if (res.ok) return undefined;
  return problemOf(await res.text()).error;
}
