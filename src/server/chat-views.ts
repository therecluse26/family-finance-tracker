// What the Chat routes answer (spec 08, Chat; spec 07, Chat page). This file imports only other
// view files, so the web app's type check can follow it through api.ts.
import type { ProposalView } from "./proposals-views.ts";

// Whether Chat can answer now, or why not. "send anyway?" is the AI cost cap: Chat asks before
// each message.
export type ChatStatusView =
  | "ready"
  | "send anyway?"
  | "waits for history"
  | "no AI provider"
  | "key rejected"
  | "cost cap"
  | "no price";

export type ChatThreadItemView = {
  id: string;
  title: string;
  // As ISO 8601 text in UTC.
  lastMessageAt: string;
};

export type ChatMessageView = {
  id: string;
  author: "Member" | "AI";
  // A Member's name, or "AI".
  name: string;
  text: string;
  createdAt: string;
};

// The note a thread started from with "Ask about this".
export type ChatNoteKindView = "Alert note" | "Proposal";
export type ChatNoteView = { kind: ChatNoteKindView; title: string; lines: string[] };

// A Proposal the thread's AI made: its card, the answer it came with (null when that answer
// failed), and its status. An open one shows Accept, Edit, and Skip.
export type ChatProposalView = ProposalView & {
  answerId: string | null;
  status: "open" | "accepted" | "skipped" | "replaced" | "expired";
};

export type ChatThreadView = {
  id: string;
  title: string;
  note: ChatNoteView | null;
  messages: ChatMessageView[];
  // The message with "Messages above this line are no longer sent to the AI." above it, or null.
  firstSent: string | null;
  answering: boolean;
  proposals: ChatProposalView[];
  // The signed-in Member's name, which the page shows above a new question while it is answered.
  you: string;
};

// Why a message did not go, with nothing stored, as the route's status and words.
export type ChatRefusalView = { status: 400 | 404 | 409 | 429; error: string; pause?: string };

export type ChatRoutes = {
  status(): Promise<ChatStatusView>;
  threads(): Promise<ChatThreadItemView[]>;
  thread(member: { id: string; name: string }, id: string): Promise<ChatThreadView | undefined>;
  start(
    member: { id: string; name: string },
    input: {
      text: string;
      note: { kind: ChatNoteKindView; id: string } | null;
      sendAnyway: boolean;
    },
  ): Promise<{ threadId: string } | ChatRefusalView>;
  // The answer, streamed as @ai-sdk/react reads it.
  answer(
    member: { id: string; name: string },
    threadId: string,
    input: { text: string | null; sendAnyway: boolean },
  ): Promise<Response | ChatRefusalView>;
  remove(id: string): Promise<boolean>;
};
