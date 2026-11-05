import { asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.ts";
import { chatMessages, chatThreads, members } from "./schema.ts";

// Chat threads and their messages in app.db (spec 08, Chat). The chat module decides; these
// functions store and read.

export type StoredChatThread = typeof chatThreads.$inferSelect;
export type ChatAuthor = (typeof chatMessages.$inferSelect)["author"];

// A message as a thread shows it. `memberName` is the Member's name now, or the name they had when
// they wrote it once they are removed. Null for the AI.
export type ChatMessageRow = {
  id: string;
  author: ChatAuthor;
  memberId: string | null;
  memberName: string | null;
  text: string;
  createdAt: Date;
};

// A new message: a Member's, with their name, or the AI's, with the ID its answer ran under.
export type NewChatMessage =
  | { author: "Member"; memberId: string; memberName: string; text: string }
  | { author: "AI"; id: string; text: string };

const messageValues = (threadId: string, message: NewChatMessage, at: Date) => ({
  id: message.author === "AI" ? message.id : crypto.randomUUID(),
  threadId,
  author: message.author,
  memberId: message.author === "Member" ? message.memberId : null,
  memberName: message.author === "Member" ? message.memberName : null,
  text: message.text,
  createdAt: at,
});

// Stores a new thread with its first Member message. Returns the thread's ID and the message's.
export async function storeChatThread(
  database: Database,
  thread: { title: string; note: Record<string, unknown> | null },
  first: NewChatMessage & { author: "Member" },
  at: Date,
): Promise<{ threadId: string; messageId: string }> {
  const threadId = crypto.randomUUID();
  const message = messageValues(threadId, first, at);
  await database.transaction(async (tx) => {
    await tx
      .insert(chatThreads)
      .values({ id: threadId, ...thread, createdAt: at, lastMessageAt: at });
    await tx.insert(chatMessages).values(message);
  });
  return { threadId, messageId: message.id };
}

// Every thread, newest first by its last message.
export async function listChatThreads(database: Database): Promise<StoredChatThread[]> {
  return database
    .select()
    .from(chatThreads)
    .orderBy(desc(chatThreads.lastMessageAt), desc(sql`rowid`));
}

export async function readChatThread(
  database: Database,
  id: string,
): Promise<StoredChatThread | undefined> {
  const [row] = await database.select().from(chatThreads).where(eq(chatThreads.id, id));
  return row;
}

// A thread's messages, oldest first.
export async function listChatMessages(
  database: Database,
  threadId: string,
): Promise<ChatMessageRow[]> {
  return database
    .select({
      id: chatMessages.id,
      author: chatMessages.author,
      memberId: chatMessages.memberId,
      memberName: sql<string | null>`coalesce(${members.name}, ${chatMessages.memberName})`,
      text: chatMessages.text,
      createdAt: chatMessages.createdAt,
    })
    .from(chatMessages)
    .leftJoin(members, eq(members.id, chatMessages.memberId))
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt), asc(sql`${chatMessages}.rowid`));
}

// Adds a message to a thread, and makes it the thread's last. Returns the message's ID, or
// undefined, with nothing stored, when no thread has the ID.
export async function storeChatMessage(
  database: Database,
  threadId: string,
  message: NewChatMessage,
  at: Date,
): Promise<string | undefined> {
  const values = messageValues(threadId, message, at);
  return database.transaction(async (tx) => {
    const moved = await tx
      .update(chatThreads)
      .set({ lastMessageAt: at })
      .where(eq(chatThreads.id, threadId))
      .returning({ id: chatThreads.id });
    if (moved.length === 0) return undefined;
    await tx.insert(chatMessages).values(values);
    return values.id;
  });
}

// Deletes a thread and its messages. False when no thread has the ID.
export async function deleteChatThread(database: Database, id: string): Promise<boolean> {
  const deleted = await database
    .delete(chatThreads)
    .where(eq(chatThreads.id, id))
    .returning({ id: chatThreads.id });
  return deleted.length === 1;
}
