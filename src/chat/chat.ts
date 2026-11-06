import type {
  AiCall,
  AiMessage,
  AiPause,
  HouseholdAi,
  StreamEnd,
  SummaryPart,
} from "../ai/index.ts";
import {
  type ChatMessageRow,
  type Database,
  deleteChatThread,
  listChatMessages,
  listChatThreads,
  readChatThread,
  storeAlertThread,
  storeChatMessage,
  storeChatThread,
} from "../db/index.ts";
import { log } from "../log.ts";
import { type ChatProposal, chatProposals } from "../proposals/index.ts";
import { lookupTools } from "./lookup-tools.ts";
import {
  type ChatNoteView,
  listedAlert,
  type NoteKind,
  noteParts,
  readNote,
  storedNote,
} from "./note.ts";
import { proposalTools } from "./proposal-tools.ts";

// Chat (spec 08, Chat; spec 07, Chat page): shared threads, each answer streamed from its route as
// the AI writes it. Every Member sees every thread, with who wrote each message, and any Member
// can continue or delete any thread.

// The turns each call sends in full: one message each, from a Member or the AI.
export const CHAT_TURNS = 10;
// A thread's title is its first Member message, cut to this many characters.
export const TITLE_LENGTH = 60;
// The longest message a Member may send.
export const MESSAGE_LENGTH = 4_000;
// The most answers one Member may start in an hour, over every thread, so a stuck key or a loop in
// a page cannot run up the AI bill before the AI cost cap stops it.
export const ANSWERS_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

export const DROPPED_LINE = "Messages above this line are no longer sent to the AI.";

// Chat's instructions, after the Household summary. The fixed rules go before the summary.
export const CHAT_TASK = [
  "You answer a Household Member's question about the Household's money in Chat, from the Household summary, any attached note, the lookup tools, and the conversation that follows.",
  "Answer in the first sentence. Then give the supporting numbers in short paragraphs or a short list. Bold only key numbers.",
  "You may make at most 5 tool calls for one question, lookups and Proposals together. Then answer with what you have.",
  "To suggest a change to a Budget or a new Goal, use a Proposal tool: at most 2 in one answer, and one Category in each Budget change. Nothing changes until a Member accepts it.",
  "After a Proposal tool answers shown, mention the Proposal in one sentence. After it answers an error, do not try the same Proposal again: explain in one sentence.",
].join("\n");

export type ChatMember = { id: string; name: string };

export type ChatOptions = {
  database: Database;
  ai: Pick<
    HouseholdAi,
    "stream" | "pauseFor" | "forScreen" | "forScreenAll" | "accountLabels" | "toolResult"
  >;
  // The Household summary every Writer use reads today, as parts (src/summary).
  summary: { today(): Promise<{ parts: readonly SummaryPart[] }> };
  now?: () => Date;
};

export type ChatThreadItem = { id: string; title: string; lastMessageAt: Date };

export type ChatMessage = {
  id: string;
  author: "Member" | "AI";
  // A Member's name, or "AI". A removed Member's messages keep the name they had.
  name: string;
  text: string;
  createdAt: Date;
};

export type ChatThread = {
  id: string;
  title: string;
  note: ChatNoteView | null;
  messages: ChatMessage[];
  // The first message the next call sends, with the dropped-turns line above it, or null when the
  // next call sends every message.
  firstSent: string | null;
  // Whether an answer is streaming in the thread now.
  answering: boolean;
  proposals: ChatProposal[];
};

// Why a message or an answer did not start. Nothing was stored.
export type ChatRefusal =
  | {
      refused:
        | "not found"
        | "note gone"
        | "no alert"
        | "busy"
        | "rate cap"
        | "nothing to answer"
        | "empty";
    }
  | { refused: "paused"; pause: AiPause };

// A note from the AI box, by its kind and ID.
export type NoteRef = { kind: Exclude<NoteKind, "Alert">; id: string };

export type Chat = {
  // Why Chat would pause now, such as "waits for history" or "send anyway?", or undefined.
  pause(): Promise<AiPause | undefined>;
  threads(): Promise<ChatThreadItem[]>;
  thread(id: string): Promise<ChatThread | undefined>;
  // A new thread with its first message, and an attached note. Its answer comes from answer().
  start(
    member: ChatMember,
    input: { text: string; note: NoteRef | null; sendAnyway: boolean },
  ): Promise<{ threadId: string } | ChatRefusal>;
  // "Ask the AI" on an Alert in the Alert list (spec 06, "Ask the AI"): the Member's thread about
  // the Alert with this ID, with the Alert attached and no message yet. `started` is false when the
  // Member's thread for it was already there. It makes no AI call: the Member's first question
  // goes through answer().
  askAboutAlert(
    member: ChatMember,
    alertId: string,
  ): Promise<{ threadId: string; started: boolean } | ChatRefusal>;
  // The answer to a new message, or with text null, to the thread's last message when it is a
  // Member's with no answer: "Try again", "Send anyway", or a new thread's first answer.
  answer(
    member: ChatMember,
    threadId: string,
    input: { text: string | null; sendAnyway: boolean },
  ): Promise<Response | ChatRefusal>;
  remove(id: string): Promise<boolean>;
};

// Every control character but the line break, and the line and paragraph separators.
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters it replaces.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/gu;

// A Member's message as stored: well-formed, with a space for each control character but the line
// break, and no space at either end.
const memberText = (text: string) => text.toWellFormed().replace(CONTROL, " ").trim();

// The thread's title: its first Member message on one line, cut to 60 characters.
export const titleOf = (text: string) =>
  Array.from(memberText(text).replace(/\s+/gu, " ")).slice(0, TITLE_LENGTH).join("").trim();

// A thread "Ask the AI" started: "About: " and the Alert's short title, cut the same way.
export const alertThreadTitle = (alertTitle: string) => titleOf(`About: ${alertTitle}`);

// Where the turns the next call sends start in a thread of `count` messages. A thread whose last
// message is a Member's with no answer sends it and the 9 before it; otherwise the next call sends
// the 9 latest and the new message.
export function firstSentIndex(count: number, lastIsMember: boolean): number {
  return Math.max(0, count - (lastIsMember ? CHAT_TURNS : CHAT_TURNS - 1));
}

// The words the browser shows when an answer fails, with "Try again".
function failureWords(end: Exclude<StreamEnd, { answered: string }>): string {
  if ("refused" in end) {
    return "The privacy filter stopped this question, so nothing went to the AI.";
  }
  if ("paused" in end) {
    return end.paused === "send anyway?"
      ? "Chat reached the AI cost cap. Send anyway?"
      : "AI is paused, so Chat cannot answer now.";
  }
  switch (end.failed) {
    case "timeout":
      return "The AI did not answer within 120 seconds.";
    case "rate limit":
      return "The AI provider is busy.";
    case "key rejected":
      return "The AI provider rejected the key. A Member can enter a new key in Settings, AI.";
    case "network":
      return "The app could not reach the AI provider.";
    default:
      return "The AI provider did not answer.";
  }
}

export function chat({ database, ai, summary, now = () => new Date() }: ChatOptions): Chat {
  // The threads with an answer streaming now, and each Member's answers in the last hour. Both
  // live in memory: a restart ends every answer.
  const answering = new Set<string>();
  const started = new Map<string, number[]>();
  // Each "Ask the AI" press while it runs, by the Member and the Alert ID sent, so presses at once,
  // such as a double click, share one.
  const asking = new Map<string, Promise<{ threadId: string; started: boolean } | ChatRefusal>>();

  const recent = (memberId: string, at: number) =>
    (started.get(memberId) ?? []).filter((time) => time > at - HOUR_MS);

  const viewOf = (rows: ChatMessageRow[], aiTexts: string[]): ChatMessage[] => {
    let next = 0;
    return rows.map((row) => ({
      id: row.id,
      author: row.author,
      name: row.author === "AI" ? "AI" : (row.memberName ?? "A Member"),
      text: row.author === "AI" ? (aiTexts[next++] ?? "") : row.text,
      createdAt: row.createdAt,
    }));
  };

  // A place among the Member's 20 answers this hour, taken before any wait, so answers sent
  // together over many threads cannot all pass the count. Undefined at the cap.
  function reserve(memberId: string): number | undefined {
    const at = now().getTime();
    const times = recent(memberId, at);
    if (times.length >= ANSWERS_PER_HOUR) return undefined;
    started.set(memberId, [...times, at]);
    return at;
  }

  // Gives the place back when no answer started.
  function release(memberId: string, at: number) {
    const times = started.get(memberId) ?? [];
    const index = times.indexOf(at);
    if (index >= 0) started.set(memberId, times.toSpliced(index, 1));
  }

  // The checks before a new thread is stored: the Member has an answer left this hour, and the AI
  // gate, such as the AI cost cap, says yes. Its answer takes the place.
  async function mayStart(
    member: ChatMember,
    sendAnyway: boolean,
  ): Promise<ChatRefusal | undefined> {
    if (recent(member.id, now().getTime()).length >= ANSWERS_PER_HOUR) {
      return { refused: "rate cap" };
    }
    const pause = await ai.pauseFor("chat", { sendAnyway });
    return pause === undefined ? undefined : { refused: "paused", pause };
  }

  // The call for the thread's last message, a Member's: the summary, the attached note, and the
  // last 10 turns, each marked typed.
  async function callFor(
    threadId: string,
    rows: ChatMessageRow[],
    note: unknown,
    runId: string,
  ): Promise<AiCall> {
    const turns: AiMessage[] = rows.slice(firstSentIndex(rows.length, true)).map((row) => ({
      role: row.author === "AI" ? "assistant" : "user",
      text: row.text,
      typed: true,
    }));
    const stored = storedNote(note);
    const parts = stored === undefined ? undefined : noteParts(stored);
    return {
      use: "chat",
      summary: (await summary.today()).parts,
      task: CHAT_TASK,
      ...(parts === undefined ? {} : { note: parts }),
      changes: turns,
      tools: {
        ...lookupTools({ database, ai, now }),
        ...proposalTools({ database, ai, runId: `${threadId}/${runId}`, now }),
      },
    };
  }

  // The answer to the thread's last message, a Member's. The thread is held for it: `ended` lets
  // it go once the answer ends, or this does when no answer starts.
  async function streamAnswer(
    threadId: string,
    note: unknown,
    sendAnyway: boolean,
  ): Promise<Response | ChatRefusal> {
    const rows = await listChatMessages(database, threadId);
    if (rows.at(-1)?.author !== "Member") return { refused: "nothing to answer" };
    const answerId = crypto.randomUUID();
    const streamed = await ai.stream(await callFor(threadId, rows, note, answerId), {
      sendAnyway,
      async ended(end) {
        try {
          if (!("answered" in end)) return failureWords(end);
          if (end.answered.trim() === "") return "The AI sent no answer.";
          await storeChatMessage(
            database,
            threadId,
            { author: "AI", id: answerId, text: end.answered },
            now(),
          );
          return undefined;
        } finally {
          answering.delete(threadId);
        }
      },
    });
    return streamed.ready ? streamed.response : { refused: "paused", pause: streamed.pause };
  }

  // One "Ask the AI" press. Starting the thread makes no AI call, so it starts at the AI cost cap
  // too: Chat then asks "Send anyway?" before each message. Any other pause starts nothing.
  async function askOnce(
    member: ChatMember,
    alertId: string,
  ): Promise<{ threadId: string; started: boolean } | ChatRefusal> {
    const pause = await ai.pauseFor("chat");
    if (pause !== undefined && pause !== "send anyway?") return { refused: "paused", pause };
    const listed = await listedAlert(database, ai, alertId, now());
    if (listed === undefined) return { refused: "no alert" };
    const thread = { title: alertThreadTitle(listed.note.title), note: listed.note };
    const link = { alertId: listed.alertId, memberId: member.id };
    const stored = await storeAlertThread(database, thread, link, now());
    if (stored.started) log.info("A Member started a Chat thread", { note: "Alert" });
    return stored;
  }

  return {
    pause: () => ai.pauseFor("chat"),

    async threads() {
      return (await listChatThreads(database)).map(({ id, title, lastMessageAt }) => ({
        id,
        title,
        lastMessageAt,
      }));
    },

    async thread(id) {
      const thread = await readChatThread(database, id);
      if (thread === undefined) return undefined;
      const rows = await listChatMessages(database, id);
      const aiTexts = await ai.forScreenAll(
        rows.filter((row) => row.author === "AI").map((row) => row.text),
      );
      const first = firstSentIndex(rows.length, rows.at(-1)?.author === "Member");
      const note = storedNote(thread.note);
      return {
        id,
        title: thread.title,
        note: note === undefined ? null : { kind: note.kind, title: note.title, lines: note.lines },
        messages: viewOf(rows, aiTexts),
        firstSent: first === 0 ? null : (rows[first]?.id ?? null),
        answering: answering.has(id),
        proposals: await chatProposals(database, `${id}/`, now()),
      };
    },

    async start(member, { text, note, sendAnyway }) {
      const words = memberText(text);
      if (words === "" || words.length > MESSAGE_LENGTH) return { refused: "empty" };
      const refusal = await mayStart(member, sendAnyway);
      if (refusal !== undefined) return refusal;
      const attached = note === null ? null : await readNote(database, ai, note, now());
      if (attached === undefined) return { refused: "note gone" };
      const { threadId } = await storeChatThread(
        database,
        { title: titleOf(words), note: attached },
        { author: "Member", memberId: member.id, memberName: member.name, text: words },
        now(),
      );
      log.info("A Member started a Chat thread", { note: note?.kind ?? null });
      return { threadId };
    },

    askAboutAlert(member, alertId) {
      // Taken before any wait, so a second press at once joins the first.
      const key = JSON.stringify([member.id, alertId]);
      const running = asking.get(key);
      if (running !== undefined) return running;
      const press = askOnce(member, alertId).finally(() => asking.delete(key));
      asking.set(key, press);
      return press;
    },

    async answer(member, threadId, { text, sendAnyway }) {
      const thread = await readChatThread(database, threadId);
      if (thread === undefined) return { refused: "not found" };
      const words = text === null ? null : memberText(text);
      if (words === "" || (words !== null && words.length > MESSAGE_LENGTH)) {
        return { refused: "empty" };
      }
      // A thread answers one question at a time, and each Member starts at most 20 answers an
      // hour. Both are taken here, before any wait, and given back when no answer starts.
      if (answering.has(threadId)) return { refused: "busy" };
      const place = reserve(member.id);
      if (place === undefined) return { refused: "rate cap" };
      answering.add(threadId);
      let streaming = false;
      try {
        const pause = await ai.pauseFor("chat", { sendAnyway });
        if (pause !== undefined) return { refused: "paused", pause };
        if (words !== null) {
          const stored = await storeChatMessage(
            database,
            threadId,
            { author: "Member", memberId: member.id, memberName: member.name, text: words },
            now(),
          );
          if (stored === undefined) return { refused: "not found" };
        }
        const answered = await streamAnswer(threadId, thread.note, sendAnyway);
        streaming = answered instanceof Response;
        return answered;
      } finally {
        if (!streaming) {
          answering.delete(threadId);
          release(member.id, place);
        }
      }
    },

    remove: (id) => deleteChatThread(database, id),
  };
}
