import type { AiPause } from "../ai/index.ts";
import type { Chat, ChatRefusal } from "../chat/index.ts";
import { type Database, deleteChatThread, listChatThreads } from "../db/index.ts";
import type { ChatRefusalView, ChatRoutes, ChatStatusView } from "./chat-views.ts";
import { proposalView } from "./proposals.ts";

// The Chat routes (spec 08, Chat; spec 07, Chat page). Without the chat module, as in a test app
// with no AI, Chat lists its threads and says AI is not set up.

const PAUSE_WORDS: Record<AiPause, string> = {
  "no AI provider": "Set up an AI provider in Settings, AI, to use Chat.",
  "waits for history": "Chat opens when your history has loaded.",
  "key rejected":
    "AI paused: the AI provider rejected the key. A Member can enter a new key in Settings, AI.",
  "cost cap": "AI is paused at the AI cost cap.",
  "send anyway?": "Send anyway?",
  "no price": "The AI model has no price, so Chat cannot count its cost. Choose another model.",
};

function refusalView(refusal: ChatRefusal): ChatRefusalView {
  switch (refusal.refused) {
    case "not found":
      return { status: 404, error: "No Chat thread has this ID." };
    case "note gone":
      return { status: 404, error: "This note is no longer in the AI box." };
    case "no alert":
      return { status: 404, error: "No Alert has this ID." };
    case "busy":
      return { status: 409, error: "The AI is still answering in this thread." };
    case "rate cap":
      return {
        status: 429,
        error: "You asked many questions this hour. Wait a few minutes, then send it again.",
      };
    case "nothing to answer":
      return { status: 409, error: "The last message in this thread already has an answer." };
    case "empty":
      return { status: 400, error: "Type a message of up to 4,000 characters." };
    case "paused":
      return { status: 409, error: PAUSE_WORDS[refusal.pause], pause: refusal.pause };
  }
}

const refused = <T extends object>(answer: T | ChatRefusal): answer is ChatRefusal =>
  "refused" in answer;

export function chatRoutes(database: Database, chat: Chat | undefined): ChatRoutes {
  const off = {
    status: 409 as const,
    error: PAUSE_WORDS["no AI provider"],
    pause: "no AI provider",
  };
  return {
    async status(): Promise<ChatStatusView> {
      if (chat === undefined) return "no AI provider";
      return (await chat.pause()) ?? "ready";
    },
    async threads() {
      const threads = chat === undefined ? await listChatThreads(database) : await chat.threads();
      return threads.map(({ id, title, lastMessageAt }) => ({
        id,
        title,
        lastMessageAt: lastMessageAt.toISOString(),
      }));
    },
    async thread(member, id) {
      const thread = await chat?.thread(id);
      if (thread === undefined) return undefined;
      const answers = new Set(
        thread.messages.filter((message) => message.author === "AI").map((message) => message.id),
      );
      return {
        ...thread,
        messages: thread.messages.map((message) => ({
          ...message,
          createdAt: message.createdAt.toISOString(),
        })),
        shoppingListChanges: thread.shoppingListChanges.map((change) => ({
          ...change,
          answerId: answers.has(change.answerId) ? change.answerId : null,
        })),
        proposals: thread.proposals.map(({ runId, status, ...proposal }) => {
          const answerId = runId.slice(runId.indexOf("/") + 1);
          return {
            ...proposalView(proposal),
            answerId: answers.has(answerId) ? answerId : null,
            status,
          };
        }),
        you: member.name,
      };
    },
    async start(member, input) {
      if (chat === undefined) return off;
      const started = await chat.start(member, input);
      return refused(started) ? refusalView(started) : started;
    },
    async askAboutAlert(member, alertId) {
      if (chat === undefined) return off;
      const asked = await chat.askAboutAlert(member, alertId);
      return refused(asked) ? refusalView(asked) : asked;
    },
    async answer(member, threadId, input) {
      if (chat === undefined) return off;
      const answered = await chat.answer(member, threadId, input);
      return answered instanceof Response ? answered : refusalView(answered);
    },
    remove: (id) => (chat === undefined ? deleteChatThread(database, id) : chat.remove(id)),
  };
}
